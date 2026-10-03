// Final publication validation, without the parser's announcement-distance heuristic.
export function isExactCNTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(value)) return false;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return false;
  return new Date(millis + 8 * 3600000).toISOString() === value.slice(0, 19) + '.000Z';
}

export function hasUnsupportedTimezone(text) {
  for (const match of String(text).matchAll(/(?:UTC|GMT)\s*([+＋\-－−])\s*(\d{1,2})(?:[:：](\d{2}))?/gi)) {
    if (!/[+＋]/.test(match[1]) || Number(match[2]) !== 8 || Number(match[3] ?? 0) !== 0) return true;
  }
  return /(?:UTC|GMT)\s*[)）]|日本时间|东京时间|韩国时间|太平洋时间|美国东部时间|欧洲中部时间|服务器当地时间|当地时间|\b(?:JST|KST|PST|PDT|EST|EDT|CET|CEST)\b/i.test(String(text));
}

export function relativeStartAfterEnd(startText, end) {
  if (!startText || !isExactCNTime(end)) return false;
  // Compare only explicitly written dates; never invent an opening hour or year.
  const match = /(?<!\d)(\d{4})\s*(?:\/|\.|-|年)\s*(\d{1,2})\s*(?:\/|\.|-|月)\s*(\d{1,2})(?!\d)/.exec(startText);
  if (!match) return false;
  const date = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  return !isExactCNTime(date + 'T00:00:00+08:00') || date > end.slice(0, 10);
}
