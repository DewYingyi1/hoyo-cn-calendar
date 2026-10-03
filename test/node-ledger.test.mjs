import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mergeEvents, nodeUid, renderCalendar } from '../lib/calendar.mjs';
import { initializeNodeLedger, reconcileNodeLedger, nodeKey } from '../lib/node-ledger.mjs';

const now = '2026-10-03T06:00:00Z';
const later = '2026-10-04T06:00:00Z';
const base = { id: 'genshin:miyoushe:123', game: 'genshin', category: 'event', title: '测试活动', start: '2026-10-05T10:00:00+08:00', end: '2026-10-20T03:59:00+08:00', url: 'https://www.miyoushe.com/ys/article/123', modified: '2026-10-03T01:00:00Z', sequence: 0 };
const initialize = events => initializeNodeLedger(events, { now });
const update = (ledger, events, options = {}) => reconcileNodeLedger(ledger, events, { now: later, ...options });
const render = (result, mode = 'nodes', time = later) => renderCalendar([], { name: '测试', now: time, mode, publishedNodes: result.publishedNodes[mode] });
const unfolded = text => text.replace(/\r\n /g, '');
const uids = text => [...unfolded(text).matchAll(/^UID:([^\r\n]+)/gm)].map(match => match[1]);
const entry = (result, mode, suffix) => result.ledger.nodes.find(node => node.mode === mode && node.node.suffix === suffix);
const childResult = child => new Promise((resolve, reject) => {
  let stdout = '', stderr = '';
  child.stdout?.on('data', chunk => { stdout += chunk; });
  child.stderr?.on('data', chunk => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
});
const waitForOutput = (child, marker) => new Promise((resolve, reject) => {
  let output = '';
  const timeout = setTimeout(() => reject(new Error(`等待子进程标记超时：${marker}`)), 10000);
  child.stdout.on('data', chunk => {
    output += chunk;
    if (output.includes(marker)) { clearTimeout(timeout); resolve(output); }
  });
  child.once('error', error => { clearTimeout(timeout); reject(error); });
  child.once('close', code => { if (!output.includes(marker)) { clearTimeout(timeout); reject(new Error(`子进程提前退出：${code}`)); } });
});

test('已有完整区间全部UID、modified、展示修订offset2及ICS字节兼容', () => {
  const events = [base, { ...base, id: 'genshin:miyoushe:124', category: 'maintenance', sequence: 7, modified: '2026-10-03T07:00:00Z' }, { ...base, id: 'genshin:miyoushe:125', category: 'livestream', end: null }];
  const baseline = initialize(events);
  const result = update(baseline, events);
  for (const mode of ['nodes', 'timeline']) {
    assert.equal(render(result, mode), renderCalendar(events, { name: '测试', now: later, mode }));
  }
  assert.deepEqual(result.ledger, baseline);
  assert.deepEqual(update(result.ledger, events, { now: '2026-10-05T06:00:00Z' }).ledger, baseline);
  assert.match(unfolded(render(result)), /SEQUENCE:2\r\n/);
  assert.match(unfolded(render(result)), /SEQUENCE:9\r\n/);
  assert.match(unfolded(render(result)), /LAST-MODIFIED:20261003T052000Z/);
});

test('单截止时间轴补开始仍用首次UID，但suffix变成timeline', () => {
  const deadline = { ...base, start: null, startText: '版本更新后' };
  const baseline = initialize([deadline]);
  const changed = mergeEvents([deadline], [base], later);
  const result = update(baseline, changed);
  const timeline = result.publishedNodes.timeline;
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].node.uid, nodeUid(base.id, 'end', 'timeline'));
  assert.equal(timeline[0].node.suffix, 'timeline');
  assert.equal(entry(result, 'timeline', 'timeline').sequence, 1);
  const text = unfolded(render(result, 'timeline'));
  assert.match(text, /DTSTART:20261005T020000Z/);
  assert.match(text, /DTEND:20261019T195900Z/);
  assert.match(text, /时间区间/);
  assert.doesNotMatch(text, /15分钟|CANCELLED/);
  assert.deepEqual(uids(text), uids(renderCalendar([deadline], { mode: 'timeline', name: '测试', now })));
});

