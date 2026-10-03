import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent, renderCalendar, mergeEvents } from '../lib/calendar.mjs';
import { extractDates, parsePost } from '../lib/parser.mjs';
import { isExactCNTime, hasUnsupportedTimezone } from '../lib/time.mjs';
import { updateReview, retainReviews } from '../lib/review-state.mjs';

const now = '2026-10-03T01:00:00Z';
const event = { id: 'genshin:website:1', game: 'genshin', category: 'event', title: '测试活动', start: '2026-10-05T10:00:00+08:00', end: '2026-10-20T03:59:00+08:00', url: 'https://ys.mihoyo.com/main/news/detail/1', modified: now, sequence: 0 };
const post = { game: 'genshin', source: 'website', id: '1', official: true, title: '「测试」活动说明', published: now, url: event.url, text: '活动时间：2026/10/05 10:00 ~ 2026/10/20 03:59\n参与条件：冒险等阶20级' };

test('发布入口拒绝日期归一化：非闰年、越界月份日期与24点', () => {
  for (const value of ['2026-02-30T10:00:00+08:00', '2026-02-29T10:00:00+08:00', '2026-04-31T10:00:00+08:00', '2026-10-05T24:00:00+08:00', '2026-10-05T10:60:00+08:00']) {
    assert.equal(isExactCNTime(value), false);
    assert.throws(() => validateEvent({ ...event, start: value, end: null }), /非明确国服时间/);
    assert.throws(() => renderCalendar([{ ...event, start: value, end: null }], { name: '测试', now }), /非明确国服时间/);
  }
});
test('发布入口支持真实闰年与远期日期，不套公告距离限制', () => {
  assert.equal(isExactCNTime('2028-02-29T00:00:00+08:00'), true);
  assert.doesNotThrow(() => validateEvent({ ...event, start: '2028-02-29T00:00:00+08:00', end: null }));
});
test('前瞻不能只给结束；明确开播只生成一个节点', () => {
  assert.throws(() => validateEvent({ ...event, category: 'livestream', start: null }), /前瞻缺开播/);
  const text = renderCalendar([{ ...event, category: 'livestream', end: null }], { name: '测试', now });
  assert.equal((text.match(/BEGIN:VEVENT/g) ?? []).length, 1);
});
test('官方出处拒绝CRLF、外站、伪子域、凭据和非公告路径', () => {
  for (const url of [event.url + '\r\nSTATUS:CANCELLED', event.url + '\t', 'https://example.com/1', 'https://ys.mihoyo.com.evil.test/main/news/detail/1', 'https://name@ys.mihoyo.com/main/news/detail/1', 'https://ys.mihoyo.com/main/news/detail/1?redirect=1', 'https://ys.mihoyo.com/', 'http://ys.mihoyo.com/main/news/detail/1']) assert.throws(() => validateEvent({ ...event, url }), /有效官方出处/);
});
test('官方出处兼容历史米游社公告，不改变UID和来源', () => {
  for (const url of [event.url, 'https://sr.mihoyo.com/news/1', 'https://zzz.mihoyo.com/news/1', 'https://www.miyoushe.com/ys/article/1', 'https://www.miyoushe.com/sr/article/1', 'https://www.miyoushe.com/zzz/article/1']) assert.doesNotThrow(() => validateEvent({ ...event, url }));
});
test('下午与晚上12小时制正确换算；已有24小时制不重复加12', () => {
  for (const period of ['下午8:00', '晚上8:00', '晚8:00', '下午20:00', '晚上20:00']) assert.equal(extractDates('2026/10/05 ' + period, now)[0].value, '2026-10-05T20:00:00+08:00');
  for (const period of ['下午2:00', '下午14:00']) assert.equal(extractDates('2026/10/05 ' + period, now)[0].value, '2026-10-05T14:00:00+08:00');
  // Informal “下午8点” has a clear PM reading, despite being late in the day.
  assert.equal(parsePost({ ...post, text: post.text.replace('10:00', '下午8:00') }).event.start, '2026-10-05T20:00:00+08:00');
});
test('上午、凌晨与中午保守处理，含糊的晚上12点不自动推定', () => {
  for (const [period, hour] of [['上午8:00', '08'], ['早上8:00', '08'], ['凌晨0:00', '00'], ['中午12:00', '12'], ['下午12:00', '12']]) assert.equal(extractDates('2026/10/05 ' + period, now)[0].value, `2026-10-05T${hour}:00:00+08:00`);
  for (const period of ['晚上12:00', '上午20:00', '下午0:00', '凌晨8:00', '中午1:00', '晚上1:00', '傍晚1:00', '傍晚13:00']) assert.equal(extractDates('2026/10/05 ' + period, now).length, 0);
  assert.equal(extractDates('2026/10/05 傍晚6:00', now)[0].value, '2026-10-05T18:00:00+08:00');
});
test('前瞻晚上8点不误读为早上8点', () => {
  const parsed = parsePost({ ...post, title: '前瞻特别节目预告', text: '节目将于2026年10月5日晚上8:00正式开启。' });
  assert.equal(parsed.event.start, '2026-10-05T20:00:00+08:00');
});
test('明确非北京时间送审，不强行写UTC+8', () => {
  for (const timezone of ['UTC+9', 'UTC+8:30', 'UTC-8', 'GMT+0', '日本时间', 'JST', '当地时间']) {
    const text = post.text + `（${timezone}）`;
    assert.equal(hasUnsupportedTimezone(text), true);
    assert.equal(extractDates(text, now).length, 0);
    assert.match(parsePost({ ...post, text }).review.reason, /时区/);
  }
  for (const timezone of ['UTC+8', 'UTC+08:00', 'GMT+8', '北京时间']) assert.ok(parsePost({ ...post, text: post.text + `（${timezone}）` }).event);
});
test('版本更新后日期晚于截止或本身不存在时送审，最终入口也拒绝', () => {
  for (const date of ['2026/11/01', '2026/09/31']) {
    const startText = `${date} 版本更新后`;
    const parsed = parsePost({ ...post, text: `活动时间：${startText} - 2026/10/20 03:59\n参与条件：20级` });
    assert.match(parsed.review.reason, /开始日期/);
    assert.throws(() => validateEvent({ ...event, start: null, startText }), /非精确开始日期/);
  }
});
test('版本更新后同一天不猜具体小时，原文与仅截止保留', () => {
  const parsed = parsePost({ ...post, text: '活动时间：2026/10/20 7.1版本更新后 - 2026/10/20 23:59\n参与条件：20级' });
  assert.equal(parsed.event.start, null);
  assert.equal(parsed.event.startText, '2026/10/20 7.1版本更新后');
});
test('取消、延期与暂停优先送审；不静默覆盖已发布事件', () => {
  for (const words of ['本次活动已取消，以上为原定时间。', '本次活动推迟开放。', '本次活动延期。', '本次活动暂停开放。', '日程以新公告为准。']) assert.ok(parsePost({ ...post, text: post.text + '\n' + words }).review);
  assert.ok(parsePost({ ...post, text: '本次活动已取消。' }).review);
  const saved = mergeEvents([], [event], now);
  assert.deepEqual(mergeEvents(saved, [], now), saved);
});
test('只有图片的活动进入读图审核，明确排除的网页/社区推广仍忽略', () => {
  assert.match(parsePost({ ...post, text: '', images: ['https://fastcdn.mihoyo.com/test.png'] }).review.reason, /读图/);
  for (const title of ['网页活动', '绘画征集活动', '音乐平台活动']) assert.equal(parsePost({ ...post, title, text: '', images: ['https://fastcdn.mihoyo.com/test.png'] }).ignored, true);
});
test('独立时段相同的多个卡池不能去重成一条自动事件', () => {
  const parsed = parsePost({ ...post, title: '限时调频活动', text: '角色调频\n调频时间：2026/10/05 10:00 ~ 2026/10/20 03:59\n角色说明\n音擎调频\n调频时间：2026/10/05 10:00 ~ 2026/10/20 03:59\n音擎说明' });
  assert.match(parsed.review.reason, /独立子活动/);
});
test('不完整日期的阶段也送审，不靠完整时刻数量决定', () => {
  const parsed = parsePost({ ...post, text: post.text + '\n第二阶段：10月10日开启' });
  assert.match(parsed.review.reason, /分阶段/);
});
test('版本说明可同时有维护事件与其他活动待审，不吞掉审核项', () => {
  const parsed = parsePost({ ...post, title: '4.7版本更新说明', text: '更新时间\n2026/10/05 06:00开始，预计5个小时完成。\n「新活动」\n活动时间：2026/10/10 12:00 - 2026/10/20 03:59\n参与条件：20级' });
  assert.equal(parsed.event.category, 'maintenance');
  assert.equal(parsed.event.start, '2026-10-05T06:00:00+08:00');
  assert.match(parsed.review.reason, /拆分审核/);
  const reviews = new Map();
  updateReview(reviews, event.id, parsed, { source: 'website', now });
  assert.equal(reviews.get(event.id).resolved, false);
});
test('未解决审核超过100天仍保留，只有已解决旧记录可清理', () => {
  const old = { firstSeenAt: '2026-01-01T00:00:00Z', resolved: false };
  assert.deepEqual(retainReviews([old, { ...old, resolved: true }], now), [old]);
  assert.equal(retainReviews([{ resolved: false }], now).length, 1);
});
test('分类忽略不清未解决审核；重新发现保持首次日期并记录最近看到', () => {
  const old = { firstSeenAt: '2026-01-01T00:00:00Z', resolved: false, reason: '待核对' };
  const reviews = new Map([[event.id, old]]);
  updateReview(reviews, event.id, { ignored: true }, { source: 'website', now });
  assert.equal(reviews.get(event.id).firstSeenAt, old.firstSeenAt);
  assert.equal(reviews.get(event.id).lastSeenAt, now);
  updateReview(reviews, event.id, { review: { reason: '新证据待核对' } }, { source: 'website', now });
  assert.equal(reviews.get(event.id).firstSeenAt, old.firstSeenAt);
  updateReview(reviews, event.id, { event }, { source: 'website', now });
  assert.equal(reviews.has(event.id), false);
});
