import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { validateEvent, renderCalendar } from '../lib/calendar.mjs';
import { confirmedImages } from '../lib/review.mjs';
import { isHandled } from '../lib/identity.mjs';

const read = async name => JSON.parse(await fs.readFile(new URL(`../data/${name}.json`, import.meta.url), 'utf8'));
const overrides = await read('overrides');
const events = overrides.events;
const get = id => {
  const matches = events.filter(event => event.id === id);
  assert.equal(matches.length, 1, id);
  validateEvent(matches[0]);
  return matches[0];
};
const now = '2026-10-20T13:21:44.331Z';
const nodeCount = selected => (renderCalendar(selected, { name: '审核回归', now }).match(/BEGIN:VEVENT/g) ?? []).length;

test('166950只补两个返场卡池，真珠与光锥仍用原身份和未知开始', () => {
  const added = events.filter(event => event.id.startsWith('starrail:website:166950:'));
  assert.deepEqual(added.map(event => event.id).sort(), [
    'starrail:website:166950:banner-blade', 'starrail:website:166950:banner-lightcone',
  ]);
  for (const event of added) {
    validateEvent(event);
    assert.equal(event.category, 'banner');
    assert.equal(event.start, '2026-10-21T12:00:00+08:00');
    assert.equal(event.end, '2026-11-10T15:00:00+08:00');
  }
  for (const suffix of ['banner-1', 'banner-2']) {
    const old = get(`starrail:miyoushe:78448395:${suffix}`);
    assert.equal(old.start, null);
    assert.equal(old.end, '2026-11-10T15:00:00+08:00');
  }
  assert.match(get('starrail:website:166950:banner-blade').notes, /真珠、青雀、雪衣、米沙的试用为4.6版本更新后/);
  assert.equal(nodeCount(added), 4);
});

test('166971只发布总时段，不生成猜测的主题阶段', () => {
  const event = get('zzz:website:166971');
  assert.equal(event.start, '2026-10-22T10:00:00+08:00');
  assert.equal(event.end, '2026-11-30T03:59:00+08:00');
  assert.equal(events.filter(item => item.id.startsWith(event.id + ':')).length, 0);
  assert.match(event.notes, /未给各主题单独开放时刻/);
  assert.equal(nodeCount([event]), 2);
});

test('166969任务奖励与购买截止相差一小时，未知开始只生成截止节点', () => {
  const activity = get('zzz:website:166969');
  const purchase = get('zzz:website:166969:purchase');
  for (const event of [activity, purchase]) {
    assert.equal(event.start, null);
    assert.equal(event.startText, '3.3版本更新后');
  }
  assert.equal(activity.end, '2026-11-30T03:59:00+08:00');
  assert.equal(purchase.end, '2026-11-30T02:59:00+08:00');
  assert.equal(Date.parse(activity.end) - Date.parse(purchase.end), 3600000);
  assert.equal(nodeCount([activity, purchase]), 2);
  assert.equal(get('zzz:website:166012').end, '2026-10-19T03:59:00+08:00');
});

test('三篇人工结果绑定正文与图片列表，列表变化必须重新送审', async () => {
  const posts = await read('posts');
  const confirmations = await read('confirmations');
  const audit = await read('audit');
  for (const key of ['starrail:website:166950', 'zzz:website:166971', 'zzz:website:166969']) {
    const post = posts[key];
    const digest = confirmations[key];
    assert.ok(isHandled(key, overrides));
    assert.equal(digest, post.digest);
    assert.equal(post.reviewedDigest, digest);
    assert.equal(post.confirmedImagesDigest, digest);
    assert.equal(post.confirmedImagesHash, post.imagesHash);
    assert.equal(confirmedImages(post, digest, post.imagesHash).changed, false);
    assert.equal(confirmedImages(post, digest, '0'.repeat(64)).changed, true);
    const [game, source, postId] = key.split(':');
    const record = audit.find(item => item.game === game && item.source === source && item.postId === postId && item.digest === digest);
    assert.ok(record, key);
    assert.equal(record.imagesHash, post.imagesHash);
    assert.match(record.notes, /未逐图审核或确认图片字节/);
  }
});
