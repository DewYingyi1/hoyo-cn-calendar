import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, readJson, commitRepositoryFiles, withRepositoryLock } from './build.mjs';
import { GAMES, mergeEvents } from '../lib/calendar.mjs';
import { parsePost, postDigest, imageDigest } from '../lib/parser.mjs';
import { fetchWebsite, publicSourceError } from '../lib/sources.mjs';
import { sourceKey, findCanonical, canonicalPrefix, canonicalPost, isHandled, preserveProvenance } from '../lib/identity.mjs';
import { selectSource } from '../lib/selection.mjs';
import { confirmedImages } from '../lib/review.mjs';
import { updateReview, retainReviews } from '../lib/review-state.mjs';
import { createImageEvidenceChecker } from '../lib/image-evidence.mjs';

await withRepositoryLock(async () => {
const now = new Date().toISOString();
const configs = await readJson('sources/games.json');
const old = await readJson('data/events.json', []);
const incoming = [];
const reviewInputs = [];
const aliases = await readJson('data/aliases.json', {});
// Only aliases confirmed before this run may rewrite already-published event IDs.
// A newly inferred alias is committed only after all evidence gates pass.
const confirmedAliases = structuredClone(aliases);
const registry = await readJson('data/posts.json', {});
const reviews = new Map();
for (const item of await readJson('data/review.json', [])) {
  const raw = `${item.game}:${item.source ?? 'miyoushe'}:${item.postId}`;
  const key = canonicalPrefix(raw, aliases);
  const [, source, id] = key.split(':');
  // An obsolete "all website events require review" result is re-evaluated below.
  if (/官网备用源：须检查/.test(item.reason)) continue;
  reviews.set(key, { ...item, source, postId: id });
}
const status = await readJson('data/status.json', { games: {} });
delete status.supplemental;
status.lastAttemptAt = now;
status.issues = [];
const overrides = await readJson('data/overrides.json', { events: [], suppressPostIds: [] });
const confirmed = await readJson('data/confirmations.json', {});
let successes = 0;
let partialSources = 0;
const checkImageEvidence = createImageEvidenceChecker();
for (const [game, config] of Object.entries(configs)) {
  const previous = status.games[game] ?? {};
  try {
    const { result, source } = await selectSource(game, config, { website: fetchWebsite });
    const qualityIssues = result.qualityIssues ?? [];
    const imageIssues = [];
    for (const issue of qualityIssues) {
      status.issues.push(`${GAMES[game].name}官网记录${issue.postId ?? `第${issue.index + 1}条`}隔离：${issue.reason}；保留对应旧事件。`);
    }
    let eligible = 0;
    for (const post of result.posts) {
      const rawKey = sourceKey(post);
      const candidateAliases = structuredClone(aliases);
      const candidateKey = findCanonical(post, registry, candidateAliases);
      const existingKey = canonicalPrefix(rawKey, aliases);
      const inferredAlias = candidateKey !== existingKey;
      const digest = postDigest(post);
      const reference = registry[rawKey];
      // A duplicate/raw source may be suppressed without suppressing its canonical
      // published event. Check both identities so an image-only introduction can be
      // resolved while the verified schedule remains active under its stable UID.
      const candidateHandled = isHandled(candidateKey, overrides) || isHandled(rawKey, overrides);
      // Confirmation is source-specific: website HTML and forum Quill have different formatting.
      const expected = confirmed[rawKey] ?? reference?.reviewedDigest;
      const imagesHash = imageDigest(post);
      const imageConfirmation = confirmedImages(reference, expected, imagesHash);
      const byteEvidence = await checkImageEvidence(post, reference, { expectedDigest: expected, digest, now });
      if (byteEvidence.failure) {
        const issue = `${GAMES[game].name}图片字节检查失败（公告${/^\d+$/.test(post.id) ? post.id : 'ID不可用'}）：${byteEvidence.failure}；保留旧日程及人工基线。`;
        imageIssues.push(issue);
        status.issues.push(issue);
      }
      const changedImages = imageConfirmation.changed;
      // A source-specific human confirmation protects that source even when its event
      // was parsed automatically rather than supplied by an override. Image-list
      // confirmation remains relevant only to manually handled/image evidence posts.
      const changed = Boolean((expected && expected !== digest) || (candidateHandled && changedImages) || byteEvidence.needsReview);
      // A title/time match is only a candidate identity. It cannot rewrite a published
      // event until the current source digest (and, where required, image bytes) has
      // been approved by a maintainer.
      const aliasApproved = !inferredAlias || (expected === digest && !changed);
      const key = aliasApproved ? candidateKey : existingKey;
      const aliasPending = inferredAlias && !aliasApproved;
      if (inferredAlias && aliasApproved) aliases[rawKey] = candidateAliases[rawKey];
      const handled = isHandled(key, overrides) || isHandled(rawKey, overrides);
      if (rawKey !== key) reviews.delete(rawKey);
      const canonical = canonicalPost(post, key);
      registry[rawKey] = { ...reference, title: post.title, published: post.published, url: post.url, digest, canonical: key,
        imagesHash,
        ...(handled && expected ? { confirmedImagesHash: imageConfirmation.baseline, confirmedImagesDigest: expected } : {}),
        ...(reference?.reviewedDigest ? { reviewedDigest: reference.reviewedDigest } : {}),
        ...byteEvidence.fields };
      const parsed = parsePost(canonical);
      if (aliasPending) {
        parsed.review = { game, postId: canonical.id, title: post.title, url: post.url,
          reason: changed ? '跨来源身份候选的当前正文或图片证据尚未确认；保留既有身份与日程' : '跨来源身份候选尚未人工确认；保留既有身份与日程', digest };
        delete parsed.event; delete parsed.ignored;
      }
      if (changed) {
        parsed.review = { game, postId: canonical.id, title: post.title, url: post.url,
          reason: byteEvidence.needsReview ? `${byteEvidence.reason}；保留既有日程` : '人工确认后当前官方来源正文已修改；既有人工日程需重新核对', digest };
        delete parsed.event; delete parsed.ignored;
      }
      if (byteEvidence.needsReview && !byteEvidence.failure) {
        const issue = `${GAMES[game].name}图片证据阻断（公告${/^\d+$/.test(post.id) ? post.id : 'ID不可用'}）：${byteEvidence.reason}；保留旧日程。`;
        imageIssues.push(issue);
        status.issues.push(issue);
      }
      if (!parsed.ignored) eligible++;
      // Only aliases explicitly mapped to reviewed official equivalents can resolve complex manual records.
      if (!changed && expected === digest) {
        // Confirmation is source-specific and bound to this exact current digest.
        // It can close a review even when the accepted result is “keep the existing
        // automatically parsed event” rather than a manual override/suppression.
        reviews.delete(key);
      } else if (handled && !expected && source === 'website' && !changed) {
        reviews.set(key, { game, source: canonical.source, postId: canonical.id, title: post.title, url: post.url, reason: '跨来源人工记录尚未核对官网正文；保留既有日程', digest, firstSeenAt: now, resolved: false, changedConfirmation: true });
      } else {
        if (parsed.event) incoming.push(parsed.event);
        updateReview(reviews, key, parsed, { source: canonical.source, now, handled, changed });
      }
      if (reviews.has(key) && !reviews.get(key).resolved) reviewInputs.push({ ...post, canonical: key, digest, imagesHash, ...byteEvidence.fields });
    }
    if (process.env.LOCAL_AUDIT === '1') {
      await fs.mkdir(path.join(ROOT, 'local-private'), { recursive: true });
      await fs.writeFile(path.join(ROOT, `local-private/${game}-${source}-latest.json`), JSON.stringify(result.posts, null, 2));
    }
    const partial = qualityIssues.length > 0 || imageIssues.length > 0;
    successes++;
    if (partial) partialSources++;
    status.games[game] = { ...previous, lastSuccessAt: now, source, primarySource: 'website', endpoint: result.endpoint ?? null, scanned: result.scanned,
      officialPosts: result.posts.length, filteredPosts: result.filtered ?? 0, eligiblePosts: eligible, earliestPublishedAt: result.posts.map(post => post.published).sort()[0] ?? null,
      coverage: result.coverage, qualityIssues, imageEvidenceIssues: imageIssues, partial, error: partial ? '部分公告隔离或图片字节检查失败；保留对应旧事件' : null };
    console.log(`${GAMES[game].name}：${result.posts.length} 官方公告，${eligible} 候选公告，来源 ${source}${partial ? '（部分成功，详见status.issues）' : ''}。`);
  } catch (error) {
    const safeError = publicSourceError(error);
    status.games[game] = { ...previous, primarySource: 'website', error: safeError };
    status.issues.push(`${GAMES[game].name}获取失败：${safeError}；保留旧事件。`);
    console.error(`${GAMES[game].name}来源失败：${safeError}`);
  }
}
const canonicalOld = new Map();
for (const event of old) {
  const prefix = event.id.split(':').slice(0, 3).join(':');
  const id = canonicalPrefix(prefix, confirmedAliases) + event.id.slice(prefix.length);
  // During migration prefer the previously published canonical record, never create a second UID.
  if (!canonicalOld.has(id) || event.id === id) canonicalOld.set(id, { ...event, id });
}
// Keep published historical provenance as well as the canonical UID; current website
// evidence is recorded separately in the website registry and review inputs.
const events = mergeEvents([...canonicalOld.values()], incoming.map(event => preserveProvenance(event, canonicalOld.get(event.id))), now);
const pending = retainReviews(reviews.values(), now);
status.reviewCount = pending.filter(item => !item.resolved).length;
status.successfulSources = successes;
status.partialSources = partialSources;
status.completeSources = successes - partialSources;
if (!successes && !old.length && !overrides.events.length) throw new Error('首次采集全部失败且没有已确认事件，拒绝发布空日历。');
await commitRepositoryFiles(new Map([
  ['data/events.json', JSON.stringify(events, null, 2) + '\n'],
  ['data/review.json', JSON.stringify(pending, null, 2) + '\n'],
  ['data/posts.json', JSON.stringify(registry, null, 2) + '\n'],
  ['data/aliases.json', JSON.stringify(aliases, null, 2) + '\n'],
  ['data/status.json', JSON.stringify(status, null, 2) + '\n'],
  // Full official bodies are ephemeral inputs, never committed by Git or included
  // in the public site, but their write participates in the same rollback boundary.
  ['local-private/review-inputs.json', JSON.stringify(reviewInputs, null, 2) + '\n'],
]));
console.log(`保存 ${events.length} 自动事件，${status.reviewCount} 待审核公告；${successes}/${Object.keys(GAMES).length} 个来源可用，其中 ${partialSources} 个部分成功。`);
});
