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
export function normalizeForum(item, game, config) {
  const post = item.post;
  if (!post || post.is_deleted || post.game_id !== config.gameId || post.f_forum_id !== config.forumId || post.post_status?.is_official !== true || !config.officialUids.includes(String(post.uid))) return null;
  const published = new Date(post.created_at * 1000).toISOString();
  return { game, source: 'miyoushe', id: String(post.post_id), title: post.subject, text: plainText(post.structured_content || post.content), official: true, published, url: `https://www.miyoushe.com/${config.path}/article/${post.post_id}` };
}
export async function fetchForum(game, config) {
  const posts = new Map();
  let cursor = '', scanned = 0, isLast = false;
  for (let page = 0; page < config.pages; page++) {
    const url = new URL('https://bbs-api.miyoushe.com/post/wapi/getForumPostList');
    for (const [key, value] of Object.entries({ forum_id: config.forumId, is_good: false, is_hot: false, page_size: 20, sort_type: 2, ...(cursor ? { last_id: cursor } : {}) })) url.searchParams.set(key, String(value));
    const data = await getJson(url);
    if (!Array.isArray(data.list)) throw new Error('官方列表结构发生变化');
    scanned += data.list.length;
    for (const item of data.list) {
      const post = normalizeForum(item, game, config);
      if (post) posts.set(post.id, post);
    }
    if (data.is_last || !data.list.length || !data.last_id || String(data.last_id) === cursor) { isLast = Boolean(data.is_last); break; }
    cursor = String(data.last_id);
    await sleep(300);
  }
  if (!posts.size) throw new Error('未获取到白名单官方正文，拒绝视为成功');
  return { posts: [...posts.values()], scanned, isLast, coverage: '官方主账号版块向前分页；不包含千星奇域独立账号或社区活动' };
}
export function normalizeWebsite(item, game, config) {
  if (!item.sContent || !item.sTitle || !item.iInfoId) return null;
  const timestamp = item.dtStartTime || item.dtCreateTime;
  const published = new Date(timestamp.replace(' ', 'T') + '+08:00').toISOString();
  return {
    game, source: 'website', id: String(item.iInfoId), title: item.sTitle, text: plainText(item.sContent), official: true, published,
    url: config.website.urlBase + item.iInfoId,
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
