import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, readJson, writeJson } from './build.mjs';
import { GAMES, mergeEvents } from '../lib/calendar.mjs';
import { parsePost, postDigest, imageDigest } from '../lib/parser.mjs';
import { fetchForum, fetchWebsite } from '../lib/sources.mjs';
import { sourceKey, findCanonical, canonicalPrefix, canonicalPost, isHandled } from '../lib/identity.mjs';
import { selectSource } from '../lib/selection.mjs';
import { fetchBilibili } from '../lib/bilibili.mjs';
import { confirmedImages } from '../lib/review.mjs';

const now = new Date().toISOString();
const configs = await readJson('sources/games.json');
const bilibiliConfigs = await readJson('sources/bilibili.json', {});
const old = await readJson('data/events.json', []);
const incoming = [];
const reviewInputs = [];
const aliases = await readJson('data/aliases.json', {});
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
status.lastAttemptAt = now;
status.issues = [];
const overrides = await readJson('data/overrides.json', { events: [], suppressPostIds: [] });
const confirmed = await readJson('data/confirmations.json', {});
let successes = 0;
for (const [game, config] of Object.entries(configs)) {
  const previous = status.games[game] ?? {};
  try {
    const { result, source, primaryError } = await selectSource(game, config, { website: fetchWebsite, forum: fetchForum, websiteOnly: process.env.WEBSITE_ONLY === '1' });
    if (primaryError) status.issues.push(`${GAMES[game].short}官网不可用：${primaryError}；临时使用米游社备用源，遇验证码保留旧日程。`);
    let eligible = 0;
    for (const post of result.posts) {
      const rawKey = sourceKey(post);
      const key = findCanonical(post, registry, aliases);
      if (rawKey !== key) reviews.delete(rawKey);
      const canonical = canonicalPost(post, key);
      const digest = postDigest(post);
      const reference = registry[rawKey];
      const handled = isHandled(key, overrides);
      // Confirmation is source-specific: website HTML and forum Quill have different formatting.
      const expected = confirmed[rawKey] ?? reference?.reviewedDigest;
      const imagesHash = imageDigest(post);
      const imageConfirmation = confirmedImages(reference, expected, imagesHash);
      const changedImages = imageConfirmation.changed;
      const changed = Boolean(handled && ((expected && expected !== digest) || changedImages));
      registry[rawKey] = { title: post.title, published: post.published, url: post.url, digest, canonical: key,
        imagesHash,
        ...(handled && expected ? { confirmedImagesHash: imageConfirmation.baseline, confirmedImagesDigest: expected } : {}),
        ...(reference?.reviewedDigest ? { reviewedDigest: reference.reviewedDigest } : {}) };
      const parsed = parsePost(canonical);
      if (changed) {
        parsed.review = { game, postId: canonical.id, title: post.title, url: post.url, reason: '人工确认后当前官方来源正文已修改；既有人工日程需重新核对', digest };
        delete parsed.event; delete parsed.ignored;
      }
      if (!parsed.ignored) eligible++;
      // Only aliases explicitly mapped to reviewed official equivalents can resolve complex manual records.
      if (handled && !changed && expected) {
        reviews.delete(key);
      } else if (handled && !expected && source === 'website') {
        reviews.set(key, { game, source: canonical.source, postId: canonical.id, title: post.title, url: post.url, reason: '跨来源人工记录尚未核对官网正文；保留既有日程', digest, firstSeenAt: now, resolved: false, changedConfirmation: true });
      } else if (parsed.event) {
        incoming.push(parsed.event); reviews.delete(key);
      } else if (parsed.review) {
        const oldReview = reviews.get(key);
        reviews.set(key, { ...parsed.review, source: canonical.source, firstSeenAt: oldReview?.firstSeenAt ?? now,
          resolved: handled && !changed, changedConfirmation: changed });
      } else if (parsed.ignored) reviews.delete(key);
      if (reviews.has(key) && !reviews.get(key).resolved) reviewInputs.push({ ...post, canonical: key, digest, imagesHash });
    }
    if (process.env.LOCAL_AUDIT === '1') {
      await fs.mkdir(path.join(ROOT, 'local-private'), { recursive: true });
      await fs.writeFile(path.join(ROOT, `local-private/${game}-${source}-latest.json`), JSON.stringify(result.posts, null, 2));
    }
    successes++;
    status.games[game] = { ...previous, lastSuccessAt: now, source, primarySource: 'website', endpoint: result.endpoint ?? null, scanned: result.scanned, officialPosts: result.posts.length, eligiblePosts: eligible, earliestPublishedAt: result.posts.map(post => post.published).sort()[0], coverage: result.coverage, error: null };
    console.log(`${GAMES[game].name}：${result.posts.length} 官方公告，${eligible} 候选公告，来源 ${source}。`);
  } catch (error) {
    status.games[game] = { ...previous, primarySource: 'website', error: error.message };
    status.issues.push(`${GAMES[game].name}获取失败：${error.message}；保留旧事件。`);
    console.error(`${GAMES[game].name}来源失败：${error.message}`);
  }
}
// Bilibili is supplemental: its outage must not turn a successful website source into a failure.
status.supplemental ??= {};
for (const [game, config] of Object.entries(bilibiliConfigs)) {
  if (!configs[game]) continue;
  try {
    const result = await fetchBilibili(game, config);
    let added = 0;
    for (const post of result.posts) {
      const rawKey = sourceKey(post);
      const parsed = parsePost(post);
      const matching = parsed.event && [...old, ...incoming, ...overrides.events].filter(event => event.game === game && event.category === 'livestream' && event.start === parsed.event.start);
      if (matching?.length) {
        aliases[rawKey] = matching[0].id;
        reviews.delete(rawKey);
        registry[rawKey] = { title: post.title, published: post.published, url: post.url, digest: postDigest(post), imagesHash: imageDigest(post), canonical: matching[0].id };
        continue;
      }
      const key = findCanonical(post, registry, aliases);
      registry[rawKey] = { title: post.title, published: post.published, url: post.url, digest: postDigest(post), imagesHash: imageDigest(post), canonical: key };
      // New supplemental notices are candidates until cross-source identity/date checks are approved.
      const [, source, postId] = key.split(':');
      reviews.set(key, { game, source, postId, title: post.title, url: post.url, digest: postDigest(post), reason: 'B站官方前瞻补源：核对开播时刻和跨来源身份后发布', firstSeenAt: reviews.get(key)?.firstSeenAt ?? now, resolved: false });
      reviewInputs.push({ ...post, canonical: key, digest: postDigest(post), imagesHash: imageDigest(post) });
      added++;
    }
    status.supplemental[game] = { source: 'bilibili', lastSuccessAt: now, scanned: result.scanned, candidates: added, coverage: result.coverage, error: null };
    if (result.errors?.length) status.issues.push(`${GAMES[game].short}B站补源部分不可用；官网主源不受影响。`);
  } catch (error) {
    status.supplemental[game] = { ...status.supplemental[game], source: 'bilibili', lastAttemptAt: now, error: error.message };
    status.issues.push(`${GAMES[game].short}B站补源不可用：${error.message}；官网主源不受影响，保留已有日程。`);
  }
}
const canonicalOld = new Map();
for (const event of old) {
  const prefix = event.id.split(':').slice(0, 3).join(':');
  const id = canonicalPrefix(prefix, aliases) + event.id.slice(prefix.length);
  // During migration prefer the previously published canonical record, never create a second UID.
  if (!canonicalOld.has(id) || event.id === id) canonicalOld.set(id, { ...event, id });
}
const events = mergeEvents([...canonicalOld.values()], incoming, now);
const cutoff = Date.now() - 100 * 86400000;
const pending = [...reviews.values()].filter(review => Date.parse(review.firstSeenAt) >= cutoff);
status.reviewCount = pending.filter(item => !item.resolved).length;
status.successfulSources = successes;
await writeJson('data/events.json', events);
await writeJson('data/review.json', pending);
await writeJson('data/posts.json', registry);
await writeJson('data/aliases.json', aliases);
await writeJson('data/status.json', status);
// Full official bodies are ephemeral inputs, never committed or included in the public site.
await fs.mkdir(path.join(ROOT, 'local-private'), { recursive: true });
await fs.writeFile(path.join(ROOT, 'local-private/review-inputs.json'), JSON.stringify(reviewInputs, null, 2));
console.log(`保存 ${events.length} 自动事件，${status.reviewCount} 待审核公告；${successes}/3 个来源成功。`);
if (!successes && !old.length && !overrides.events.length) throw new Error('首次采集全部失败且没有已确认事件，拒绝发布空日历。');
