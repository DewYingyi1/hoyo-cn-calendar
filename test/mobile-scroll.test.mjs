import fs from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

test('延迟状态更新不再移除已加载活动卡片', async () => {
  const html = await fs.readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const source = html.slice(html.indexOf('    function renderStatus('), html.indexOf('    function officialURL('));
  assert.ok(source.includes('if (!events.length) renderEvents();'));
  let renders = 0;
  const element = () => ({ textContent: '', hidden: false, replaceChildren() {}, append() {} });
  const context = {
    events: [{ id: 'sample' }], games: { genshin: '原神', starrail: '星铁', zzz: '绝区零' },
    document: { getElementById: element, querySelector: element },
    setBadge() {}, gameHealth() { return { label: '已发布', tone: 'good', detail: '' }; },
    dateValue: value => value ? new Date(value) : null,
    formatDate: value => value || '未知', textElement: element,
    renderEvents() { renders++; },
  };
  vm.createContext(context);
  vm.runInContext(source + '\nrenderStatus({games:{genshin:{lastSuccessAt:"2026-10-03T00:00:00Z"}},issues:[]});', context);
  assert.equal(renders, 0);
  context.events = [];
  vm.runInContext('renderStatus(null)', context);
  assert.equal(renders, 1, 'Empty/error presentation still follows publication status');
});
test('手机禁用程序平滑滚动并优化屏外卡片，不拦截触摸或裁短活动列表', async () => {
  const css = await fs.readFile(new URL('../site/style.css', import.meta.url), 'utf8');
  const html = await fs.readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  assert.match(css, /@media \(max-width: 720px\) \{\s*html \{ scroll-behavior: auto; \}/);
  assert.match(css, /content-visibility: auto; contain-intrinsic-size: auto 150px/);
  assert.doesNotMatch(html, /preventDefault\(|addEventListener\(['"](?:touchmove|wheel)/);
  assert.match(html, /group\.items\.forEach\(event/);
});
