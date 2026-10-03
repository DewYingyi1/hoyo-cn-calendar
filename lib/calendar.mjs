import { createHash } from 'node:crypto';

export const GAMES = {
  genshin: { name: '原神', short: '原神' },
  starrail: { name: '崩坏：星穹铁道', short: '星铁' },
  zzz: { name: '绝区零', short: '绝区零' },
};
export const CATEGORIES = { event: '游戏活动', banner: '卡池', maintenance: '更新维护', livestream: '前瞻' };
export function validateEvent(event) {
  if (!event.id || !GAMES[event.game] || !CATEGORIES[event.category] || !event.title?.trim()) throw new Error('事件基础字段无效');
  if (!/^https:\/\//.test(event.url ?? '')) throw new Error(`事件缺官方出处：${event.id}`);
  if (!event.start && !event.end) throw new Error(`事件没有确定时间：${event.id}`);
  for (const value of [event.start, event.end].filter(Boolean)) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(`非明确国服时间：${event.id}`);
  }
  if (event.start && event.end && Date.parse(event.start) >= Date.parse(event.end)) throw new Error(`时间倒置：${event.id}`);
  if (!Number.isFinite(Date.parse(event.modified))) throw new Error(`缺修改时间：${event.id}`);
  if (!Number.isInteger(event.sequence) || event.sequence < 0) throw new Error(`缺修订序号：${event.id}`);
  return event;
}
export const semanticHash = event => createHash('sha256').update(JSON.stringify([event.game, event.category, event.title, event.start, event.end, event.url, event.notes ?? '', event.cancelled ?? false])).digest('hex');
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
      const description = [
        '国服 · 北京时间 UTC+8；日历应用可能按本地时区显示。',
        `分类：${CATEGORIES[event.category]}`,
        event.start ? `开始：${event.start}` : '开始：尚无确定时刻；不推算“版本更新后”。',
        event.end ? `结束：${event.end}` : '',
        event.notes ?? '',
        '节点版的 15 分钟长度仅用于显示，不是活动持续时间。',
        '谷歌订阅可能延迟刷新；临近截止以官方公告为准。',
        `官方出处：${event.url}`,
      ].filter(Boolean).join('\n');
      lines.push('BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${utc(event.modified)}`, `LAST-MODIFIED:${utc(event.modified)}`, `SEQUENCE:${event.sequence}`, `DTSTART:${utc(node.start)}`, `DTEND:${utc(end)}`, `SUMMARY:${escapeText(`[${GAMES[event.game].short}] ${event.title}${node.label ? ' · ' + node.label : ''}`)}`, `DESCRIPTION:${escapeText(description)}`, `URL:${event.url}`, `CATEGORIES:${escapeText(CATEGORIES[event.category])}`, 'TRANSP:TRANSPARENT', `STATUS:${event.cancelled ? 'CANCELLED' : 'CONFIRMED'}`, 'END:VEVENT');
    }
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