test('单开始与完整时间轴往返沿用UID，不累积重复取消', () => {
  const startOnly = { ...base, end: null };
  const first = update(initialize([startOnly]), [base]);
  assert.equal(first.publishedNodes.timeline[0].node.uid, nodeUid(base.id, 'start', 'timeline'));
  const second = update(first.ledger, [startOnly], { now: '2026-10-05T06:00:00Z' });
  assert.equal(second.publishedNodes.timeline.length, 1);
  assert.equal(second.publishedNodes.timeline[0].node.uid, first.publishedNodes.timeline[0].node.uid);
  assert.equal(second.publishedNodes.timeline[0].node.suffix, 'start');
  assert.equal(second.publishedNodes.nodes.filter(item => item.node.cancelled).length, 1);
});

test('节点移除保留原UID与原时间，递增SEQUENCE输出CANCELLED墓碑', () => {
  const baseline = initialize([base]);
  const result = update(baseline, [{ ...base, start: null }]);
  const removed = entry(result, 'nodes', 'start');
  assert.equal(removed.state, 'retired');
  assert.equal(removed.sequence, 1);
  assert.equal(removed.modified, later);
  assert.equal(removed.node.start, base.start);
  assert.equal(removed.uid, nodeUid(base.id, 'start', 'nodes'));
  const text = unfolded(render(result));
  assert.match(text, /SEQUENCE:3/);
  assert.match(text, /STATUS:CANCELLED/);
  assert.equal(result.publishedNodes.nodes.length, 2);
  assert.equal(result.publishedNodes.timeline[0].node.uid, nodeUid(base.id, 'timeline', 'timeline'));
});

test('整项抑制或人工撤回取消所有已发布节点，重复取消稳定', () => {
  const baseline = initialize([base]);
  const cancelled = update(baseline, [], { explicitRemovals: [base.id] });
  assert.equal(cancelled.ledger.nodes.length, 3);
  assert.ok(cancelled.ledger.nodes.every(node => node.state === 'retired' && node.sequence === 1));
  assert.equal((render(cancelled).match(/STATUS:CANCELLED/g) ?? []).length, 2);
  const repeated = update(cancelled.ledger, [], { now: '2026-10-06T06:00:00Z', explicitRemovals: [base.id] });
  assert.deepEqual(repeated.ledger, cancelled.ledger);
  assert.equal(render(repeated), render(cancelled));
});

test('拆分后旧UID取消，新区间保持各自原生UID，不把旧UID分给子事件', () => {
  const child1 = { ...base, id: base.id + ':first', title: '第一期' };
  const child2 = { ...base, id: base.id + ':second', title: '第二期' };
  const result = update(initialize([base]), [child1, child2], { explicitRemovals: [base.id] });
  assert.equal(result.publishedNodes.nodes.length, 6);
  assert.equal(result.publishedNodes.timeline.length, 3);
  assert.equal(result.ledger.nodes.filter(node => node.state === 'retired').length, 3);
  assert.equal(entry(result, 'timeline', 'timeline').state, 'retired');
  assert.ok(result.publishedNodes.timeline.some(({ node }) => node.uid === nodeUid(child1.id, 'timeline', 'timeline') && !node.cancelled));
  assert.equal(new Set(uids(render(result))).size, 6);
});

test('mergeEvents保留失联来源，账本不因source失联退休', () => {
  const baseline = initialize([base]);
  const result = update(baseline, mergeEvents([base], [], later));
  assert.deepEqual(result.ledger, baseline);
  assert.ok(result.ledger.nodes.every(node => node.state === 'active'));
});

test('自然过期或未进入未来窗口只停止发布，不退役不取消', () => {
  const baseline = initialize([base]);
  const old = update(baseline, [base], { now: '2027-04-01T06:00:00Z' });
  assert.deepEqual(old.ledger, baseline);
  assert.deepEqual(old.publishedNodes, { nodes: [], timeline: [] });
  const future = { ...base, start: '2028-10-05T10:00:00+08:00', end: '2028-10-20T03:59:00+08:00' };
  const deferred = update(baseline, [future]);
  assert.ok(deferred.ledger.nodes.every(node => node.state === 'active'));
  assert.deepEqual(deferred.publishedNodes, { nodes: [], timeline: [] });
  assert.equal(update(initialize([]), [future]).ledger.nodes.length, 0);
  const yesterday = { ...base, start: '2026-10-02T10:00:00+08:00', end: '2026-10-03T10:00:00+08:00' };
  const cleaned = update(initializeNodeLedger([yesterday], { now: '2026-10-02T01:00:00Z' }), [], { now: later });
  assert.ok(cleaned.ledger.nodes.every(node => node.state === 'active'));
  assert.deepEqual(cleaned.publishedNodes, { nodes: [], timeline: [] });
});

