import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validateEvent, renderCalendar } from '../lib/calendar.mjs';
import { isHandled } from '../lib/identity.mjs';
import { parsePost } from '../lib/parser.mjs';
import { createImageEvidenceChecker, approveImageEvidence } from '../lib/image-evidence.mjs';

const read = async name => JSON.parse(await fs.readFile(new URL(`../data/${name}.json`, import.meta.url), 'utf8'));
const overrides = await read('overrides');
const posts = await read('posts');
const confirmations = await read('confirmations');
const audit = await read('audit');
const key = id => `genshin:website:${id}`;
const expectedIds = [
  'genshin:website:167161', 'genshin:website:167162', 'genshin:website:167163', 'genshin:website:167159',
  'genshin:website:167173:archon-reward', 'genshin:website:167173:exploration-reward',
  'genshin:website:167173:abyssal-war', 'genshin:website:167173:abyssal-war-outburst', 'genshin:website:167173:music-reward',
  'genshin:website:167173:battle-pass', 'genshin:website:167173:battle-pass-purchase',
];

test('八项原神历史审核证据与当前人工基线完整，允许后续官方修改进入待审', () => {
  const ids = ['167154', '167173', '167168', '167167', '167163', '167162', '167161', '167159'];
  for (const id of ids) {
    const rawKey = key(id);
    const post = posts[rawKey];
    assert.ok(post, rawKey);
    // Historical acceptance is immutable; the live observation and confirmation
    // may legitimately move forward after a later official edit and human review.
    const original = audit.filter(item => item.game === 'genshin' && item.source === 'website'
      && item.postId === id && item.checkedAt === '2026-11-02T21:40:06.081Z');
    assert.equal(original.length, 1, rawKey);
    assert.equal(createHash('sha256').update(JSON.stringify(Object.keys(original[0].imageBytes))).digest('hex'), original[0].imagesHash);
    assert.equal(new Set(original[0].evidenceUrls).size, Object.keys(original[0].imageBytes).length + 1);
    assert.deepEqual(new Set(original[0].evidenceUrls), new Set([post.url, ...Object.keys(original[0].imageBytes)]));
    assert.equal(confirmations[rawKey], post.reviewedDigest, rawKey);
    assert.equal(post.confirmedImagesDigest, confirmations[rawKey]);
    assert.equal(post.confirmedImageBytesDigest, confirmations[rawKey]);
    assert.equal(post.imageEvidenceRequired, true);
    assert.equal(createHash('sha256').update(JSON.stringify(Object.keys(post.confirmedImageBytes))).digest('hex'), post.confirmedImagesHash);
    if (!post.imageEvidencePending) {
      assert.equal(post.digest, confirmations[rawKey], rawKey);
      assert.equal(post.imagesHash, post.confirmedImagesHash, rawKey);
      assert.equal(post.observedImageBytesDigest, confirmations[rawKey], rawKey);
      assert.deepEqual(post.observedImageBytes, post.confirmedImageBytes, rawKey);
      assert.equal(createHash('sha256').update(JSON.stringify(Object.keys(post.observedImageBytes))).digest('hex'), post.imagesHash, rawKey);
      assert.notEqual(post.imageEvidenceManualReview, true, rawKey);
      assert.equal(post.imageEvidenceError, null, rawKey);
    } else {
      assert.ok(post.digest !== confirmations[rawKey] || post.imagesHash !== post.confirmedImagesHash
        || post.imageEvidenceManualReview === true || post.imageEvidenceError,
      `${rawKey}: pending must retain a change, manual lock or failure reason`);
    }
    // One body digest may have multiple legitimate image-only revisions. Match
    // the current byte baseline, not just the body, without erasing old audits.
    const records = audit.filter(item => item.game === 'genshin' && item.source === 'website' && item.postId === id
      && item.digest === confirmations[rawKey] && item.imagesHash === post.confirmedImagesHash
      && Object.entries(post.confirmedImageBytes).every(([url, hash]) => item.imageBytes?.[url] === hash)
      && Object.keys(item.imageBytes ?? {}).length === Object.keys(post.confirmedImageBytes).length);
    assert.ok(records.length >= 1, rawKey);
    assert.deepEqual(records[0].imageBytes, post.confirmedImageBytes);
    assert.equal(records[0].imagesHash, post.confirmedImagesHash);
    for (const record of records) {
      assert.deepEqual(new Set(record.evidenceUrls), new Set([post.url, ...Object.keys(post.confirmedImageBytes)]), rawKey);
    }
  }
});

