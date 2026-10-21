import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateEvent, renderCalendar } from '../lib/calendar.mjs';
import { confirmedImages } from '../lib/review.mjs';
import { isHandled } from '../lib/identity.mjs';
import { createImageEvidenceChecker } from '../lib/image-evidence.mjs';

const read = async name => JSON.parse(await fs.readFile(new URL(`../data/${name}.json`, import.meta.url), 'utf8'));
const overrides = await read('overrides');
const automatic = await read('events');
const posts = await read('posts');
const confirmations = await read('confirmations');
const audit = await read('audit');
const prefix = 'zzz:website:166989:';
const get = suffix => {
  const matches = overrides.events.filter(event => event.id === prefix + suffix);
  assert.equal(matches.length, 1, suffix);
  validateEvent(matches[0]);
  return matches[0];
};
const count = events => (renderCalendar(events, { name: '审核回归', now: '2026-10-20T13:00:00.000Z' }).match(/BEGIN:VEVENT/g) ?? []).length;

test('166989六项限时活动逐条使用官网明确起止，不套用版本截止', () => {
  const windows = [
    ['event-cyber', '2026-10-28T10:00:00+08:00', '2026-11-16T03:59:00+08:00'],
    ['event-bounty', '2026-11-04T04:00:00+08:00', '2026-11-09T03:59:00+08:00'],
    ['event-bangboo', '2026-11-11T10:00:00+08:00', '2026-12-01T03:59:00+08:00'],
    ['event-raven', '2026-11-11T10:00:00+08:00', '2026-11-30T03:59:00+08:00'],
    ['event-album', '2026-11-16T10:00:00+08:00', '2026-11-30T03:59:00+08:00'],
    ['event-data', '2026-11-25T04:00:00+08:00', '2026-11-30T03:59:00+08:00'],
  ];
  for (const [suffix, start, end] of windows) {
    const event = get(suffix);
    assert.equal(event.category, 'event');
    assert.equal(event.start, start);
    assert.equal(event.end, end);
    assert.equal(event.url, 'https://zzz.mihoyo.com/news/166989');
  }
  assert.equal(count(windows.map(([suffix]) => get(suffix))), 12);
});

test('166989单品折扣不等于下架，组合单独截止，未知开服保持null', () => {
  const singles = ['outfit-life', 'outfit-fantasy', 'outfit-severian'].map(get);
  for (const event of singles) {
    assert.equal(event.end, '2026-12-02T05:59:00+08:00');
    assert.match(event.displayNotes, /恢复1680原价，不是时装下架/);
  }
  const relative = ['outfit-life', 'outfit-fantasy', 'outfit-bundle'].map(get);
  for (const event of relative) {
    assert.equal(event.start, null);
    assert.equal(event.startText, '3.3版本更新后');
  }
  assert.equal(count(relative), 3);
  assert.equal(get('outfit-severian').start, '2026-11-11T12:00:00+08:00');
  assert.match(get('outfit-bundle').displayNotes, /组合限时售卖截止，不代表单品下架/);
  assert.match(get('outfit-bundle').displayNotes, /不可同享/);
});

test('166989预计维护结束只用于维护，不关闭永久内容或推算额外阶段', () => {
  const maintenance = get('maintenance');
  assert.equal(maintenance.category, 'maintenance');
  assert.equal(maintenance.start, '2026-10-21T06:00:00+08:00');
  assert.equal(maintenance.end, '2026-10-21T11:00:00+08:00');
  assert.match(maintenance.displayNotes, /仅为预计维护结束/);
  const added = overrides.events.filter(event => event.id.startsWith(prefix));
  assert.equal(added.length, 11);
  assert.equal(count(added), 19);
  assert.ok(!added.some(event => event.end === '2026-12-02T06:00:00+08:00'));
  assert.ok(!added.some(event => event.category !== 'maintenance' && event.start === maintenance.end));
  assert.ok(overrides.replaceParentIds.includes('zzz:website:166989'));
  const record = audit.find(item => item.game === 'zzz' && item.postId === '166989' && item.digest === confirmations['zzz:website:166989']);
  assert.match(record.notes, /永久剧情、信赖及常驻系统不设置关闭/);
  assert.match(record.notes, /无日期不推算/);
});

