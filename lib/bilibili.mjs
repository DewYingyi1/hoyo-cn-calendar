import { extractDates, plainText } from './parser.mjs';

// Identity is pinned to the CN publisher accounts, never to a display name or badge.
const OFFICIAL_UIDS = Object.freeze({ genshin: '401742377', starrail: '1340190821', zzz: '1636034895' });
const API = 'https://api.bilibili.com';
const DAY = 86400000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const notice = /前瞻|特别节目/;
const retrospective = /回放|重播|录播|录像|回顾|情报总览|内容汇总|精彩(?:内容|片段)|全程|完整版|切片|兑换码汇总|现已结束/;
const riskCodes = new Set([-352, -412, -799, -509, -101]);
const clean = value => plainText(value).normalize('NFKC').replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim();
const bounded = (value, fallback, max) => Number.isInteger(value) && value >= 0 ? Math.min(value, max) : fallback;

function error(message, blocked = false) {
  const result = new Error(`B站：${message}`);
  result.blocked = blocked;
  return result;
}

/** One anonymous request, no Cookie, signing service, CAPTCHA handling or retry. */
export async function getBilibiliJson(url, { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const target = new URL(url);
  if (target.origin !== API) throw error('只允许官方公开 API');
  let response;
  try {
    response = await fetchImpl(target, {
      headers: { 'User-Agent': 'hoyo-cn-calendar/0.1 public-announcements', Accept: 'application/json' },
      signal: AbortSignal.timeout(Math.max(1000, Math.min(timeoutMs, 20000))),
      redirect: 'error',
    });
  } catch (cause) { throw error(`请求失败（${cause.name}）：${cause.message}`); }
  if (!response.ok) throw error(`HTTP ${response.status}`, [401, 403, 412, 429].includes(response.status));
  let json;
  try { json = await response.json(); } catch { throw error('API 返回非 JSON，未取得正文', true); }
  if (json.code !== 0 || !json.data) throw error(`API ${json.code}：${json.message ?? json.msg ?? '无正文'}`, riskCodes.has(json.code));
  return json.data;
}

function trusted(game, config, uid) {
  return String(uid ?? '') === OFFICIAL_UIDS[game] && config.officialUids?.includes(String(uid));
}

function publishedAt(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function imageUrl(value) {
  try {
    const url = new URL(String(value).replace(/^\/\//, 'https://'));
    return ['http:', 'https:'].includes(url.protocol) && /(^|\.)hdslb\.com$/.test(url.hostname) ? url.href : null;
  } catch { return null; }
}

/** Only explicit broadcast clauses; publish/upload, version release and lottery dates are not schedules. */
export function extractBilibiliLivestreamTimes(text, published) {
  const value = clean(text);
  const dates = extractDates(value, published);
  return [...new Set(dates.filter(date => {
    // Do not silently treat an unconverted “晚上7:30” as 07:30 Beijing time.
    if (/(?:下午|晚上|晚)\s*(?:[1-9]|1[01])[:：]/.test(value.slice(date.index, date.index + date.length))) return false;
    // A punctuation boundary prevents a previous sentence's “前瞻” authorising a lottery date.
    const before = value.slice(Math.max(0, date.index - 160), date.index).split(/[。！？!?;；\n]/).at(-1);
    const after = value.slice(date.index + date.length, date.index + date.length + 70).split(/[。！？!?;；\n]/)[0];
    if (/抽奖|开奖|中奖|兑换|失效|截止|上传|投稿|回放|上线|更新维护|预告(?:片|视频)?将于|PV将于|视频将于/.test(before + after)) return false;
    if (/时区|UTC|GMT/.test(after) && !/(?:UTC|GMT)\s*\+\s*8|北京时间/.test(after)) return false;
    if (/(?:直播|播出|开播|特别节目|前瞻)(?:时间|时刻)[\s:]*$/.test(before)) return true;
    return /将于\s*$/.test(before) && /前瞻|特别节目|直播/.test(before)
      && /^\s*(?:正式|准时|在[^。\n]{0,25})*(?:播出|开播|开启(?:直播)?|开始直播)/.test(after);
  }).map(date => date.value))];
}

function versionMatches(title, config) {
  if (!config.currentVersion) return true;
  const version = clean(config.currentVersion), value = clean(title);
  if (!/^\d+\.\d+$/.test(version)) return value.includes(version);
  return [...value.matchAll(/\d+\.\d+/g)].some(match => match[0] === version);
}

/** Recent upcoming notices; past broadcasts require an explicitly supplied currentVersion. */
export function isBilibiliLivestreamNotice(post, config, now = Date.now()) {
  const title = clean(post.title), text = clean(post.text);
  if (!notice.test(title) || retrospective.test(title) || !versionMatches(title, config)) return false;
  if (/回顾本次|本次特别节目中的兑换码|特别节目已(?:经)?(?:结束|播出)|现已结束/.test(text)) return false;
  const timestamp = Date.parse(post.published), current = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(timestamp) || !Number.isFinite(current) || timestamp > current + DAY || timestamp < current - bounded(config.lookbackDays, 45, 60) * DAY) return false;
  const dates = extractBilibiliLivestreamTimes(text, post.published);
  if (dates.length) return dates.some(date => {
    const time = Date.parse(date);
    return time >= timestamp - DAY && time <= timestamp + 45 * DAY
      && (time >= current - DAY || Boolean(config.currentVersion));
  });
  // A poster-only announcement is retained for review, without inventing an OCR time.
  return Boolean(post.images?.length) && extractDates(text, post.published).length === 0 && timestamp >= current - 14 * DAY
    && (/预告|直播预约|敬请期待/.test(title + '\n' + text)
      || /(?:前瞻|特别节目|直播)[^。！？\n]{0,30}(?:将于|即将(?:播出|开启|开播))/.test(text))
    && !/抽奖|开奖|兑换|失效|截止/.test(title);
}

function candidate(post, config, now) {
  if (!isBilibiliLivestreamNotice(post, config, now)) return null;
  const dates = extractBilibiliLivestreamTimes(post.text, post.published);
  // Keep the original body, and expose the unique official clause in the parser's syntax.
  // No date is taken from API pubdate/ctime, reserve cards, images, or a video player.
  if (dates.length) {
    if (dates.length === 1) post.livestreamStart = dates[0];
    for (const date of dates) {
      const time = date.replace('T', ' ').replace('+08:00', '');
      post.text += `\n【官方正文播出时间规范化】前瞻特别节目将于${time}正式播出。`;
    }
  }
  return post;
}

export function normalizeBilibiliDynamic(item, game, config, now = Date.now()) {
  const author = item?.modules?.module_author, dynamic = item?.modules?.module_dynamic;
  if (!trusted(game, config, author?.mid) || !dynamic || item.orig || item.type === 'DYNAMIC_TYPE_FORWARD' || typeof item.id_str !== 'string' || !/^\d+$/.test(item.id_str)) return null;
  const opus = dynamic.major?.opus, archive = dynamic.major?.archive;
  const description = clean(dynamic.desc?.text || opus?.summary?.text || '');
  const text = [description, clean(archive?.desc ?? '')].filter(Boolean).join('\n');
  const lines = description.split('\n').map(line => line.replace(/#[^#\n]+#/g, '').trim()).filter(Boolean);
  const title = clean(opus?.title || archive?.title || lines.find(line => /前瞻/.test(line)) || lines.find(line => notice.test(line)) || lines[0] || '');
  const published = publishedAt(author.pub_ts);
  if (!published || !title) return null;
  const pictures = [...(opus?.pics ?? []), ...(dynamic.major?.draw?.items ?? [])];
  const images = [...new Set(pictures.map(pic => imageUrl(pic.url ?? pic.src)).filter(Boolean))];
  return candidate({ game, source: 'bilibili', id: `dynamic-${item.id_str}`, title, text, published,
    url: `https://www.bilibili.com/opus/${item.id_str}`, official: true, ...(images.length ? { images } : {}) }, config, now);
}

export function normalizeBilibiliVideo(item, game, config, now = Date.now()) {
  if (!trusted(game, config, item?.owner?.mid) || !/^BV[0-9A-Za-z]{10}$/.test(item.bvid ?? '')) return null;
  const published = publishedAt(item.pubdate);
  if (!published) return null;
  return candidate({ game, source: 'bilibili', id: `video-${item.bvid}`, title: clean(item.title), text: clean(item.desc), published,
    url: `https://www.bilibili.com/video/${item.bvid}/`, official: true }, config, now);
}

/**
 * config is sources/bilibili.json[game], not the MiYouShe UID configuration.
 * Optional currentVersion restricts notices to that version (e.g. '4.6' / '月之三').
 * dependencies permits fixture-only tests. request(url) must return API data, not the envelope.
 * Risk/authentication errors terminate immediately; fallback never solves or evades a challenge.
 */
export async function fetchBilibili(game, config, dependencies = {}) {
  if (!OFFICIAL_UIDS[game] || !Array.isArray(config?.officialUids) || config.officialUids.length !== 1 || config.officialUids[0] !== OFFICIAL_UIDS[game]) throw error('官方 UID 白名单与已核实国服账号不符');
  const request = dependencies.request ?? (url => getBilibiliJson(url, { timeoutMs: config.timeoutMs }));
  const pause = dependencies.sleep ?? sleep;
  const now = dependencies.now ?? Date.now();
  const uid = OFFICIAL_UIDS[game], posts = new Map(), failures = [];
  let scanned = 0, dynamicScanned = 0, videoScanned = 0, requests = 0, dynamicComplete = false, details = 0;
  const ask = async (path, params) => {
    if (requests++) await pause(500);
    const url = new URL(path, API);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    return request(url.href);
  };
  try {
    let offset = '';
    const offsets = new Set();
    for (let page = 0; page < bounded(config.dynamicPages, 3, 5); page++) {
      const data = await ask('/x/polymer/web-dynamic/v1/feed/space', { host_mid: uid, ...(offset ? { offset } : {}) });
      if (!Array.isArray(data.items) || data.has_more === undefined) throw error('动态列表结构发生变化');
      scanned += data.items.length; dynamicScanned += data.items.length;
      for (const item of data.items) {
        const post = normalizeBilibiliDynamic(item, game, config, now);
        if (post) posts.set(post.id, post);
      }
      dynamicComplete = true;
      if (!data.has_more || !data.items.length) break;
      if (!data.offset || offsets.has(String(data.offset))) throw error('动态分页游标缺失或循环');
      offset = String(data.offset); offsets.add(offset);
    }
  } catch (cause) {
    if (cause.blocked) throw cause;
    failures.push(`动态：${cause.message}`);
  }
  // Dynamic text is preferred. Video listing is only a secondary public source.
  let videoComplete = false;
  if (!posts.size) {
    try {
      for (let page = 1; page <= bounded(config.videoPages, 2, 3); page++) {
        const data = await ask('/x/space/arc/search', { mid: uid, pn: page, ps: 30, order: 'pubdate' });
        if (!Array.isArray(data.list?.vlist)) throw error('视频列表结构发生变化');
        scanned += data.list.vlist.length; videoScanned += data.list.vlist.length;
        for (const item of data.list.vlist) {
          if (!trusted(game, config, item.mid) || !notice.test(clean(item.title)) || retrospective.test(clean(item.title))) continue;
          const published = publishedAt(item.created);
          if (!published || Date.parse(published) < new Date(now).getTime() - bounded(config.lookbackDays, 45, 60) * DAY) continue;
          if (!versionMatches(item.title, config) || !/^BV[0-9A-Za-z]{10}$/.test(item.bvid ?? '')) continue;
          if (details >= bounded(config.maxVideoDetails, 6, 10)) break;
          details++;
          const detail = await ask('/x/web-interface/view', { bvid: item.bvid });
          if (detail.bvid !== item.bvid) throw error('视频详情与列表 ID 不符');
          const post = normalizeBilibiliVideo(detail, game, config, now);
          if (post) posts.set(post.id, post);
        }
        videoComplete = true;
        if (data.list.vlist.length < 30 || details >= bounded(config.maxVideoDetails, 6, 10)) break;
      }
    } catch (cause) {
      if (cause.blocked) throw cause;
      failures.push(`视频：${cause.message}`);
    }
  }
  if (!dynamicComplete && !videoComplete) throw error(failures.join('；') || '未执行任何公开来源请求');
  return { posts: [...posts.values()], scanned,
    coverage: `国服白名单 UID ${uid}；动态扫描 ${dynamicScanned} 条，视频扫描 ${videoScanned} 条/正文 ${details} 条；近${bounded(config.lookbackDays, 45, 60)}天前瞻预告，${config.currentVersion ? `限定${config.currentVersion}版本` : '仅即将播出或24小时内播出'}；有限分页，非完整历史；图片仅保留引用，不做OCR${failures.length ? `；部分失败：${failures.join('；')}` : ''}`,
    ...(failures.length ? { errors: failures } : {}) };
}
