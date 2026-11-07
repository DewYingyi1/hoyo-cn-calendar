import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateEvent, calendarNodes } from '../lib/calendar.mjs';

const read = async name => JSON.parse(await fs.readFile(new URL(`../data/${name}.json`, import.meta.url), 'utf8'));
const key = 'starrail:website:167274';
const sha256 = value => createHash('sha256').update(value).digest('hex');

test('167274明确拆分勋礼奖励截止与购买截止，不推算版本更新时刻', async () => {
  const overrides = await read('overrides');
  const posts = await read('posts');
  const confirmations = await read('confirmations');
  const audit = await read('audit');
  const review = await read('review');
  const status = await read('status');
  const tasks = overrides.events.find(event => event.id === `${key}:rewards`);
  const purchase = overrides.events.find(event => event.id === `${key}:purchase`);
  assert.ok(tasks);
  assert.ok(purchase);
  for (const event of [tasks, purchase]) {
    validateEvent(event);
    assert.equal(event.game, 'starrail');
    assert.equal(event.category, 'event');
    assert.equal(event.start, null);
    assert.equal(event.startText, '2026/11/11 4.7版本更新后');
    assert.equal(event.url, 'https://sr.mihoyo.com/news/167274');
    assert.equal(calendarNodes(event).length, 1);
  }
  assert.equal(tasks.end, '2026-12-21T03:59:00+08:00');
  assert.equal(tasks.title, '4.7版本无名勋礼：任务与奖励截止');
  assert.equal(tasks.endText, '2026/12/21 03:59');
  assert.equal(purchase.end, '2026-12-21T02:59:00+08:00');
  assert.equal(purchase.title, '4.7版本无名勋礼：付费计划购买截止');
  assert.equal(purchase.endText, '2026/12/21 02:59');
  assert.equal(Date.parse(tasks.end) - Date.parse(purchase.end), 3600000);
  assert.ok(overrides.replaceParentIds.includes(key));
  assert.equal(overrides.events.filter(event => event.id === key).length, 0);
  assert.deepEqual(overrides.events.filter(event => event.url === 'https://sr.mihoyo.com/news/167274')
    .map(event => event.id).sort(), [`${key}:purchase`, `${key}:rewards`].sort());
  assert.equal(review.filter(item => !item.resolved).length, 0);
  assert.equal(status.reviewCount, 0);
  assert.equal(status.successfulSources, 3);
  assert.equal(status.partialSources, 0);
  const post = posts[key];
  assert.equal(confirmations[key], post.reviewedDigest);
  assert.equal(post.digest, confirmations[key]);
  assert.equal(post.imageEvidencePending, false);
  assert.equal(post.confirmedImagesDigest, confirmations[key]);
  assert.equal(post.observedImageBytesDigest, confirmations[key]);
  assert.equal(sha256(JSON.stringify(Object.keys(post.confirmedImageBytes))), post.confirmedImagesHash);
  assert.deepEqual(post.confirmedImageBytes, post.observedImageBytes);
  const records = audit.filter(item => item.game === 'starrail' && item.source === 'website'
    && item.postId === '167274' && item.digest === confirmations[key]
    && item.imagesHash === post.confirmedImagesHash);
  assert.ok(records.length > 0);
  for (const record of records) {
    assert.deepEqual(new Set(record.evidenceUrls), new Set([post.url, ...Object.keys(post.confirmedImageBytes)]));
    assert.deepEqual(record.imageBytes, post.confirmedImageBytes);
  }
});
