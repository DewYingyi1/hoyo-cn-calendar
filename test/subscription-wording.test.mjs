import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

test('全部订阅文案不限定游戏数量，删选游戏前句、保留网址订阅说明', async () => {
  const html = await fs.readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const readme = await fs.readFile(new URL('../README.md', import.meta.url), 'utf8');
  const build = await fs.readFile(new URL('../scripts/build.mjs', import.meta.url), 'utf8');
  const update = await fs.readFile(new URL('../scripts/update.mjs', import.meta.url), 'utf8');
  for (const text of [html, readme, build]) assert.doesNotMatch(text, /三款|三游|三个独立|合并版|合并日历/);
  assert.match(html, /<meta name="description" content="订阅米哈游游戏的国服活动日历。基于公开官方来源，无需游戏账号。">/);
  assert.match(html, /<p class="hero-copy">把米哈游游戏公开官方活动的时间节点订阅到自己的日历，少一次来回查公告。<\/p>/);
  assert.match(html, /<span class="aside-footer">MIHOYO GAMES<\/span>/);
  assert.match(readme, /^# 米哈游游戏国服活动日历$/m);
  assert.match(readme, /^米哈游游戏国服的公开 ICS 订阅。/m);
  assert.match(html, /<p class="section-description">复制链接后，在日历应用里添加「网址订阅」，即可持续更新。<\/p>/);
  assert.match(html, /<h3>全部订阅<\/h3>/);
  assert.match(html, /全部订阅 · 时间跨度/);
  assert.match(html, /已复制「.*全部订阅/);
  assert.match(readme, /全部订阅.*all\.ics/);
  assert.match(build, /game === 'all' \? '全部订阅'/);
  assert.match(update, /successes\}\/\$\{Object\.keys\(GAMES\)\.length\}/);
});

test('全部订阅描述不再显示成功数量，状态判断随配置扩展并保留异常告警', async () => {
  const html = await fs.readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const source = html.slice(html.indexOf('    function renderStatus('), html.indexOf('    function officialURL('));
  const elements = new Map();
  const get = key => {
    if (!elements.has(key)) elements.set(key, { textContent: '', hidden: false, replaceChildren() {}, append() {} });
    return elements.get(key);
  };
  const ctx = {
    events: [{}], games: { a: 'a', b: 'b', c: 'c', d: 'd' },
    document: { getElementById: get, querySelector: get },
    dateValue: value => value ? new Date(value) : null, formatDate: value => value || '未知',
    setBadge() {}, textElement() {}, renderEvents() {},
    gameHealth: record => record ? { label: '有成功记录', tone: record.error ? 'warning' : 'good', detail: '' } : { label: '未发布', tone: 'neutral', detail: '' },
  };
  vm.createContext(ctx);
  vm.runInContext(source + '\nrenderStatus({games:{a:{},b:{},c:{}},issues:[]})', ctx);
  assert.equal(get('overall-status').textContent, '部分已发布', 'Fourth game must not be silently treated as published');
  assert.equal(get('[data-detail="all"]').textContent, '各游戏更新时间不同，不代表完整排期。');
  vm.runInContext('renderStatus({games:{a:{},b:{},c:{},d:{error:"失败"}},issues:[]})', ctx);
  assert.equal(get('overall-status').textContent, '部分更新需关注');
  vm.runInContext('renderStatus(null)', ctx);
  assert.equal(get('overall-status').textContent, '状态不可用');
  assert.equal(get('[data-detail="all"]').textContent, '各游戏更新时间不同，不代表完整排期。');
});
