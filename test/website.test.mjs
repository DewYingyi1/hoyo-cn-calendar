import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as sources from '../lib/sources.mjs';
import { selectSource, isWebsiteInput } from '../lib/selection.mjs';

const configs = JSON.parse(await fs.readFile(new URL('../sources/games.json', import.meta.url), 'utf8'));

test('采集配置只保留官网字段，不暴露米游社采集适配器', () => {
  assert.deepEqual(Object.keys(configs).sort(), ['genshin', 'starrail', 'zzz']);
  for (const config of Object.values(configs)) {
    assert.deepEqual(Object.keys(config), ['website']);
    assert.ok(Object.keys(config.website).every(key => ['base', 'fallbackBases', 'app', 'channel', 'urlBase'].includes(key)));
    for (const base of [config.website.base, ...(config.website.fallbackBases ?? [])]) {
      assert.equal(new URL(base).protocol, 'https:');
      assert.ok(new URL(base).hostname.endsWith('.mihoyo.com'));
    }
  }
  assert.equal(sources.fetchForum, undefined);
  assert.equal(sources.normalizeForum, undefined);
});

test('三个官网采集入口都配置同服务备用域名并支持切换', async () => {
  for (const [game, config] of Object.entries(configs)) {
    assert.deepEqual(config.website.fallbackBases, ['https://api-takumi-static.mihoyo.com']);
    const requests = [];
    const result = await sources.fetchWebsite(game, config, async url => {
      requests.push(url);
      if (requests.length === 1) throw new Error('primary unavailable');
      return { iTotal: 1, list: [{ iInfoId: 8, sTitle: `${game}官网公告`, sContent: '<p>正文</p>', dtStartTime: '2026-10-03 10:00:00' }] };
    });
    assert.deepEqual(requests.map(url => new URL(url).origin), [config.website.base, config.website.fallbackBases[0]]);
    assert.equal(result.endpoint, config.website.fallbackBases[0]);
  }
});

test('所有官网服务入口失败，仍不调用米游社或B站，不受旧开关影响', async () => {
  for (const websiteOnly of [undefined, false, true]) {
    const requests = [];
    let retiredRequests = 0;
    await assert.rejects(selectSource('zzz', configs.zzz, {
      website: (game, config) => sources.fetchWebsite(game, config, async url => { requests.push(url); throw new Error('offline'); }),
      forum: async () => { retiredRequests++; return { posts: ['fallback'] }; },
      bilibili: async () => { retiredRequests++; return { posts: ['supplement'] }; },
      websiteOnly,
    }), /act-api-takumi-static\.mihoyo\.com.*source-invalid.*api-takumi-static\.mihoyo\.com.*source-invalid/);
    assert.equal(retiredRequests, 0);
    assert.deepEqual(requests.map(url => new URL(url).origin), [configs.zzz.website.base, ...configs.zzz.website.fallbackBases]);
  }
});

test('模型输入只接受官网原始来源，允许历史米游社canonical身份', () => {
  const post = { game: 'genshin', source: 'website', id: '456', official: true, url: configs.genshin.website.urlBase + '456', canonical: 'genshin:miyoushe:123' };
  assert.equal(isWebsiteInput(post, configs), true);
  for (const source of ['miyoushe', 'bilibili', undefined]) assert.equal(isWebsiteInput({ ...post, source }, configs), false);
  for (const url of ['https://www.miyoushe.com/ys/article/123', 'https://www.bilibili.com/video/BV123', post.url + '?redirect=1']) assert.equal(isWebsiteInput({ ...post, url }, configs), false);
  assert.equal(isWebsiteInput({ ...post, official: false }, configs), false);
  assert.equal(isWebsiteInput({ ...post, game: 'unknown' }, configs), false);
});

test('更新与审核入口均无旧补源调用，清理旧状态且过滤本机审核缓存', async () => {
  const update = await fs.readFile(new URL('../scripts/update.mjs', import.meta.url), 'utf8');
  const review = await fs.readFile(new URL('../scripts/review.mjs', import.meta.url), 'utf8');
  for (const script of [update, review]) assert.doesNotMatch(script, /fetchForum|fetchBilibili|bilibili\.json|WEBSITE_ONLY/);
  assert.match(update, /delete status\.supplemental;/);
  assert.match(update, /preserveProvenance\(event, canonicalOld\.get\(event\.id\)\)/);
  assert.match(review, /inputs = inputs\.filter\(post => isWebsiteInput\(post, games\)\);/);
  for (const file of ['../lib/bilibili.mjs', '../test/bilibili.test.mjs', '../sources/bilibili.json']) {
    await assert.rejects(fs.access(new URL(file, import.meta.url)), { code: 'ENOENT' });
  }
});