test('120天取消窗口从退休算起，过期UID仍保留修订记忆', () => {
  const baseline = initialize([base]);
  const cancelled = update(baseline, [], { now: later, explicitRemovals: [base.id] });
  assert.equal(cancelled.publishedNodes.nodes.length, 2);
  const atBoundary = new Date(Date.parse(later) + 120 * 86400000).toISOString();
  assert.equal(update(cancelled.ledger, [], { now: atBoundary }).publishedNodes.nodes.length, 2);
  const after = update(cancelled.ledger, [], { now: new Date(Date.parse(atBoundary) + 1).toISOString() });
  assert.deepEqual(after.publishedNodes, { nodes: [], timeline: [] });
  assert.deepEqual(after.ledger, cancelled.ledger);
  assert.throws(() => update(cancelled.ledger, [], { tombstoneDays: 119 }), /120天/);
});

test('已自然过期四月维护从数据清理或新增cancelled标志均不刷取消墓碑', () => {
  const april = { ...base, category: 'maintenance', start: '2026-04-22T06:00:00+08:00', end: '2026-04-22T11:00:00+08:00' };
  const baseline = initializeNodeLedger([april], { now: '2026-04-22T01:00:00Z' });
  for (const events of [[], [april]]) {
    const result = update(baseline, events, { now });
    assert.deepEqual(result.ledger, baseline);
    assert.deepEqual(result.publishedNodes, { nodes: [], timeline: [] });
  }
  const withdrawn = update(baseline, [], { now, explicitRemovals: [april.id] });
  assert.ok(withdrawn.ledger.nodes.every(node => node.state === 'retired'));
  assert.ok(withdrawn.publishedNodes.nodes.every(item => item.node.cancelled));
  const cancelled = update(baseline, [{ ...april, cancelled: true }], { now });
  assert.ok(cancelled.ledger.nodes.every(node => node.state === 'retired'));
});

test('真实基线没有的已结束旧事件不补发，取消不当新活动', () => {
  const past = { ...base, start: '2026-09-01T10:00:00+08:00', end: '2026-09-02T10:00:00+08:00' };
  const result = update(initialize([]), [past, { ...base, id: base.id + ':cancelled', cancelled: true }]);
  assert.deepEqual(result.ledger.nodes, []);
  assert.deepEqual(result.publishedNodes, { nodes: [], timeline: [] });
});

test('真实公开ICS基线只注册确实发布UID，取已发布修订，拒绝基线错配', () => {
  const first = { ...base, start: null };
  const extra = { ...base, id: base.id + ':not-published' };
  const calendars = Object.fromEntries(['nodes', 'timeline'].map(mode => [mode, renderCalendar([first], { name: '测试', now, mode })]));
  const baseline = initializeNodeLedger([first, extra], { now, calendars });
  assert.equal(baseline.nodes.length, 2);
  assert.ok(baseline.nodes.every(node => node.eventId === base.id));
  assert.ok(baseline.nodes.every(node => node.modified === '2026-10-03T05:20:00Z' && node.sequence === 0));
  const result = update(baseline, [base]);
  assert.equal(result.publishedNodes.timeline[0].node.uid, nodeUid(base.id, 'end', 'timeline'));
  assert.throws(() => initializeNodeLedger([extra], { now, calendars }), /未映射UID/);
  assert.throws(() => initializeNodeLedger([{ ...first, end: '2026-10-21T03:59:00+08:00' }], { now, calendars }), /不一致/);
});

test('真实公开ICS基线拒绝标题、说明、URL、分类或状态与网页基线错代', () => {
  const calendars = Object.fromEntries(['nodes', 'timeline'].map(mode => [mode, renderCalendar([base], { name: '测试', now, mode })]));
  for (const changed of [
    ['SUMMARY', { ...base, title: '错代标题' }],
    ['DESCRIPTION', { ...base, displayNotes: '错代说明' }],
    ['URL', { ...base, url: 'https://ys.mihoyo.com/main/news/detail/999' }],
    ['CATEGORIES', { ...base, category: 'banner' }],
    ['STATUS', { ...base, cancelled: true }],
  ].map(([, event]) => event)) assert.throws(() => initializeNodeLedger([changed], { now, calendars }), /公开ICS与事件基线内容不一致/);
});

