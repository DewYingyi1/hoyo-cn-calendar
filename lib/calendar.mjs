import { createHash } from 'node:crypto';
import { isExactCNTime, relativeStartAfterEnd } from './time.mjs';

export const GAMES = {
  genshin: { name: '原神', short: '原神' },
  starrail: { name: '崩坏：星穹铁道', short: '星铁' },
  zzz: { name: '绝区零', short: '绝区零' },
};
export const CATEGORIES = { event: '游戏活动', banner: '卡池', maintenance: '更新维护', livestream: '前瞻' };
export function validateEvent(event) {
  if (!event.id || !GAMES[event.game] || !CATEGORIES[event.category] || !event.title?.trim()) throw new Error('事件基础字段无效');
  let location;
  try { location = new URL(event.url); } catch {}
  const officialPath = location && ({
    'ys.mihoyo.com': /^\/main\/news\/detail\/\d+\/?$/,
    'sr.mihoyo.com': /^\/news\/\d+\/?$/,
    'zzz.mihoyo.com': /^\/news\/\d+\/?$/,
    'www.miyoushe.com': /^\/(?:ys|sr|zzz)\/article\/\d+\/?$/,
  })[location.hostname];
  if (typeof event.url !== 'string' || /[\x00-\x20\x7f]/.test(event.url) || location?.protocol !== 'https:' || location.username || location.password || location.port || !officialPath?.test(location.pathname) || location.search || location.hash) throw new Error(`事件缺有效官方出处：${event.id}`);
  if (!event.start && !event.end) throw new Error(`事件没有确定时间：${event.id}`);
  if (event.category === 'livestream' && !event.start) throw new Error(`前瞻缺开播时刻：${event.id}`);
  for (const value of [event.start, event.end].filter(Boolean)) {
    if (!isExactCNTime(value)) throw new Error(`非明确国服时间：${event.id}`);
  }
  if (event.start && event.end && Date.parse(event.start) >= Date.parse(event.end)) throw new Error(`时间倒置：${event.id}`);
  for (const field of ['startText', 'endText']) {
    if (event[field] !== undefined && (typeof event[field] !== 'string' || !event[field].trim() || event[field].length > 160 || /[\r\n]/.test(event[field]))) throw new Error(`非精确时间文案无效：${event.id}:${field}`);
  }
  if (!event.start && relativeStartAfterEnd(event.startText, event.end)) throw new Error(`非精确开始日期无效或晚于截止：${event.id}`);
  if (!Number.isFinite(Date.parse(event.modified))) throw new Error(`缺修改时间：${event.id}`);
  if (!Number.isInteger(event.sequence) || event.sequence < 0) throw new Error(`缺修订序号：${event.id}`);
  return event;
}
export const semanticHash = event => createHash('sha256').update(JSON.stringify([event.game, event.category, event.title, event.start, event.end, event.url, event.notes ?? '', event.displayNotes ?? '', event.startText ?? '', event.endText ?? '', event.cancelled ?? false])).digest('hex');
export function mergeEvents(previous, incoming, now) {
  const merged = new Map(previous.map(event => [event.id, event]));
  const seen = new Set();
  for (const event of incoming) {
    if (seen.has(event.id)) throw new Error(`重复事件 ID：${event.id}`);
    seen.add(event.id);
    const old = merged.get(event.id);
    const hash = semanticHash(event);
    const changed = !old || semanticHash(old) !== hash;
    const saved = { ...event, modified: changed ? now : old.modified, sequence: old ? old.sequence + Number(changed) : 0 };
    validateEvent(saved);
    merged.set(event.id, saved);
  }
  // Missing/failed source responses never imply deletion or cancellation.
  return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
}
const escapeText = value => String(value).replaceAll('\\', '\\\\').replace(/\r?\n/g, '\\n').replaceAll(';', '\\;').replaceAll(',', '\\,');
const utc = value => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
// Presentation-only revision: stable UIDs/dates, but clients must refresh the new titles/descriptions.
const PRESENTATION_REVISION = 2;
const PRESENTATION_CHANGED_AT = '2026-10-03T05:20:00Z';
export function readableTime(value) {
  const date = new Date(Date.parse(value) + 8 * 3600000);
  const pad = number => String(number).padStart(2, '0');
  return `${date.getUTCFullYear()}年${pad(date.getUTCMonth() + 1)}月${pad(date.getUTCDate())}日 ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}${date.getUTCSeconds() ? ':' + pad(date.getUTCSeconds()) : ''}`;
}
export function readerNotes(event) {
  if (typeof event.displayNotes === 'string') return event.displayNotes.trim();
  if (event.category === 'maintenance') return '结束时间为官方预计，实际开服以官方通知为准。';
  if (/限时活动奖励期|常时传略/.test(event.notes ?? '')) return '截止仅针对限时奖励，常驻玩法仍可继续体验。';
  return '';
}
export function describeEvent(event, node) {
  const startLabel = event.category === 'maintenance' ? '维护开始' : event.category === 'livestream' ? '开播' : '开始';
  const endLabel = event.category === 'maintenance' ? '预计维护结束' : '截止';
  const start = `${startLabel}：${event.start ? readableTime(event.start) : event.startText || '官方未公布明确时刻'}`;
  const end = `${endLabel}：${event.end ? readableTime(event.end) : event.endText || '官方未公布明确时刻'}`;
  const period = event.category === 'livestream' ? [start] : node.suffix === 'end' ? [end, start] : [start, end];
  const placeholder = node.suffix !== 'timeline';
  return [
    ...period,
    readerNotes(event) ? `说明：${readerNotes(event)}` : '',
    '',
    '以上均为北京时间（UTC+8）。',
    placeholder ? `这是一条${node.label || '时间节点'}提醒；日历中显示的15分钟只是占位，不是${event.category === 'livestream' ? '节目' : event.category === 'maintenance' ? '维护' : '活动'}时长。` : '本条展示活动时间区间，不是单独的开始或截止提醒。',
    `官方公告：${event.url}`,
  ].join('\n');
}
export function nodeTitle(event, node) {
  const title = event.title.replace(/(?:\s*[·：:]\s*截止|截止)$/, '').trim();
  return `[${GAMES[event.game].short}] ${node.label ? node.label + '｜' : ''}${title}`;
}
export function foldLine(line) {
  let output = '', current = '', bytes = 0;
  for (const char of line) {
    const length = Buffer.byteLength(char);
    if (bytes + length > 75) { output += current + '\r\n'; current = ' '; bytes = 1; }
    current += char; bytes += length;
  }
  return output + current;
}
export function renderCalendar(events, { name, mode = 'nodes', now = new Date().toISOString() }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//DewYingyi1//HoYo CN Calendar//ZH-CN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${escapeText(name)}`, 'X-WR-TIMEZONE:Asia/Shanghai'];
  const cutoff = Date.parse(now) - 120 * 86400000;
  const limit = Date.parse(now) + 366 * 86400000;
  const ids = new Set();
  for (const event of events) {
    validateEvent(event);
    if (ids.has(event.id)) throw new Error(`重复日历 ID：${event.id}`);
    ids.add(event.id);
    if (Date.parse(event.end ?? event.start) < cutoff || Date.parse(event.start ?? event.end) > limit) continue;
    let nodes;
    if (mode === 'timeline' && event.start && event.end) nodes = [{ suffix: 'timeline', label: '', start: event.start, end: event.end }];
    else if (event.category === 'livestream') nodes = [{ suffix: 'start', label: '前瞻开始', start: event.start, end: null }];
    else nodes = [event.start && { suffix: 'start', label: event.category === 'maintenance' ? '维护开始' : '开启', start: event.start }, event.end && { suffix: 'end', label: event.category === 'maintenance' ? '预计维护结束' : '截止', start: event.end }].filter(Boolean);
    for (const node of nodes) {
      if (!node.start) continue;
      const uid = createHash('sha256').update(`${event.id}:${node.suffix}:${mode}`).digest('hex') + '@hoyo-cn-calendar';
      const end = node.end ?? new Date(Date.parse(node.start) + 15 * 60000).toISOString();
      const description = describeEvent(event, node);
      const modified = Date.parse(event.modified) > Date.parse(PRESENTATION_CHANGED_AT) ? event.modified : PRESENTATION_CHANGED_AT;
      lines.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${utc(modified)}`, `LAST-MODIFIED:${utc(modified)}`, `SEQUENCE:${event.sequence + PRESENTATION_REVISION}`, `DTSTART:${utc(node.start)}`, `DTEND:${utc(end)}`, `SUMMARY:${escapeText(nodeTitle(event, node))}`, `DESCRIPTION:${escapeText(description)}`, `URL:${event.url}`, `CATEGORIES:${escapeText(CATEGORIES[event.category])}`, 'TRANSP:TRANSPARENT', `STATUS:${event.cancelled ? 'CANCELLED' : 'CONFIRMED'}`, 'END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
