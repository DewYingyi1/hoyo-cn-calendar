import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateEvent, renderCalendar } from '../lib/calendar.mjs';
import { createImageEvidenceChecker } from '../lib/image-evidence.mjs';
import { confirmedImages } from '../lib/review.mjs';

const read = async name => JSON.parse(await fs.readFile(new URL(`../data/${name}.json`, import.meta.url), 'utf8'));
const overrides = await read('overrides');
const posts = await read('posts');
const confirmations = await read('confirmations');
const audit = await read('audit');
const key = 'starrail:website:167107';
const digest = 'c9c1e07f5a5d4febf002f8cc358eae4f6b8b268c41c3183df69fd1cb9a7c2233';
const events = overrides.events.filter(e => e.id.startsWith(key + ':'));

test('167107六项福利共用明确截止，版本更新后不猜开服时刻', () => {
  assert.equal(events.length, 6);
  assert.equal(new Set(events.map(e => e.id)).size, 6);
  for (const title of ['奇缘星幕', '魔术请柬', '千星旅伴', '阿哈觉得你需要', '快递请查收', '散场也别空着手']) {
    assert.equal(events.filter(e => e.title.endsWith(title)).length, 1);
  }
  for (const e of events) {
    validateEvent(e);
    assert.equal(e.game, 'starrail');
    assert.equal(e.category, 'event');
    assert.equal(e.start, null);
    assert.equal(e.startText, '2026/11/11 4.7版本更新后');
    assert.equal(e.end, '2026-12-23T05:59:00+08:00');
    assert.equal(e.url, 'https://sr.mihoyo.com/news/167107');
    assert.match(e.displayNotes, /开拓等级≥4级/);
  }
  for (const mode of ['nodes', 'timeline']) {
    const ics = renderCalendar(events, { name: '人工审核回归', mode, now: '2026-10-31T09:00:00.000Z' });
    assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 6);
    assert.equal((ics.match(/DTSTART:20261222T215900Z/g) ?? []).length, 6);
  }
});

test('167107显式替换父项，奖励领取截止不等于商店常驻内容下架', () => {
  assert.ok(overrides.replaceParentIds.includes(key));
  assert.ok(!overrides.suppressPostIds.includes(key));
  assert.ok(!overrides.events.some(e => e.id === key));
  assert.match(events.find(e => e.id === key + ':companion').displayNotes, /不将商店新增内容标为限时下架/);
  assert.equal(events.find(e => e.id === key + ':check-in').category, 'event');
});

test('167107确认正文、完整7图列表与逐图字节并记录人工证据', () => {
  const post = posts[key];
  assert.equal(confirmations[key], digest);
  assert.equal(post.reviewedDigest, digest);
  assert.equal(post.confirmedImageBytesDigest, digest);
  assert.equal(post.confirmedImagesDigest, digest);
  assert.equal(post.imageEvidenceRequired, true);
  assert.equal(Object.keys(post.confirmedImageBytes).length, 7);
  const listHash = createHash('sha256').update(JSON.stringify(Object.keys(post.confirmedImageBytes))).digest('hex');
  assert.equal(post.confirmedImagesHash, listHash);
  assert.equal(confirmedImages(post, digest, listHash).changed, false);
  assert.equal(confirmedImages(post, digest, '0'.repeat(64)).changed, true);
  const evidence = audit.find(a => a.game === 'starrail' && a.source === 'website' && a.postId === '167107' && a.digest === digest);
  assert.ok(evidence);
  assert.deepEqual(evidence.imageBytes, post.confirmedImageBytes);
  assert.equal(evidence.imagesHash, listHash);
  assert.equal(evidence.evidenceUrls.length, 8);
});

test('167107同URL换字节仍锁定人工待审，不因正文确认解除', async () => {
  const reference = posts[key];
  const baseline = structuredClone(reference.confirmedImageBytes);
  const checker = createImageEvidenceChecker({ request: async () => new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { headers: { 'content-type': 'image/png' } }) });
  const result = await checker({ game: 'starrail', source: 'website', id: '167107', images: Object.keys(baseline) }, reference, {
    expectedDigest: digest, digest, now: '2026-10-31T09:00:00.000Z',
  });
  assert.equal(result.needsReview, true);
  assert.equal(result.bytesChanged, true);
  assert.equal(result.fields.imageEvidenceManualReview, true);
  assert.deepEqual(reference.confirmedImageBytes, baseline);
});