test('取消不是新活动，无历史UID的cancelled事件不注册', () => {
  const result = update(initialize([]), [{ ...base, cancelled: true }]);
  assert.deepEqual(result.ledger.nodes, []);
  assert.deepEqual(result.publishedNodes, { nodes: [], timeline: [] });
});

test('数据cancelled标志取消沿用UID，手工回退sequence也不倒退', () => {
  const events = [{ ...base, sequence: 8 }];
  const baseline = initialize(events);
  const cancelled = update(baseline, [{ ...base, cancelled: true, sequence: 1 }]);
  assert.ok(cancelled.ledger.nodes.every(node => node.sequence === 9));
  assert.match(unfolded(render(cancelled)), /SEQUENCE:11/);
  assert.deepEqual(update(cancelled.ledger, [{ ...base, cancelled: true }]).ledger, cancelled.ledger);
  const restored = update(cancelled.ledger, [base], { now: '2026-10-05T06:00:00Z' });
  assert.ok(restored.ledger.nodes.every(node => node.sequence === 10 && node.state === 'active'));
  assert.deepEqual(uids(render(restored)), uids(renderCalendar(events, { name: '测试', now })));
});

test('人工修改未调sequence/modified时账本补递增，两模式取消修订同样稳定', () => {
  const baseline = initialize([base]);
  const result = update(baseline, [{ ...base, title: '修正标题' }]);
  assert.ok(result.ledger.nodes.every(node => node.sequence === 1 && node.modified === later));
  assert.deepEqual(update(result.ledger, [{ ...base, title: '修正标题' }], { now: '2026-10-07T06:00:00Z' }).ledger, result.ledger);
  assert.match(unfolded(render(result)), /SEQUENCE:3/);
});

test('常规merge修订不双重增加，沿用源modified与presentation offset2', () => {
  const changed = mergeEvents([base], [{ ...base, title: '新标题' }], later);
  const result = update(initialize([base]), changed);
  assert.ok(result.ledger.nodes.every(node => node.sequence === 1 && node.modified === later));
  assert.equal(render(result), renderCalendar(changed, { name: '测试', now: later }));
});

test('公开事件基线notes按读者文案还原，不误触发ICS修订', () => {
  const event = { ...base, notes: '截止仅指限时活动奖励期；常驻玩法可能继续开放。' };
  const baseline = initializeNodeLedger([{ ...event, notes: '截止仅针对限时奖励，常驻玩法仍可继续体验。' }], { now, publicBaseline: true });
  const result = update(baseline, [event]);
  assert.ok(result.ledger.nodes.every(node => node.sequence === event.sequence && node.modified === event.modified));
  for (const mode of ['nodes', 'timeline']) assert.equal(render(result, mode), renderCalendar([event], { name: '测试', now: later, mode }));
});

test('alias来源迁移及分段ID保留既有UID，不重哈希、不输出取消', () => {
  const old = { ...base, id: base.id + ':main' };
  const current = { ...old, id: 'genshin:website:456:main' };
  const baseline = initialize([old]);
  const result = update(baseline, [current], { aliases: { [base.id]: 'genshin:website:456' } });
  for (const mode of ['nodes', 'timeline']) {
    assert.deepEqual(uids(render(result, mode)), uids(renderCalendar([old], { name: '测试', mode, now })));
    assert.doesNotMatch(render(result, mode), /CANCELLED/);
  }
  assert.ok(result.ledger.nodes.every(node => node.eventId === current.id && node.sequence === 0));
});

test('alias链兼容，循环或canonical重复阻止发布', () => {
  const current = { ...base, id: 'genshin:website:456' };
  const aliases = { [base.id]: 'genshin:website:789', 'genshin:website:789': current.id };
  assert.deepEqual(uids(render(update(initialize([base]), [current], { aliases }))), uids(renderCalendar([base], { name: '测试', now })));
  assert.throws(() => update(initialize([base]), [current], { aliases: { [base.id]: current.id, [current.id]: base.id } }), /循环/);
  assert.throws(() => update(initialize([base]), [base, current], { aliases }), /重复 canonical/);
});

