import test from 'node:test';
import assert from 'node:assert/strict';
import { findCanonical, canonicalPost, preserveProvenance } from '../lib/identity.mjs';
import { mergeEvents, renderCalendar } from '../lib/calendar.mjs';
import { normalizeWebsite, fetchWebsite } from '../lib/sources.mjs';
import { selectSource } from '../lib/selection.mjs';
import { classify, parsePost } from '../lib/parser.mjs';
const now = '2026-10-03T01:00:00Z';
test('切换官网沿用同一公告稳定ID和历史官方出处，不重复发布', () => {
  const registry = { 'genshin:miyoushe:123': { title: '「测试」活动说明', published: now } };
  const aliases = {};
  const post = { game: 'genshin', source: 'website', id: '456', title: '「测试」活动说明', published: now };
  const canonical = findCanonical(post, registry, aliases);
  assert.equal(canonical, 'genshin:miyoushe:123');
  assert.equal(canonicalPost(post, canonical).id, '123');
  const event = { id: canonical, game: 'genshin', category: 'event', title: post.title, start: '2026-10-05T10:00:00+08:00', end: '2026-10-20T03:59:00+08:00', url: 'https://www.miyoushe.com/ys/article/123' };
  const old = mergeEvents([], [event], now);
  const current = mergeEvents(old, [preserveProvenance({ ...event, url: 'https://ys.mihoyo.com/main/news/detail/456' }, old[0])], now);
  assert.equal(current.length, 1);
  assert.equal(current[0].url, event.url);
  assert.equal(current[0].id, canonical);
  const uids = text => [...text.replace(/\r\n /g, '').matchAll(/^UID:(.+)$/gm)].map(m => m[1]);
  assert.deepEqual(uids(renderCalendar(old, { name: '测试', now })), uids(renderCalendar(current, { name: '测试', now })));
});
test('重复标题跨期或多候选不盲目关联', () => {
  const post = { game: 'genshin', source: 'website', id: '3', title: '活动说明', published: now };
  const ambiguous = { 'genshin:miyoushe:1': { title: post.title, published: now }, 'genshin:miyoushe:2': { title: post.title, published: now } };
  assert.equal(findCanonical(post, ambiguous, {}), 'genshin:website:3');
  assert.equal(findCanonical(post, { 'genshin:miyoushe:1': { title: post.title, published: '2026-08-01T00:00:00Z' } }, {}), 'genshin:website:3');
});
test('官网发布时间不是活动时间，官方正文仍需解析', () => {
  const post = normalizeWebsite({ iInfoId: 8, sTitle: '活动', sContent: '<p>活动时间</p><p>2026/10/05 10:00</p>', dtStartTime: '2026-10-03 10:00:00', dtEndTime: '2036-10-03 00:00:00' }, 'genshin', { website: { urlBase: 'https://ys.mihoyo.com/main/news/detail/' } });
  assert.equal(post.published, '2026-10-03T02:00:00.000Z');
  assert.equal(post.start, undefined);
  assert.match(post.text, /2026\/10\/05/);
});
test('官网成功时完全不请求米游社，不受其验证码影响', async () => {
  let forumRequests = 0;
  const selected = await selectSource('genshin', {}, { website: async () => ({ posts: ['official'] }), forum: async () => { forumRequests++; throw new Error('captcha'); } });
  assert.equal(selected.source, 'website');
  assert.equal(forumRequests, 0);
});
test('官网失败直接报错，米游社可用也不回退', async () => {
  let forumRequests = 0;
  const error = new Error('website down');
  await assert.rejects(selectSource('zzz', {}, { website: async () => { throw error; }, forum: async () => { forumRequests++; return { posts: ['official fallback'] }; } }), cause => cause === error);
  assert.equal(forumRequests, 0);
});
test('官网标题缺少活动字样也识别限时游戏活动，音乐社区仍排除', () => {
  assert.equal(classify('爱，幽灵与机器人', '限时活动期\n2026/09/28 4.6版本更新后 - 2026/11/11 03:59'), 'event');
  assert.equal(classify('镇伏「贪饕」，汇聚愿力', '活动时间\n4.6版本期间\n参与条件\n开拓等级'), 'event');
  assert.equal(classify('听歌领80星琼！音乐活动', '活动时间\n参与条件'), null);
});
test('通行证购买截止不得混入任务与奖励截止', () => {
  const result = parsePost({ game: 'zzz', source: 'website', id: '1', official: true, title: '3.2版本「丽都城募」说明', published: now, url: 'https://zzz.mihoyo.com/news/1', text: '活动时间\n3.2版本更新后 ~ 2026/10/19 03:59\n※2026/10/19 02:59 将关闭本次活动中「成长计划」的购买。\n参与条件' });
  assert.ok(result.review);
  assert.equal(result.event, undefined);
});
test('官网同服务备用入口仍属于官网，不请求其他来源', async () => {
  const config = { website: { base: 'https://act-api-takumi-static.mihoyo.com', fallbackBases: ['https://api-takumi-static.mihoyo.com'], app: 'test', channel: 273, urlBase: 'https://zzz.mihoyo.com/news/' } };
  const requests = [];
  const result = await fetchWebsite('zzz', config, async url => {
    requests.push(url);
    if (requests.length === 1) throw new Error('unreachable');
    return { iTotal: 1, list: [{ iInfoId: 8, sTitle: '官网公告', sContent: '<p>正文</p>', dtStartTime: '2026-10-03 10:00:00' }] };
  });
  assert.equal(requests.length, 2);
  assert.equal(result.posts[0].source, 'website');
  assert.equal(result.endpoint, config.website.fallbackBases[0]);
});
test('官网失败没有新增事件，保留已有米游社UID和历史出处', () => {
  const event = { id: 'genshin:miyoushe:123:main', game: 'genshin', category: 'event', title: '活动', start: '2026-10-05T10:00:00+08:00', end: '2026-10-20T03:59:00+08:00', url: 'https://www.miyoushe.com/ys/article/123' };
  const old = mergeEvents([], [event], now);
  assert.deepEqual(mergeEvents(old, [], '2026-10-04T01:00:00Z'), old);
  const incoming = { ...event, id: 'genshin:website:456:main', url: 'https://ys.mihoyo.com/main/news/detail/456' };
  assert.equal(preserveProvenance(incoming, undefined), incoming);
});
