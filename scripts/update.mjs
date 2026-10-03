import fs from 'node:fs/promises';
import path from 'node:path';
import { ROOT, readJson, writeJson } from './build.mjs';
import { GAMES, mergeEvents } from '../lib/calendar.mjs';
import { parsePost, classify, postDigest } from '../lib/parser.mjs';
import { fetchForum, fetchWebsite } from '../lib/sources.mjs';

const now = new Date().toISOString();
const configs = await readJson('sources/games.json');
const old = await readJson('data/events.json', []);
const incoming = [];
const reviews = new Map((await readJson('data/review.json', [])).map(item => [`${item.game}:${item.source ?? 'miyoushe'}:${item.postId}`, item]));
const status = await readJson('data/status.json', { games: {} });
status.lastAttemptAt = now;
status.issues = [];
const overrides = await readJson('data/overrides.json', { events: [], suppressPostIds: [] });
const confirmed = await readJson('data/confirmations.json', {});
let successes = 0;
for (const [game, config] of Object.entries(configs)) {
  const previous = status.games[game] ?? {};
  try {
    let result, source = 'miyoushe', primaryError;
    try { result = await fetchForum(game, config); }
    catch (error) { primaryError = error.message; source = 'website'; result = await fetchWebsite(game, config); }
    if (primaryError) status.issues.push(`${GAMES[game].short}米游社不可用：${primaryError}；本轮使用官网备用来源，可能进入审核而非自动重复收录。`);
    let eligible = 0;
    for (const post of result.posts) {
      const key = `${game}:${post.source}:${post.id}`;
      const parsed = parsePost(post);
      const digest = postDigest(post);
      const changedConfirmation = confirmed[key] && confirmed[key] !== digest;
      if (changedConfirmation) {
        parsed.review = { game, postId: post.id, title: post.title, url: post.url, reason: '人工确认后官方正文已修改；既有人工日程需重新核对', digest };
        delete parsed.event;
        delete parsed.ignored;
      }
      if (!parsed.ignored) eligible++;
      // Website fallback can rediscover the same event under a different ID. Require review to avoid duplicating feeds.
      if (parsed.event && source === 'website') {
        parsed.review = { game, postId: post.id, title: post.title, url: post.url, reason: '官网备用源：须检查是否已由米游社收录，避免重复', digest: '' };
        delete parsed.event;
      }
      if (parsed.event) { incoming.push(parsed.event); reviews.delete(key); }
      if (parsed.review) {
        const oldReview = reviews.get(key);
        const eventPrefix = `${game}:${post.source}:${post.id}`;
        const resolved = !changedConfirmation && (overrides.events.some(event => event.id === eventPrefix || event.id.startsWith(eventPrefix + ':')) || overrides.suppressPostIds.includes(post.id) || overrides.suppressPostIds.includes(eventPrefix));
        reviews.set(key, { ...parsed.review, source: post.source, firstSeenAt: oldReview?.firstSeenAt ?? now, resolved, changedConfirmation: Boolean(changedConfirmation) });
      }
      if (parsed.ignored) reviews.delete(key);
    }
    if (process.env.LOCAL_AUDIT === '1') {
      await fs.mkdir(path.join(ROOT, 'local-private'), { recursive: true });
      await fs.writeFile(path.join(ROOT, `local-private/${game}-posts.json`), JSON.stringify(result.posts.filter(post => classify(post.title, post.text)), null, 2));
    }
    successes++;
    status.games[game] = { ...previous, lastSuccessAt: now, source, scanned: result.scanned, officialPosts: result.posts.length, eligiblePosts: eligible, earliestPublishedAt: result.posts.map(post => post.published).sort()[0], coverage: result.coverage, error: null };
    console.log(`${GAMES[game].name}：${result.posts.length} 官方公告，${eligible} 候选公告，来源 ${source}。`);
  } catch (error) {
    status.games[game] = { ...previous, error: error.message };
    status.issues.push(`${GAMES[game].name}获取失败：${error.message}；保留旧事件。`);
    console.error(`${GAMES[game].name}来源失败：${error.message}`);
  }
}
const events = mergeEvents(old, incoming, now);
for (const review of reviews.values()) {
  const prefix = `${review.game}:${review.source ?? 'miyoushe'}:${review.postId}`;
  review.resolved = !review.changedConfirmation && (overrides.events.some(event => event.id === prefix || event.id.startsWith(prefix + ':')) || overrides.suppressPostIds.includes(review.postId) || overrides.suppressPostIds.includes(prefix));
}
const cutoff = Date.now() - 100 * 86400000;
const pending = [...reviews.values()].filter(review => Date.parse(review.firstSeenAt) >= cutoff);
status.reviewCount = pending.filter(item => !item.resolved).length;
status.successfulSources = successes;
await writeJson('data/events.json', events);
await writeJson('data/review.json', pending);
await writeJson('data/status.json', status);
console.log(`保存 ${events.length} 自动事件，${status.reviewCount} 待审核公告；${successes}/3 个来源成功。`);
if (!successes && !old.length && !overrides.events.length) throw new Error('首次采集全部失败且没有已确认事件，拒绝发布空日历。');
