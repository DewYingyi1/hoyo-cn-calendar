import test from 'node:test';
import assert from 'node:assert/strict';
import { renderCalendar, mergeEvents, validateEvent, readableTime } from '../lib/calendar.mjs';
import { parsePost, extractDates, plainText } from '../lib/parser.mjs';

const now = '2026-10-03T01:00:00Z';
const base = { id: 'genshin:miyoushe:123', game: 'genshin', category: 'event', title: '测试,活动;白鳞', start: '2026-10-05T10:00:00+08:00', end: '2026-10-20T03:59:00+08:00', url: 'https://www.miyoushe.com/ys/article/123' };
const saved = () => mergeEvents([], [base], now);
const uids = text => [...text.replace(/\r\n /g, '').matchAll(/^UID:(.+)$/gm)].map(match => match[1]);
test('节点时间转换为UTC；开始和截止各一个', () => {
  const text = renderCalendar(saved(), { name: '测试', now });
  assert.match(text, /DTSTART:20261005T020000Z/);
  assert.match(text, /DTSTART:20261019T195900Z/);
  assert.equal(uids(text).length, 2);
});
test('标题、时间变更保留UID，修订号增加', () => {
  const first = saved();
  const same = mergeEvents(first, [base], '2026-10-04T01:00:00Z');
  assert.deepEqual(first, same);
  const changed = mergeEvents(first, [{ ...base, title: '新标题', end: '2026-10-21T03:59:00+08:00' }], '2026-10-04T01:00:00Z');
  assert.equal(changed[0].sequence, 1);
  assert.deepEqual(uids(renderCalendar(first, { name: '测试', now })), uids(renderCalendar(changed, { name: '测试', now })));
});
test('缺失源不删除已发布事件', () => assert.deepEqual(mergeEvents(saved(), [], now), saved()));
test('时间轴与节点UID隔离', () => {
  assert.equal(uids(renderCalendar(saved(), { name: '测试', mode: 'timeline', now })).length, 1);
  assert.notEqual(uids(renderCalendar(saved(), { name: '测试', mode: 'timeline', now }))[0], uids(renderCalendar(saved(), { name: '测试', now }))[0]);
});
test('UTF8 75字节折行，不切断字符，特殊文本转义', () => {
  const events = mergeEvents([], [{ ...base, title: '龙'.repeat(100) + ',;\\', notes: '第一行\n第二行' }], now);
  const text = renderCalendar(events, { name: '日历', now });
  assert.ok(text.split('\r\n').every(line => Buffer.byteLength(line) <= 75));
  assert.ok(!text.includes('\ufffd'));
  assert.match(text.replace(/\r\n /g, ''), /\\,\\;\\\\/);
});
test('时间倒置和重复ID阻止发布', () => {
  assert.throws(() => mergeEvents([], [{ ...base, end: base.start }], now));
  assert.throws(() => mergeEvents([], [base, base], now));
});
test('仅截止节点不推算版本更新时刻', () => {
  const events = mergeEvents([], [{ ...base, start: null }], now);
  assert.equal(uids(renderCalendar(events, { name: '测试', now })).length, 1);
});
test('订阅说明用中文日期，截止前置，核对笔记不进入弹窗', () => {
  const events = mergeEvents([], [{ ...base, title: '纪行：任务与奖励截止', notes: '官网166259原文，canonical prefix及SHA256人工核对', displayNotes: '任务与奖励截止；购买提前1小时关闭。' }], now);
  const text = renderCalendar(events, { name: '测试', now }).replace(/\r\n /g, '');
  assert.match(text, /SUMMARY:\[原神\] 截止｜纪行：任务与奖励/);
  assert.doesNotMatch(text, /canonical|SHA256|官网166259|T10:00:00\+08:00/);
  assert.match(text, /截止：2026年10月20日 03:59/);
  assert.match(text, /只是占位/);
  assert.match(text, /购买提前1小时关闭/);
  assert.equal(readableTime('2026-12-31T23:59:59+08:00'), '2026年12月31日 23:59:59');
});
test('跨度版不误称15分钟占位，前瞻和维护各用对应语义', () => {
  const timeline = renderCalendar(saved(), { name: '测试', now, mode: 'timeline' }).replace(/\r\n /g, '');
  assert.doesNotMatch(timeline, /15分钟/);
  assert.match(timeline, /时间区间/);
  const livestream = renderCalendar(mergeEvents([], [{ ...base, category: 'livestream', end: null }], now), { name: '测试', now }).replace(/\r\n /g, '');
  assert.match(livestream, /开播：2026年10月05日 10:00/);
  assert.doesNotMatch(livestream, /截止：/);
  const maintenance = renderCalendar(mergeEvents([], [{ ...base, category: 'maintenance' }], now), { name: '测试', now }).replace(/\r\n /g, '');
  assert.match(maintenance, /预计维护结束/);
  assert.match(maintenance, /实际开服以官方通知为准/);
});
test('说明更新保留UID与开始截止，展示修订号增加', () => {
  const first = saved();
  const changed = mergeEvents(first, [{ ...base, displayNotes: '易读说明' }], '2026-10-04T01:00:00Z');
  assert.equal(changed[0].sequence, first[0].sequence + 1);
  const before = renderCalendar(first, { name: '测试', now }).replace(/\r\n /g, '');
  const after = renderCalendar(changed, { name: '测试', now }).replace(/\r\n /g, '');
  assert.deepEqual(uids(before), uids(after));
  assert.deepEqual([...before.matchAll(/DT(?:START|END):(.+)/g)].map(m => m[0]), [...after.matchAll(/DT(?:START|END):(.+)/g)].map(m => m[0]));
  assert.match(before, /SEQUENCE:1/);
  assert.match(after, /SEQUENCE:2/);
});
test('识别标准国服活动时间', () => {
  const parsed = parsePost({ game: 'genshin', id: '123', official: true, title: '「测试」活动说明', published: now, url: base.url, text: '活动时间\n2026/10/05 10:00 ~ 2026/10/20 03:59\n参与条件：冒险等阶20级' });
  assert.equal(parsed.event.start, base.start); assert.equal(parsed.event.end, base.end);
});
test('版本更新后卡池仅生成确定截止', () => {
  const parsed = parsePost({ game: 'starrail', id: '456', official: true, title: '版本活动跃迁', published: now, url: base.url, text: '跃迁时间：版本更新后 - 2026/10/20 03:59\n活动规则' });
  assert.ok(parsed.review, '汇总标题保守审核');
  const single = parsePost({ game: 'starrail', id: '456', official: true, title: '「测试」活动跃迁', published: now, url: base.url, text: '跃迁时间：版本更新后 - 2026/10/20 03:59\n活动规则' });
  assert.equal(single.event.start, null); assert.equal(single.event.end, base.end);
});
test('排除社区杂项，不盲猜维护、多个阶段、未确认作者', () => {
  const post = { game: 'zzz', id: '1', official: true, published: now, url: base.url, text: '活动时间：2026/10/05 10:00 ~ 2026/10/20 03:59' };
  assert.equal(parsePost({ ...post, title: '绘画征集活动' }).ignored, true);
  assert.ok(parsePost({ ...post, title: '版本更新维护通知' }).review);
  assert.ok(parsePost({ ...post, title: '游戏活动说明', official: false }).review);
  assert.ok(parsePost({ ...post, title: '游戏活动说明', text: post.text + '\n奖励领取时间：2026/10/21 03:59' }).review);
});
test('不接受不存在日期；跨年根据公告发布时间判定', () => {
  assert.equal(extractDates('2026/02/30 10:00', now).length, 0);
  assert.equal(extractDates('01/05 10:00', '2026-12-20T01:00:00Z')[0].value, '2027-01-05T10:00:00+08:00');
});
test('Quill delta 与HTML文本规范化', () => {
  assert.equal(plainText('[{"insert":"活动时间\\n"},{"insert":"10:00"}]'), '活动时间\n10:00');
  assert.equal(plainText('<p>活动</p><p>日期&amp;时间</p>'), '活动\n日期&时间\n');
});
test('表情与入口尖括号不吞掉Quill日期文本', () => {
  const text = '预告时间> <\n节目将于9月12日（本周六）20:00正式开启。\n>>立即前往<<';
  assert.equal(plainText(text), text);
});
test('前瞻取正式开播时刻，不取分享奖励或兑换码截止', () => {
  const post = { game: 'genshin', id: '9', official: true, title: '前瞻特别节目预告', published: '2026-09-07T01:00:00Z', url: base.url, text: '特别节目将于9月12日（本周六）20:00正式开启。\n活动时间：9/12-9/14 23:59\n米游社直播间' };
  assert.equal(parsePost(post).event.start, '2026-09-12T20:00:00+08:00');
  const recap = parsePost({ ...post, title: '前瞻特别节目回顾长图', text: '本次兑换码将于2026年9月21日23:59:59失效' });
  assert.equal(recap.ignored, true);
  assert.ok(parsePost({ ...post, text: '特别节目预告\n9/12-9/14 23:59期间分享直播间' }).review);
});
test('限定维护预计结束不混淆预下载', () => {
  const post = { game: 'starrail', id: '8', official: true, title: '版本更新维护通知', published: now, url: base.url, text: '预下载：2026/10/02 14:00\n〓更新时间〓\n2026/10/05 06:00开始，预计5个小时完成。\n其他说明' };
  const parsed = parsePost(post).event;
  assert.equal(parsed.start, '2026-10-05T06:00:00+08:00');
  assert.equal(parsed.end, '2026-10-05T11:00:00+08:00');
  assert.match(parsed.notes, /仅为预计/);
});
test('星铁限时活动期不会写成永久玩法关闭', () => {
  const post = { game: 'starrail', id: '8', official: true, title: '「测试」活动说明', published: now, url: base.url, text: '▌限时活动期\n2026/10/05 版本更新后 - 2026/10/20 03:59\n参与条件：20级\n结束后收录至常时传略' };
  const parsed = parsePost(post).event;
  assert.equal(parsed.start, null);
  assert.equal(parsed.end, base.end);
  assert.match(parsed.notes, /限时活动奖励期/);
});
