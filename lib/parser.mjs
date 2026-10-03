import { createHash } from 'node:crypto';

export function plainText(content) {
  let text = String(content ?? '');
  // MiYouShe structured content is a Quill delta, not necessarily HTML.
  try {
    const value = JSON.parse(text);
    const ops = Array.isArray(value) ? value : value.ops;
    if (Array.isArray(ops)) text = ops.map(item => {
      if (typeof item.insert === 'string') return item.insert;
      if (item.insert?.fold) return '\n' + plainText(item.insert.fold.title) + '\n' + plainText(item.insert.fold.content) + '\n';
      if (item.insert?.backup_text) return plainText(item.insert.backup_text);
      return '\n';
    }).join('');
  } catch {}
  return text.replace(/<br\s*\/?\s*>|<\/p>|<\/div>/gi, '\n').replace(/<\/?[a-z][a-z0-9]*(?:\s+[^<>]*?)?\s*\/?>/gi, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\r/g, '').replace(/[\u200b\ufeff]/g, '');
}
export function classify(title, text) {
  const combined = `${title}\n${text}`;
  if (/绘画|征集|创作激励|创作者激励|同人|周边|米游币|抽抽乐|签到赢|线下|摄影|有奖|社区活动|回顾长图|回顾视频|网页活动|云游戏|云·|联名活动|音乐平台活动|微博专属|听歌领|音乐.*主题活动/.test(title)) return null;
  if (/前瞻|特别节目/.test(title) && /预告|将于/.test(title + text.slice(0, 350)) && !/现已结束|兑换码将于/.test(text.slice(0, 350))) return 'livestream';
  if (/更新维护|停服维护|版本更新通知|版本更新说明/.test(title)) return 'maintenance';
  if (/自选邀请/.test(title) && /活动时间/.test(text)) return 'event';
  if (/祈愿|跃迁|调频|频段/.test(title) && /活动|概率|限时/.test(combined)) return 'banner';
  if (/活动/.test(title) && /活动时间|活动期间|开启时间|参与条件/.test(text)) return 'event';
  // Official website titles sometimes omit the forum's “活动说明” suffix.
  if (/限时活动期/.test(text) || (/活动时间/.test(text) && /参与条件|开拓等级|冒险等阶|绳网等级|无名勋礼|丽都城募/.test(combined))) return 'event';
  return null;
}
const datePattern = /(?:(\d{4})\s*(?:\/|\.|-|年)\s*)?(\d{1,2})\s*(?:\/|\.|-|月)\s*(\d{1,2})\s*日?\s*(?:\([^)]*\)|（[^）]*）)?\s*(?:晚上|晚|上午|下午)?\s*(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?/g;
export const postDigest = post => createHash('sha256').update(post.title + '\n' + plainText(post.text)).digest('hex');
export const imageDigest = post => createHash('sha256').update(JSON.stringify(post.images ?? [])).digest('hex');
export function extractDates(text, published) {
  const year = new Date(published).getUTCFullYear();
  const dates = [];
  for (const match of text.matchAll(datePattern)) {
    const month = Number(match[2]), day = Number(match[3]), hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6] ?? 0);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) continue;
    const candidates = match[1] ? [Number(match[1])] : [year - 1, year, year + 1];
    const values = candidates.map(y => `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}+08:00`)
      .filter(value => {
        const parsed = new Date(Date.parse(value) + 8 * 3600000);
        return Number.isFinite(parsed.getTime()) && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
      }).sort((a, b) => Math.abs(Date.parse(a) - Date.parse(published)) - Math.abs(Date.parse(b) - Date.parse(published)));
    const value = values[0];
    if (!value || Math.abs(Date.parse(value) - Date.parse(published)) > 200 * 86400000) continue;
    dates.push({ value, index: match.index, length: match[0].length, explicitYear: Boolean(match[1]) });
  }
  return dates;
}
export function parsePost(post) {
  const text = plainText(post.text);
  const category = classify(post.title, text);
  if (!category) return { ignored: true };
  const digest = postDigest(post);
  const review = reason => ({ review: { game: post.game, postId: post.id, title: post.title, url: post.url, reason, digest } });
  if (!post.official) return review('未确认官方作者，不自动收录');
  if (/将关闭.{0,100}购买/.test(text)) return review('活动截止与购买截止不同，需要拆分审核');
  if (/活动汇总|活动一览|版本活动|玩法结束|领奖时间|奖励领取时间|兑换截止/.test(post.title + '\n' + text)) return review('汇总或存在多个截止语义，需要拆分审核');
  const dates = extractDates(text, post.published);
  let start = null, end = null, startText = '', notes = '';
  if (category === 'livestream') {
    const broadcastDates = dates.filter(date => {
      const before = text.slice(Math.max(0, date.index - 100), date.index);
      const after = text.slice(date.index + date.length, date.index + date.length + 40);
      return /将于\s*$/.test(before) && /^\s*(?:正式)?(?:开启|播出|开播)/.test(after) && !/兑换码|失效|奖励|抽奖/.test(before.slice(-25));
    });
    const unique = [...new Set(broadcastDates.map(date => date.value))];
    if (unique.length !== 1) return review('前瞻时刻未唯一确定');
    [start] = unique;
  } else if (category === 'maintenance') {
    const maintenance = /(?:更新时间|维护时间)[\s：:〓]*([^\n]+(?:\n[^\n]+)?)/.exec(text);
    const block = maintenance?.[1] ?? '';
    const values = extractDates(block, post.published);
    const duration = /预计\s*(\d+(?:\.\d+)?)\s*(?:个)?小时/.exec(block);
    if (values.length !== 1 || !duration || Number(duration[1]) > 24) return review('维护开始与预计时长未唯一确定');
    start = values[0].value;
    end = new Date(Date.parse(start) + Number(duration[1]) * 3600000 + 8 * 3600000).toISOString().replace('Z', '+08:00');
    end = end.replace(/\.\d{3}/, '');
    notes = `官方维护说明：${block.trim()}。结束按官方预计${duration[1]}小时计算，仅为预计，不代表已开服。`;
  } else {
    // Only a clearly labelled schedule line is eligible; arbitrary prose dates are not paired.
    const schedule = /(?:活动时间|限时活动期|祈愿时间|跃迁时间|调频时间|活动期间|开启时间)[\s：:〓】\]]*([^\n]*(?:\n[^\n]*)?)/g;
    const ranges = [];
    for (const match of text.matchAll(schedule)) {
      const block = match[1];
      const values = extractDates(block, post.published);
      if (values.length === 2) {
        const between = block.slice(values[0].index + values[0].length, values[1].index);
        if (/^\s*(?:~|～|—|–|-|至)\s*$/.test(between) && Date.parse(values[0].value) < Date.parse(values[1].value)) ranges.push({ start: values[0].value, end: values[1].value });
      } else if (values.length === 1) {
        const relative = /^([\s\S]*?版本更新后)\s*(?:~|～|—|–|-|至)/.exec(block);
        // Keep the official wording (including a date/version), not an invented opening hour.
        if (relative && values[0].index >= relative[0].length) ranges.push({ start: null, end: values[0].value, startText: relative[1].trim().replace(/\s+/g, ' ') });
      }
    }
    const unique = [...new Map(ranges.map(range => [JSON.stringify(range), range])).values()];
    if (unique.length !== 1) return review('未取得唯一带标签的明确时间段');
    if (new Set(dates.map(date => date.value)).size > 2) return review('正文存在额外时刻，需要核对是否多个阶段');
    if (/限时活动期|常时传略/.test(text)) notes = '截止仅指限时活动奖励期；常驻玩法可能继续开放。';
    ({ start, end, startText = '' } = unique[0]);
  }
  return { event: { id: `${post.game}:${post.source ?? 'miyoushe'}:${post.id}`, game: post.game, category, title: post.title, start, end, ...(startText ? { startText } : {}), url: post.url, notes: notes || '自动解析官方公告；缺少明确开始时刻时仅发布截止节点。' } };
}
