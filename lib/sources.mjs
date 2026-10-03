import { plainText } from './parser.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function getJson(url) {
  let error;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'hoyo-cn-calendar/0.1 public-announcements', Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = await response.json();
      if (json.retcode !== 0 || !json.data) throw new Error(`来源错误码 ${json.retcode}`);
      return json.data;
    } catch (cause) { error = cause; if (attempt < 2) await sleep(1000 * (attempt + 1)); }
  }
  throw error;
}
export function normalizeWebsite(item, game, config) {
  if (!item.sContent || !item.sTitle || !item.iInfoId) return null;
  const timestamp = item.dtStartTime || item.dtCreateTime;
  const published = new Date(timestamp.replace(' ', 'T') + '+08:00').toISOString();
  return {
    game, source: 'website', id: String(item.iInfoId), title: item.sTitle, text: plainText(item.sContent), official: true, published,
    url: config.website.urlBase + item.iInfoId,
    images: [...new Set([...String(item.sContent).matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(match => match[1]).filter(value => {
      try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && ['mihoyo.com', 'hoyoverse.com'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain)); }
      catch { return false; }
    }))],
  };
}
export async function fetchWebsite(game, config, request = getJson) {
  const website = config.website;
  const failures = [];
  for (const base of [website.base, ...(website.fallbackBases ?? [])]) {
    try {
      const url = `${base}/content_v2_user/app/${website.app}/getContentList?iChanId=${website.channel}&iPageSize=100&iPage=1&sLangKey=zh-cn`;
      const data = await request(url);
      if (!Array.isArray(data.list) || !data.list.length) throw new Error('官网列表无可用正文');
      const posts = data.list.map(item => normalizeWebsite(item, game, config)).filter(Boolean);
      if (!posts.length) throw new Error('官网没有正文');
      return { posts, scanned: data.list.length, endpoint: base, isLast: Number(data.iTotal) <= data.list.length, coverage: '官网综合栏目前100条（含置顶）；非完整历史' };
    } catch (error) { failures.push(`${new URL(base).hostname}：${error.message}`); }
  }
  throw new Error(failures.join('；'));
}