test('显式UID alias可初始化历史映射，并在重命名时匹配旧UID', () => {
  const uid = nodeUid(base.id, 'end', 'timeline');
  const uidAliases = { [nodeKey(base.id, 'timeline', 'timeline')]: uid };
  const baseline = initializeNodeLedger([base], { now, uidAliases });
  assert.equal(baseline.nodes.find(node => node.mode === 'timeline').uid, uid);
  const renamed = { ...base, id: base.id + ':replacement' };
  const result = update(baseline, [renamed], { uidAliases: { [nodeKey(renamed.id, 'timeline', 'timeline')]: uid } });
  assert.equal(result.publishedNodes.timeline.length, 1);
  assert.equal(result.publishedNodes.timeline[0].node.uid, uid);
  assert.equal(result.publishedNodes.timeline[0].node.cancelled, false);
});

test('纯函数不修改基线或事件，初始化只记录实际发布窗口', () => {
  const events = [base];
  const baseline = initialize(events);
  const savedEvents = structuredClone(events);
  const savedBaseline = structuredClone(baseline);
  const result = update(baseline, events);
  result.publishedNodes.nodes[0].event.title = '外部修改';
  result.publishedNodes.nodes[0].node.start = '外部修改';
  assert.deepEqual(baseline, savedBaseline);
  assert.deepEqual(events, savedEvents);
  assert.equal(result.ledger.nodes[0].event.title, base.title);
  assert.equal(initialize([{ ...base, start: '2025-01-01T10:00:00+08:00', end: '2025-01-02T10:00:00+08:00' }]).nodes.length, 0);
});

test('已取消发布基线兼容，损坏账本与重复UID拒绝发布', () => {
  const events = [{ ...base, cancelled: true }];
  const baseline = initialize(events);
  const result = update(baseline, events);
  assert.equal(render(result), renderCalendar(events, { name: '测试', now: later }));
  assert.deepEqual(result.ledger, baseline);
  assert.throws(() => update({ version: 99, nodes: [] }, [base]), /不支持/);
  assert.throws(() => update({ ...baseline, nodes: [...baseline.nodes, baseline.nodes[0]] }, [base]), /UID/);
  assert.throws(() => initializeNodeLedger([base]), /时间/);
});