test('合成正文、图片列表或字节变化保留旧基线，回滚与网络故障不清锁，显式审核后才解除', async () => {
  const hash = value => createHash('sha256').update(value).digest('hex');
  const url = 'https://fastcdn.mihoyo.com/manual-review-fixture.png';
  const newUrl = 'https://fastcdn.mihoyo.com/manual-review-fixture-new.png';
  const bytes = Buffer.from('synthetic image evidence');
  const oldDigest = hash('reviewed body');
  const oldBytes = { [url]: hash(bytes) };
  const baseline = { imageEvidenceRequired: true, digest: oldDigest, reviewedDigest: oldDigest,
    imagesHash: hash(JSON.stringify([url])), confirmedImagesHash: hash(JSON.stringify([url])),
    confirmedImagesDigest: oldDigest, confirmedImageBytes: oldBytes, confirmedImageBytesDigest: oldDigest,
    imageEvidencePending: false, imageEvidenceManualReview: false };
  for (const kind of ['body', 'image-list', 'image-bytes']) {
    const digest = kind === 'body' ? hash('edited official body') : oldDigest;
    const images = kind === 'image-list' ? [newUrl] : [url];
    const observedBytes = kind === 'image-bytes' ? Buffer.from('edited synthetic image evidence') : bytes;
    const checker = createImageEvidenceChecker({ request: async () => new Response(observedBytes, { headers: { 'content-type': 'image/png' } }) });
    const post = { images };
    const result = await checker(post, baseline, { expectedDigest: oldDigest, digest, now: '2026-11-05T00:00:00Z' });
    assert.equal(result.needsReview, true, kind);
    assert.equal(result.fields.imageEvidencePending, true, kind);
    assert.equal(result.fields.imageEvidenceManualReview, true, kind);
    assert.deepEqual(baseline.confirmedImageBytes, oldBytes);
    const changed = { ...baseline, ...result.fields, digest, imagesHash: hash(JSON.stringify(images)) };
    // Even a later identical observation cannot clear a genuine manual lock.
    const again = await checker(post, changed, { expectedDigest: oldDigest, digest, now: '2026-11-05T00:01:00Z' });
    assert.equal(again.needsReview, true, kind);
    const failed = await createImageEvidenceChecker({ attempts: 1, request: async () => { throw new TypeError('synthetic network failure'); } })(post, changed,
      { expectedDigest: oldDigest, digest, now: '2026-11-05T00:01:10Z' });
    assert.equal(failed.fields.imageEvidenceManualReview, true, kind);
    const rollbackChecker = createImageEvidenceChecker({ request: async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }) });
    const rollback = await rollbackChecker({ images: [url] }, { ...changed, ...failed.fields },
      { expectedDigest: oldDigest, digest: oldDigest, now: '2026-11-05T00:01:20Z' });
    assert.equal(rollback.needsReview, true, kind);
    assert.equal(rollback.fields.imageEvidenceManualReview, true, kind);
    if (kind === 'body') assert.throws(() => approveImageEvidence(changed, oldDigest), /image-approval-digest/);
    const approved = approveImageEvidence(changed, digest);
    assert.equal(approved.imageEvidencePending, false);
    const after = await checker(post, approved, { expectedDigest: digest, digest, now: '2026-11-05T00:02:00Z' });
    assert.equal(after.needsReview, false, kind);
  }
});

test('祈愿保留版本更新后原文，维护使用唯一开始与官方预计五小时', () => {
  for (const id of ['167161', '167162', '167163']) {
    const event = overrides.events.find(item => item.id === key(id));
    assert.ok(event);
    validateEvent(event);
    assert.equal(event.category, 'banner');
    assert.equal(event.start, null);
    assert.equal(event.startText, '7.2版本更新后');
    assert.equal(event.end, '2026-11-24T17:59:00+08:00');
  }
  const maintenance = overrides.events.find(item => item.id === key('167159'));
  validateEvent(maintenance);
  assert.equal(maintenance.category, 'maintenance');
  assert.equal(maintenance.start, '2026-11-04T06:00:00+08:00');
  assert.equal(maintenance.end, '2026-11-04T11:00:00+08:00');
  assert.match(maintenance.displayNotes, /预计维护5小时/);
  assert.match(maintenance.displayNotes, /实际开服以官方通知为准/);
});

