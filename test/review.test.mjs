import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCandidate, parseModelJSON, loadReviewImage, confirmedImages } from '../lib/review.mjs';
const post = { game: 'zzz', canonical: 'zzz:website:1', published: '2026-10-03T00:00:00Z', url: 'https://zzz.mihoyo.com/news/1', text: '活动时间：2026/10/03 10:00 ~ 2026/10/19 03:59', images: ['https://fastcdn.mihoyo.com/test.png'] };
const candidate = { title: '活动', category: 'event', start: '2026-10-03T10:00:00+08:00', end: '2026-10-19T03:59:00+08:00', evidence: [{ kind: 'text', quote: post.text, url: post.url }], uncertainties: [] };
test('明确引用校验通过仍是待批准候选，不直接发布', () => {
  const result = checkCandidate(candidate, post, []);
  assert.equal(result.eligible, true);
  assert.equal(result.publication, 'pending-human-approval');
});
test('模型虚构日期和图片识别不视作独立确认', () => {
  assert.equal(checkCandidate({ ...candidate, end: '2026-10-20T03:59:00+08:00' }, post, []).eligible, false);
  assert.equal(checkCandidate({ ...candidate, evidence: [{ kind: 'image', quote: '日期', url: post.images[0] }] }, post, []).eligible, false);
});
test('已有事件冲突重复、无时间、不确定项全部拦截', () => {
  assert.equal(checkCandidate(candidate, post, [{ id: post.canonical, game: 'zzz', title: '活动', start: candidate.start, end: candidate.end }]).eligible, false);
  assert.equal(checkCandidate({ ...candidate, uncertainties: ['只给版本相对时间'] }, post, []).eligible, false);
  assert.equal(checkCandidate({ ...candidate, start: null, end: null }, post, []).eligible, false);
});
test('非法JSON与未知日期结构不通过', () => {
  assert.throws(() => parseModelJSON('not json'));
  assert.throws(() => parseModelJSON('{}'));
  assert.equal(checkCandidate({ ...candidate, start: '2026-02-30T10:00:00+08:00' }, post, []).eligible, false);
});
test('图片只读取白名单域名、不接受HTML、限大小、不跳转', async () => {
  await assert.rejects(loadReviewImage('https://evilmihoyo.com/p.png'), /白名单/);
  await assert.rejects(loadReviewImage(post.images[0], async () => new Response('html', { headers: { 'content-type': 'text/html' } })), /格式/);
  await assert.rejects(loadReviewImage(post.images[0], async () => new Response('', { headers: { 'content-type': 'image/png', 'content-length': '99999999' } })), /8MiB/);
  const image = await loadReviewImage(post.images[0], async (_, options) => { assert.equal(options.redirect, 'error'); return new Response('image', { headers: { 'content-type': 'image/png' } }); });
  assert.equal(image.bytes.toString(), 'image');
});
test('已确认图片链接变化告警持续，不因下轮采集自动消失', () => {
  const reference = { confirmedImagesDigest: 'confirmed-body', confirmedImagesHash: 'old-images', imagesHash: 'new-images' };
  assert.equal(confirmedImages(reference, 'confirmed-body', 'new-images').changed, true);
  assert.equal(confirmedImages(reference, 'reconfirmed-body', 'new-images').changed, false);
});
