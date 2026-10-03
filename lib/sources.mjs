import { plainText } from './parser.mjs';
import { isOfficialImageURL } from './image-evidence.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const sourceError = code => new Error(code);
const SAFE_SOURCE_FAILURE = /^(?:[a-z0-9.-]+：source-(?:http|format|size|response|timeout|fetch|invalid))(?:；[a-z0-9.-]+：source-(?:http|format|size|response|timeout|fetch|invalid))*$/;
export const publicSourceError = error => SAFE_SOURCE_FAILURE.test(error?.message ?? '') ? error.message : 'source-processing';
export async function getJson(url) {
  let error;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'hoyo-cn-calendar/0.1 public-announcements', Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(20000) });
      if (!response.ok || response.redirected) throw sourceError('source-http');
      const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
      if (type !== 'application/json') throw sourceError('source-format');
      if (Number(response.headers.get('content-length')) > MAX_JSON_BYTES) throw sourceError('source-size');
      const bytes = await response.arrayBuffer();
      if (!bytes.byteLength || bytes.byteLength > MAX_JSON_BYTES) throw sourceError(bytes.byteLength ? 'source-size' : 'source-format');
      let json;
      try { json = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw sourceError('source-format'); }
      if (json.retcode !== 0 || !json.data) throw sourceError('source-response');
      return json.data;
    } catch (cause) {
      error = /^source-(?:http|format|size|response)$/.test(cause?.message) ? cause : sourceError(cause?.name === 'TimeoutError' ? 'source-timeout' : 'source-fetch');
      if (attempt < 2) await sleep(1000 * (attempt + 1));
    }
  }
  throw error;
}
export function websitePublished(timestamp) {
  if (typeof timestamp !== 'string') throw new Error('公告发布时间无效');
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(timestamp.trim());
  if (!match) throw new Error('公告发布时间无效');
  const [, year, month, day, hour, minute, seconds = '00', fraction = '', offset = '+08:00'] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (m < 1 || m > 12 || d < 1 || d > days[m - 1] || Number(hour) > 23 || Number(minute) > 59 || Number(seconds) > 59
    || (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(-2)) > 59))) throw new Error('公告发布时间无效');
  const zone = offset === 'Z' ? offset : offset.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${seconds}${fraction}${zone}`);
  if (!Number.isFinite(date.getTime())) throw new Error('公告发布时间无效');
  return date.toISOString();
}

export function normalizeWebsite(item, game, config) {
  if (!item || typeof item !== 'object') throw new Error('公告记录无效');
  if (!item.sContent || !item.sTitle || !item.iInfoId) return null;
  if (!/^\d+$/.test(String(item.iInfoId)) || typeof item.sTitle !== 'string' || typeof item.sContent !== 'string') throw new Error('公告记录无效');
  const text = plainText(item.sContent);
  const images = [...new Set([...String(item.sContent).matchAll(/<img\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(match => match[1]).filter(isOfficialImageURL))];
  if (!text.trim() && !images.length) return null;
  const published = websitePublished(item.dtStartTime || item.dtCreateTime);
  return {
    game, source: 'website', id: String(item.iInfoId), title: item.sTitle, text, official: true, published,
    url: config.website.urlBase + item.iInfoId,
    images,
  };
}
export async function fetchWebsite(game, config, request = getJson) {
  const website = config.website;
  const failures = [];
  for (const base of [website.base, ...(website.fallbackBases ?? [])]) {
    try {
      const url = `${base}/content_v2_user/app/${website.app}/getContentList?iChanId=${website.channel}&iPageSize=100&iPage=1&sLangKey=zh-cn`;
      const data = await request(url);
      if (!Array.isArray(data.list)) throw new Error('官网列表结构无效');
      const posts = [], qualityIssues = [];
      let filtered = 0;
      for (const [index, item] of data.list.entries()) {
        try {
          const post = normalizeWebsite(item, game, config);
          if (post) posts.push(post);
          else filtered++;
        } catch {
          // Bad records must not discard other valid announcements or print raw content.
          qualityIssues.push({ source: 'website', index, postId: /^\d+$/.test(String(item?.iInfoId)) ? String(item.iInfoId) : null, reason: '公告记录或发布时间无效，已逐条隔离' });
        }
      }
      const seen = new Set();
      for (const post of posts) {
        if (seen.has(post.id)) throw new Error('官网列表含重复公告ID');
        seen.add(post.id);
      }
      return { posts, qualityIssues, filtered, scanned: data.list.length, endpoint: base, isLast: Number(data.iTotal) <= data.list.length, coverage: '官网综合栏目前100条（含置顶）；非完整历史' };
    } catch (error) {
      const safe = /^source-(?:http|format|size|response|timeout|fetch)$/.test(error?.message) ? error.message : 'source-invalid';
      failures.push(`${new URL(base).hostname}：${safe}`);
    }
  }
  throw new Error(failures.join('；'));
}