test('版本汇总只拆独有且有明确时刻的项目，不重复祈愿与全域镇卫', () => {
  const events = expectedIds.map(id => {
    const event = overrides.events.find(item => item.id === id);
    assert.ok(event, id);
    validateEvent(event);
    return event;
  });
  assert.equal(new Set(events.map(event => event.id)).size, expectedIds.length);
  const get = id => events.find(event => event.id === id);
  assert.equal(get('genshin:website:167173:archon-reward').end, '2026-12-15T14:59:00+08:00');
  assert.equal(get('genshin:website:167173:exploration-reward').end, '2027-01-26T14:59:00+08:00');
  assert.equal(get('genshin:website:167173:abyssal-war').start, '2026-11-11T10:00:00+08:00');
  assert.equal(get('genshin:website:167173:abyssal-war').end, '2026-12-15T03:59:00+08:00');
  assert.equal(get('genshin:website:167173:abyssal-war-outburst').start, '2026-11-11T10:00:00+08:00');
  assert.equal(get('genshin:website:167173:abyssal-war-outburst').end, '2026-11-21T03:59:00+08:00');
  assert.equal(get('genshin:website:167173:music-reward').end, '2026-12-15T14:59:00+08:00');
  assert.equal(get('genshin:website:167173:battle-pass').end, '2026-12-14T03:59:00+08:00');
  assert.equal(get('genshin:website:167173:battle-pass-purchase').end, '2026-12-14T02:59:00+08:00');
  for (const id of ['167161', '167162', '167163']) {
    assert.equal(overrides.events.filter(event => event.id === key(id) || event.id.startsWith(key(id) + ':')).length, 1, id);
  }
  for (const id of ['167154', '167168']) {
    assert.ok(!overrides.events.some(event => event.id === key(id) || event.id.startsWith(key(id) + ':')), id);
  }
  assert.ok(overrides.suppressPostIds.includes(key('167154')));
  assert.equal(isHandled(key('167154'), overrides), true);
  assert.equal(isHandled(key('167173'), overrides), true);
  assert.equal(renderCalendar(events, { name: '原神人工审核回归', now: '2026-11-03T06:00:00.000Z' }).match(/BEGIN:VEVENT/g)?.length, 14);
});

test('167168与167167没有统一可发布节点，保留证据而不猜版本边界', () => {
  assert.match(audit.find(item => item.postId === '167168').notes, /不生成双null或00:00节点/);
  assert.match(audit.find(item => item.postId === '167167').notes, /不猜版本结束/);
  assert.equal(overrides.events.some(event => event.id.startsWith(key('167168') + ':')), false);
  assert.equal(overrides.events.some(event => event.id.startsWith(key('167167') + ':')), false);
});

test('167169与167170当前正文不被解析器自动发布，167173拆分不造成重复', () => {
  const common = { game: 'genshin', source: 'website', official: true, published: '2026-11-02T04:00:00.000Z', url: 'https://ys.mihoyo.com/main/news/detail/' };
  for (const [id, title, text] of [
    ['167169', '「坏灭肇始之时」时限内完成魔神任务，可额外获得原石、角色突破素材等奖励', '〓获取奖励时限〓\n7.2版本更新后 ~ 2026/12/15 14:59'],
    ['167170', '「晶石如林生长之地」时限内完成探索任务，可额外获得原石*400奖励', '〓获取奖励时限〓\n7.2版本更新后 ~ 2027/01/26 14:59'],
  ]) assert.deepEqual(parsePost({ ...common, id, title, text, images: [] }), { ignored: true });
  assert.equal(overrides.events.filter(event => event.id.startsWith('genshin:website:167169')).length, 0);
  assert.equal(overrides.events.filter(event => event.id.startsWith('genshin:website:167170')).length, 0);
});