test('隔离build集成：持久化账本、抑制/拆分墓碑、退休不显示网页、重复构建字节稳定', async () => {
  const clock = Date.now();
  const cnTime = millis => new Date(millis + 8 * 3600000).toISOString().slice(0, 19) + '+08:00';
  const fixture = { ...base, start: cnTime(clock + 2 * 86400000), end: cnTime(clock + 20 * 86400000), modified: new Date(clock).toISOString() };
  const tempBase = process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : os.tmpdir();
  await fs.mkdir(tempBase, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempBase, 'hoyo-ledger-test-'));
  try {
    await fs.mkdir(path.join(root, 'scripts'));
    await fs.mkdir(path.join(root, 'lib'));
    await fs.mkdir(path.join(root, 'data'));
    for (const file of ['scripts/build.mjs', 'lib/calendar.mjs', 'lib/node-ledger.mjs', 'lib/time.mjs']) {
      await fs.copyFile(new URL('../' + file, import.meta.url), path.join(root, file));
    }
    const write = (file, value) => fs.writeFile(path.join(root, file), JSON.stringify(value));
    const read = async file => JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
    const build = () => promisify(execFile)(process.execPath, [path.join(root, 'scripts/build.mjs')], { cwd: root });
    await write('data/events.json', [fixture]);
    await build();
    const initialIcs = await fs.readFile(path.join(root, 'site/ics/all.ics'), 'utf8');
    assert.equal(initialIcs, renderCalendar([fixture], { name: '米哈游国服 · 全部订阅 · 开始/截止', now: new Date().toISOString() }));
    assert.equal((await read('data/published-nodes.json')).nodes.length, 3);
    await build();
    assert.equal(await fs.readFile(path.join(root, 'site/ics/all.ics'), 'utf8'), initialIcs);
    const child = { ...fixture, id: base.id + ':first', title: '第一期' };
    await write('data/overrides.json', { events: [child], suppressPostIds: [] });
    await build();
    assert.deepEqual((await read('site/data/events.json')).map(event => event.id), [fixture.id, child.id]);
    await write('data/overrides.json', { events: [], suppressPostIds: [] });
    await build();
    await write('data/overrides.json', { events: [], suppressPostIds: ['123'] });
    await build();
    const cancelledIcs = await fs.readFile(path.join(root, 'site/ics/all.ics'), 'utf8');
    assert.deepEqual(uids(cancelledIcs), uids(initialIcs));
    assert.equal((cancelledIcs.match(/STATUS:CANCELLED/g) ?? []).length, 2);
    assert.deepEqual(await read('site/data/events.json'), []);
    const retired = await read('data/published-nodes.json');
    await build();
    assert.deepEqual(await read('data/published-nodes.json'), retired);
    assert.equal(await fs.readFile(path.join(root, 'site/ics/all.ics'), 'utf8'), cancelledIcs);
    const cancelledNew = { ...fixture, id: base.id + ':cancelled-new', cancelled: true };
    await write('data/overrides.json', { events: [child, cancelledNew], replaceParentIds: [fixture.id], suppressPostIds: [] });
    await build();
    assert.deepEqual((await read('site/data/events.json')).map(event => event.id), [child.id]);
    assert.equal((await read('site/data/status.json')).games.genshin.eventCount, 1);
    assert.equal((await read('data/published-nodes.json')).nodes.length, 6);
    const split = await fs.readFile(path.join(root, 'site/ics/all.ics'), 'utf8');
    assert.equal(uids(split).length, 4);
    assert.equal((split.match(/STATUS:CANCELLED/g) ?? []).length, 2);

    const targets = ['data/published-nodes.json', 'site/data/events.json', 'site/data/status.json', 'site/data/review.json', 'site/.nojekyll',
      ...['genshin', 'starrail', 'zzz', 'all'].flatMap(game => [`site/ics/${game}.ics`, `site/ics/${game}-timeline.ics`])];
    const bytesBeforeFailure = new Map(await Promise.all(targets.map(async file => [file, await fs.readFile(path.join(root, file))])));
    await fs.writeFile(path.join(root, 'fail-build.mjs'), `import { build } from './scripts/build.mjs'; const [kind, point] = process.argv.slice(2); await build({ [kind]: Number(point) });`);
    for (const kind of ['failStageAt', 'failCommitAt']) for (let point = 0; point < targets.length; point++) {
      await assert.rejects(promisify(execFile)(process.execPath, [path.join(root, 'fail-build.mjs'), kind, String(point)], { cwd: root }), kind === 'failStageAt' ? /测试暂存故障/ : /测试提交故障/);
      for (const [file, bytes] of bytesBeforeFailure) assert.deepEqual(await fs.readFile(path.join(root, file)), bytes, `${kind}:${point} 后须完整回滚：${file}`);
      assert.deepEqual(await fs.readdir(path.join(root, '.build', 'transactions')), []);
    }

    const ledgerBytes = await fs.readFile(path.join(root, 'data/published-nodes.json'));
    const oneIcs = targets.find(file => file.endsWith('/all.ics'));
    const oneIcsBytes = await fs.readFile(path.join(root, oneIcs));
    await fs.rm(path.join(root, 'data/published-nodes.json'));
    await fs.rm(path.join(root, oneIcs));
    await assert.rejects(build(), /公开ICS基线不完整/);
    await fs.writeFile(path.join(root, 'data/published-nodes.json'), ledgerBytes);
    await fs.writeFile(path.join(root, oneIcs), oneIcsBytes);

    await fs.rm(path.join(root, 'data/published-nodes.json'));
    await assert.rejects(build(), /公开ICS含未映射UID/);
    await fs.writeFile(path.join(root, 'data/published-nodes.json'), ledgerBytes);

    const publicEventsBytes = await fs.readFile(path.join(root, 'site/data/events.json'));
    const publicStatusBytes = await fs.readFile(path.join(root, 'site/data/status.json'));
    await fs.rm(path.join(root, 'data/published-nodes.json'));
    await fs.rm(path.join(root, 'site/data/events.json'));
    await assert.rejects(build(), /公开事件或状态基线缺失/);
    await fs.writeFile(path.join(root, 'site/data/events.json'), publicEventsBytes);
    await fs.rm(path.join(root, 'site/data/status.json'));
    await assert.rejects(build(), /公开事件或状态基线缺失/);
    await fs.writeFile(path.join(root, 'site/data/status.json'), publicStatusBytes);
    await fs.writeFile(path.join(root, 'data/published-nodes.json'), ledgerBytes);

    await fs.writeFile(path.join(root, 'hold-lock.mjs'), `import { withRepositoryLock } from './scripts/build.mjs'; await withRepositoryLock(async () => { console.log('LOCK_HELD'); await new Promise(resolve => setTimeout(resolve, 30000)); });`);
    const holder = spawn(process.execPath, [path.join(root, 'hold-lock.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const holderDone = childResult(holder);
    await waitForOutput(holder, 'LOCK_HELD');
    await assert.rejects(build(), /已有构建持有发布锁/);
    holder.kill('SIGKILL');
    await holderDone;
    await build();

    await fs.mkdir(path.join(root, '.build', 'publish.lock'), { recursive: true });
    await fs.writeFile(path.join(root, '.build', 'publish.lock', 'owner.json'), '{broken');
    const racers = [0, 1].map(() => spawn(process.execPath, [path.join(root, 'hold-lock.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }));
    const racerResults = racers.map(childResult);
    await Promise.race(racers.map(child => waitForOutput(child, 'LOCK_HELD')));
    await new Promise(resolve => setTimeout(resolve, 100));
    const live = racers.filter(child => child.exitCode === null);
    assert.equal(live.length, 1, '损坏旧锁的并发回收者只能有一个进入临界区');
    live[0].kill('SIGKILL');
    const results = await Promise.all(racerResults);
    assert.equal(results.filter(result => result.stdout.includes('LOCK_HELD')).length, 1);
    assert.equal(results.filter(result => /已有构建持有发布锁/.test(result.stderr)).length, 1);
    await build();

    await fs.writeFile(path.join(root, 'unlocked-commit.mjs'), `import { commitRepositoryFiles } from './scripts/build.mjs'; await commitRepositoryFiles(new Map([['site/unlocked.txt', 'forbidden']]));`);
    await assert.rejects(promisify(execFile)(process.execPath, [path.join(root, 'unlocked-commit.mjs')], { cwd: root }), /仓库事务必须在发布锁内执行/);
    assert.equal(await fs.stat(path.join(root, 'site/unlocked.txt')).then(() => true, error => error.code !== 'ENOENT'), false);

    const firstTarget = targets[0];
    const secondTarget = targets[1];
    const firstOriginal = await fs.readFile(path.join(root, firstTarget));
    const secondOriginal = await fs.readFile(path.join(root, secondTarget));
    await fs.writeFile(path.join(root, 'crash-commit.mjs'), `import { withRepositoryLock, commitRepositoryFiles } from './scripts/build.mjs'; await withRepositoryLock(() => commitRepositoryFiles(new Map([['${firstTarget}', 'crash-new-a'], ['${secondTarget}', 'crash-new-b']]), { pauseCommitAt: 0, pauseMs: 30000 }));`);
    const crashing = spawn(process.execPath, [path.join(root, 'crash-commit.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const crashingDone = childResult(crashing);
    await waitForOutput(crashing, 'TEST_COMMIT_PAUSED:0');
    crashing.kill('SIGKILL');
    await crashingDone;
    assert.equal(await fs.readFile(path.join(root, firstTarget), 'utf8'), 'crash-new-a');
    await fs.writeFile(path.join(root, 'recover.mjs'), `import { withRepositoryLock } from './scripts/build.mjs'; await withRepositoryLock(async () => {});`);
    await promisify(execFile)(process.execPath, [path.join(root, 'recover.mjs')], { cwd: root });
    assert.deepEqual(await fs.readFile(path.join(root, firstTarget)), firstOriginal);
    assert.deepEqual(await fs.readFile(path.join(root, secondTarget)), secondOriginal);
    assert.equal(await fs.stat(path.join(root, '.build', 'publish.lock')).then(() => true, error => error.code !== 'ENOENT'), false);
    assert.deepEqual(await fs.readdir(path.join(root, '.build', 'transactions')), []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