test('166995仅抑制重复介绍，166971、166970、166969身份及原窗口保留', () => {
  assert.ok(overrides.suppressPostIds.includes('zzz:website:166995'));
  assert.ok(!overrides.suppressPostIds.includes('zzz:website:166971'));
  assert.ok(!overrides.events.some(event => event.id === 'zzz:website:166995' || event.id.startsWith('zzz:website:166995:')));
  const original = overrides.events.find(event => event.id === 'zzz:website:166971');
  assert.equal(original.start, '2026-10-22T10:00:00+08:00');
  assert.equal(original.end, '2026-11-30T03:59:00+08:00');
  assert.equal(original.sequence, 0);
  assert.equal(count([original]), 2);
  assert.ok(!overrides.events.some(event => event.id.startsWith(original.id + ':')));
  const broadcast = automatic.find(event => event.id === 'zzz:website:166970');
  assert.equal(broadcast.start, null);
  assert.equal(broadcast.end, '2026-12-01T03:59:00+08:00');
  for (const [id, end] of [['zzz:website:166969', '2026-11-30T03:59:00+08:00'], ['zzz:website:166969:purchase', '2026-11-30T02:59:00+08:00']]) {
    const event = overrides.events.find(item => item.id === id);
    assert.equal(event.start, null);
    assert.equal(event.end, end);
  }
  assert.ok(!overrides.events.filter(event => event.id.startsWith(prefix)).some(event => /全新放送|怪奇诡屋|丽都城募/.test(event.title)));
});

test('两篇审核绑定准确正文、完整图片列表及逐图字节；列表变化重新送审', () => {
  for (const [id, size, digest] of [
    ['166995', 4, '244f0b6d2d49a406d0a83235c9f7f7aacca270d92f71e646e39ccf5fdcbd4617'],
    ['166989', 1, 'a83c7c5b036cdcc93ed59c40fe631c0e079bae73358d35c93465593501e02361'],
  ]) {
    const key = 'zzz:website:' + id;
    const post = posts[key];
    assert.ok(isHandled(key, overrides));
    assert.equal(confirmations[key], digest);
    assert.equal(post.reviewedDigest, digest);
    assert.equal(post.confirmedImagesDigest, digest);
    assert.equal(post.confirmedImageBytesDigest, digest);
    assert.equal(post.imageEvidenceRequired, true);
    assert.equal(Object.keys(post.confirmedImageBytes).length, size);
    assert.equal(createHash('sha256').update(JSON.stringify(Object.keys(post.confirmedImageBytes))).digest('hex'), post.confirmedImagesHash);
    assert.equal(confirmedImages(post, digest, post.imagesHash).changed, false);
    assert.equal(confirmedImages(post, digest, '0'.repeat(64)).changed, true);
    const record = audit.find(item => item.game === 'zzz' && item.source === 'website' && item.postId === id && item.digest === digest);
    assert.deepEqual(record.imageBytes, post.confirmedImageBytes);
    assert.equal(record.imagesHash, post.confirmedImagesHash);
    assert.equal(record.evidenceUrls.length, size + 1);
  }
});

test('本轮新建图片基线遇同URL字节变化仍阻断，不能被正文确认或抑制放行', async () => {
  for (const id of ['166995', '166989']) {
    const key = 'zzz:website:' + id;
    const reference = posts[key];
    const baseline = structuredClone(reference.confirmedImageBytes);
    const checker = createImageEvidenceChecker({ request: async () => new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), { headers: { 'content-type': 'image/png' } }) });
    const result = await checker({ game: 'zzz', source: 'website', id, images: Object.keys(baseline) }, reference, { expectedDigest: confirmations[key], digest: confirmations[key], now: '2026-10-21T12:00:00.000Z' });
    assert.equal(result.needsReview, true);
    assert.equal(result.bytesChanged, true);
    assert.equal(result.fields.imageEvidenceManualReview, true);
    assert.deepEqual(reference.confirmedImageBytes, baseline);
  }
});
