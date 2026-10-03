import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

async function context() {
  const html = await fs.readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const source = html.slice(html.indexOf('    function groupEvents('), html.indexOf('    function renderEvents('));
  const ctx = { games: { genshin: '原神', starrail: '崩坏：星穹铁道', zzz: '绝区零' }, dateValue: value => value ? new Date(value) : null };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  return { html, ctx };
}

test('活动按游戏唯一分组、保留全部记录，新游戏自动独立分组', async () => {
  const { ctx } = await context();
  const events = JSON.parse(await fs.readFile(new URL('../data/events.json', import.meta.url), 'utf8'));
  const originalOrder = events.map(e => e.id);
  const groups = ctx.groupEvents(events);
  assert.equal(groups.length, 3);
  const grouped = groups.flatMap(g => g.items);
  assert.equal(grouped.length, events.length);
  assert.deepEqual(new Set(grouped.map(e => e.id)), new Set(originalOrder));
  assert.ok(groups.every(g => g.items.every(e => e.game === g.key)));
  assert.deepEqual(events.map(e => e.id), originalOrder, 'Grouping must not mutate the published list');
  const expanded = ctx.groupEvents([...events, { game: 'future-game', title: '新游戏测试' }, { title: '未分类测试' }]);
  assert.equal(expanded.length, 5);
  assert.equal(expanded.find(g => g.key === 'future-game').items.length, 1);
  assert.equal(expanded.find(g => g.key === 'other').title, '其他游戏');
});

test('已注册的空游戏保留收纳栏，不混入其他游戏内容', async () => {
  const { ctx } = await context();
  const groups = ctx.groupEvents([{ game: 'genshin', title: '唯一活动' }]);
  assert.equal(groups.length, 3);
  assert.equal(groups[1].items.length, 0);
  assert.equal(groups[2].items.length, 0);
});

test('游戏和卡片原生折叠、默认收起、按需建卡，无全部游戏筛选', async () => {
  const { html } = await context();
  assert.doesNotMatch(html, /data-filter|selectedGame|全部游戏/);
  assert.match(html, /textElement\('details', 'game-group'/);
  assert.match(html, /textElement\('details', 'event-card'/);
  assert.match(html, /if \(!section\.open \|\| built\) return/);
  assert.doesNotMatch(html, /\.open\s*=\s*true|setAttribute\('open'/);
  assert.match(html, /ics\/all\.ics/);
  assert.match(html, /if \(!events\.length\) renderEvents\(\)/);
});

test('摘要时间不猜版本更新时刻，维护与前瞻标签准确', async () => {
  const html = await fs.readFile(new URL('../site/index.html', import.meta.url), 'utf8');
  const source = html.slice(html.indexOf('    function eventTime('), html.indexOf('    function createEventCard('));
  const ctx = { formatDate: value => value || '未提供明确时间' };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  assert.equal(ctx.eventTime(null, '2026/06/01 4.3版本更新后'), '2026/06/01 4.3版本更新后');
  assert.equal(ctx.eventTime('明确时间', '版本更新后'), '明确时间');
  assert.equal(ctx.eventTime(null, null), '未提供明确时间');
  assert.match(html, /'预计维护结束'/);
  assert.match(html, /'开播'/);
});
