import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fetchBilibili, getBilibiliJson, normalizeBilibiliDynamic, normalizeBilibiliVideo, extractBilibiliLivestreamTimes } from '../lib/bilibili.mjs';
import { parsePost } from '../lib/parser.mjs';

const configs = JSON.parse(await fs.readFile(new URL('../sources/bilibili.json', import.meta.url), 'utf8'));
const now = '2026-10-03T03:00:00.000Z';
const config = configs.starrail;
const timestamp = Date.parse('2026-10-02T04:00:00Z') / 1000;
// Synthetic fixtures model Bilibili's public JSON schemas, not successful live responses.
const body = '《崩坏：星穹铁道》4.7版本「测试版本」前瞻特别节目将于2026年10月9日（本周五）晚19:30正式播出。\n关注并转发参与抽奖，2026年10月10日12:00开奖。';
function dynamic(text = body, title = '', extra = {}) {
  return { id_str: '1180000000000000001', type: 'DYNAMIC_TYPE_DRAW', modules: {
    module_author: { mid: 1340190821, name: '崩坏星穹铁道', pub_ts: timestamp },
    module_dynamic: { desc: { text }, major: { opus: { title, summary: { text }, pics: [{ url: '//i0.hdslb.com/bfs/new_dyn/poster.jpg' }] } } },
  }, ...extra };
}
function video(text = body, title = '《崩坏：星穹铁道》4.7版本前瞻直播预告', extra = {}) {
  return { bvid: 'BV15N4y1J75R', owner: { mid: 1340190821 }, title, desc: text, pubdate: timestamp, ctime: timestamp + 3600, ...extra };
}
const deps = request => ({ request, sleep: async () => {}, now });
const feed = items => ({ items, has_more: false, offset: '' });

test('国服账号UID固定，不信昵称含官方的同名账号', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(configs).map(([game, cfg]) => [game, cfg.officialUids])), {
    genshin: ['401742377'], starrail: ['1340190821'], zzz: ['1636034895'],
  });
  const fake = dynamic(); fake.modules.module_author.mid = 299638163;
  fake.modules.module_author.name = '崩坏星穹铁道官方账号';
  assert.equal(normalizeBilibiliDynamic(fake, 'starrail', config, now), null);
  assert.equal(normalizeBilibiliVideo(video(body, undefined, { owner: { mid: 299638163 } }), 'starrail', config, now), null);
});

test('动态保留完整正文、图片引用、ISO发布时间和精确稳定ID', () => {
  const fixture = dynamic('#崩坏星穹铁道#\u200b\n' + body);
  const post = normalizeBilibiliDynamic(fixture, 'starrail', config, now);
  assert.equal(post.id, 'dynamic-1180000000000000001');
  assert.equal(post.source, 'bilibili'); assert.equal(post.official, true);
  assert.equal(post.published, '2026-10-02T04:00:00.000Z');
  assert.equal(post.url, 'https://www.bilibili.com/opus/1180000000000000001');
  assert.deepEqual(post.images, ['https://i0.hdslb.com/bfs/new_dyn/poster.jpg']);
  assert.match(post.title, /前瞻特别节目/);
  assert.equal(post.livestreamStart, '2026-10-09T19:30:00+08:00');
  assert.match(post.text, /10月10日12:00开奖/);
  assert.equal(parsePost(post).event.start, post.livestreamStart);
  fixture.modules.module_dynamic.desc.text += '\n官方补充说明';
  assert.equal(normalizeBilibiliDynamic(fixture, 'starrail', config, now).id, post.id);
});

test('支持DRAW动态、纯文本动态与opus正文，不读取转发原帖', () => {
  const draw = dynamic(); draw.modules.module_dynamic.major = { draw: { items: [{ src: 'https://i1.hdslb.com/bfs/dynamic/a.png' }] } };
  assert.equal(normalizeBilibiliDynamic(draw, 'starrail', config, now).images.length, 1);
  const text = dynamic(); delete text.modules.module_dynamic.major;
  assert.ok(normalizeBilibiliDynamic(text, 'starrail', config, now));
  const opus = dynamic(); delete opus.modules.module_dynamic.desc;
  assert.ok(normalizeBilibiliDynamic(opus, 'starrail', config, now));
  assert.equal(normalizeBilibiliDynamic(dynamic(body, '', { orig: dynamic() }), 'starrail', config, now), null);
  assert.equal(normalizeBilibiliDynamic(dynamic(body, '', { type: 'DYNAMIC_TYPE_FORWARD' }), 'starrail', config, now), null);
  assert.equal(normalizeBilibiliDynamic(dynamic(body, '', { id_str: 1180000000000000001 }), 'starrail', config, now), null);
});

test('三游戏中文前瞻标题包括直播预告均能匹配', () => {
  for (const [game, cfg] of Object.entries(configs)) {
    const title = `《${cfg.accountName}》${game === 'genshin' ? '「月之三」' : '4.7'}版本前瞻直播预告`;
    const fixture = dynamic(`${title}\n《${cfg.accountName}》前瞻直播将于2026/10/09 19:30正式开启。`, title);
    fixture.modules.module_author.mid = Number(cfg.officialUids[0]);
    const post = normalizeBilibiliDynamic(fixture, game, cfg, now);
    assert.equal(post.game, game); assert.equal(parsePost(post).event.category, 'livestream');
  }
});

test('广播时间需明确语义：上传、回放、抽奖、版本上线都不能充当直播', () => {
  const invalid = [
    '前瞻直播预告视频于2026年10月9日19:30上传。',
    '前瞻直播预告视频将于2026年10月9日19:30正式播出。',
    '前瞻特别节目，抽奖活动将于2026年10月9日19:30开启。',
    '前瞻特别节目\n抽奖时间：2026年10月9日19:30。',
    '前瞻特别节目，4.7版本将于2026年10月9日19:30上线。',
    '前瞻特别节目，回放将于2026年10月9日19:30播出。',
    '前瞻特别节目兑换码将于2026年10月9日19:30失效。',
    '前瞻特别节目\n直播间预约人数：123456，发布时间：2026年10月9日19:30。',
  ];
  for (const text of invalid) {
    assert.deepEqual(extractBilibiliLivestreamTimes(text, now), [], text);
    assert.equal(normalizeBilibiliVideo(video(text), 'starrail', config, now), null, text);
  }
  assert.equal(normalizeBilibiliVideo(video('前瞻特别节目，敬请期待！'), 'starrail', config, now), null);
});

test('回放或情报总览即使含原播出日期也排除；抽奖预告保留正确直播日期', () => {
  for (const title of ['前瞻特别节目回放', '前瞻直播完整版', '情报总览丨4.7前瞻特别节目', '前瞻精彩片段', '前瞻直播回顾']) {
    assert.equal(normalizeBilibiliVideo(video(body, title), 'starrail', config, now), null);
  }
  assert.equal(normalizeBilibiliDynamic(dynamic(body + '\n回顾本次特别节目精彩内容！'), 'starrail', config, now), null);
  assert.ok(normalizeBilibiliDynamic(dynamic(body, '4.7版本前瞻特别节目预告'), 'starrail', config, now));
});

test('仅即将播出；明确currentVersion可保留近期当前版本预告，旧置顶仍排除', () => {
  const past = video(body.replace('10月9日', '9月25日'), undefined, { pubdate: Date.parse('2026-09-23T04:00:00Z') / 1000 });
  assert.equal(normalizeBilibiliVideo(past, 'starrail', config, now), null);
  assert.ok(normalizeBilibiliVideo(past, 'starrail', { ...config, currentVersion: '4.7' }, now));
  assert.equal(normalizeBilibiliVideo(video(), 'starrail', { ...config, currentVersion: '4.6' }, now), null);
  assert.equal(normalizeBilibiliVideo(video(body, '14.7版本前瞻直播预告'), 'starrail', { ...config, currentVersion: '4.7' }, now), null);
  assert.equal(normalizeBilibiliVideo(video(body, undefined, { pubdate: Date.parse('2025-01-01') / 1000 }), 'starrail', config, now), null);
  assert.equal(normalizeBilibiliVideo(video(body, undefined, { pubdate: 0 }), 'starrail', config, now), null);
});

test('图片单独含时间只保留引用供审核，不猜OCR、预约卡或上传时间', () => {
  const fixture = dynamic('4.7版本前瞻特别节目预告\n敬请期待！');
  fixture.modules.module_dynamic.additional = { reserve: { stime: timestamp + 10000 } };
  const post = normalizeBilibiliDynamic(fixture, 'starrail', config, now);
  assert.ok(post.images); assert.equal(post.livestreamStart, undefined);
  assert.ok(parsePost(post).review); assert.equal(parsePost(post).event, undefined);
});

test('多播出时刻不自动选择，非法日期和非北京时间不猜', () => {
  const text = body + '\n直播时间：2026年10月9日20:00。';
  assert.equal(extractBilibiliLivestreamTimes(text, now).length, 2);
  const post = normalizeBilibiliVideo(video(text), 'starrail', config, now);
  assert.equal(post.livestreamStart, undefined);
  assert.ok(parsePost(post).review); assert.equal(parsePost(post).event, undefined);
  assert.deepEqual(extractBilibiliLivestreamTimes('前瞻特别节目将于2026年2月30日19:30播出。', now), []);
  assert.deepEqual(extractBilibiliLivestreamTimes('前瞻特别节目将于2026年10月9日19:30 UTC+9正式播出。', now), []);
  assert.deepEqual(extractBilibiliLivestreamTimes('前瞻特别节目将于2026年10月9日晚上7:30正式播出。', now), []);
});

test('图片引用不授权正文其他日期：版本正式开启时间不得交给旧parser当直播', () => {
  assert.equal(normalizeBilibiliDynamic(dynamic('4.7版本前瞻直播预告\n4.7版本将于2026年10月9日19:30正式开启。'), 'starrail', config, now), null);
});

test('原神实际中文措辞与跨年前瞻日期，不把开场白当标题', () => {
  const text = '#原神# #原神月之四前瞻直播#\n亲爱的旅行者，现在是派蒙的特别节目预告时间> <\n《原神》「『空月之歌·终曲』如果在冬夜，一个旅人」前瞻特别节目将于1月2日（本周五）13:00正式开启。\n提前关注直播间，我们不见不散！';
  const fixture = dynamic(text, '', { id_str: '1152405116430581829' });
  fixture.modules.module_author = { mid: 401742377, name: '原神', pub_ts: Date.parse('2025-12-31T04:00:00Z') / 1000 };
  const post = normalizeBilibiliDynamic(fixture, 'genshin', configs.genshin, '2025-12-31T08:00:00Z');
  assert.match(post.title, /空月之歌/);
  assert.equal(parsePost(post).event.start, '2026-01-02T13:00:00+08:00');
});

test('动态成功不访问视频；分页去重并统计原始扫描数', async () => {
  const urls = [];
  const result = await fetchBilibili('starrail', config, deps(async url => {
    urls.push(new URL(url));
    return urls.length === 1 ? { items: [dynamic()], has_more: true, offset: '1180000000000000001' } : feed([dynamic()]);
  }));
  assert.equal(result.posts.length, 1); assert.equal(result.scanned, 2);
  assert.equal(urls[0].searchParams.get('host_mid'), '1340190821');
  assert.equal(urls[1].searchParams.get('offset'), '1180000000000000001');
  assert.ok(urls.every(url => url.pathname.includes('web-dynamic')));
  assert.match(result.coverage, /非完整历史/);
});

test('动态无候选时视频后备抓完整desc，不信列表description或created', async () => {
  const urls = [];
  const result = await fetchBilibili('starrail', config, deps(async url => {
    const target = new URL(url); urls.push(target.pathname);
    if (target.pathname.includes('web-dynamic')) return feed([]);
    if (target.pathname.includes('arc/search')) return { list: { vlist: [
      { mid: 1340190821, bvid: 'BV15N4y1J75R', title: video().title, created: timestamp, description: '摘要不含时间' },
      { mid: 299638163, bvid: 'BV15N4y1J75R', title: video().title, created: timestamp },
    ] } };
    return video();
  }));
  assert.equal(urls.length, 3); assert.equal(result.posts.length, 1); assert.equal(result.scanned, 2);
  assert.equal(result.posts[0].id, 'video-BV15N4y1J75R');
  assert.equal(result.posts[0].url, 'https://www.bilibili.com/video/BV15N4y1J75R/');
  assert.equal(parsePost(result.posts[0]).event.start, '2026-10-09T19:30:00+08:00');
});

test('风控错误立即停止，不重试、不走视频绕过动态验证码', async () => {
  let requests = 0;
  await assert.rejects(fetchBilibili('starrail', config, deps(async () => {
    requests++; const error = new Error('API -352 CAPTCHA'); error.blocked = true; throw error;
  })), /CAPTCHA/);
  assert.equal(requests, 1);
});

test('普通网络失败可后备；两源失败如实抛出，零候选不冒充阻断', async () => {
  let count = 0;
  const result = await fetchBilibili('starrail', config, deps(async () => {
    if (++count === 1) throw new Error('timeout');
    return { list: { vlist: [] } };
  }));
  assert.deepEqual(result.posts, []); assert.match(result.coverage, /动态：timeout/);
  await assert.rejects(fetchBilibili('starrail', config, deps(async () => { throw new Error('timeout'); })), /动态.*timeout.*视频.*timeout/);
  await assert.rejects(fetchBilibili('starrail', { ...config, officialUids: ['299638163'] }, deps(async () => assert.fail('must not fetch'))), /白名单/);
});

test('匿名HTTP客户端报告412、429、验证码、限流与非JSON，无Cookie和重试', async () => {
  for (const status of [412, 429]) {
    await assert.rejects(getBilibiliJson('https://api.bilibili.com/x/test', { fetchImpl: async () => ({ ok: false, status }) }), error => error.blocked && error.message.includes(String(status)));
  }
  for (const code of [-352, -412, -799, -509]) {
    let requests = 0;
    await assert.rejects(getBilibiliJson('https://api.bilibili.com/x/test', { fetchImpl: async (_url, options) => {
      requests++; assert.equal(options.headers.Cookie, undefined); assert.equal(options.headers.cookie, undefined);
      return { ok: true, json: async () => ({ code, message: 'fixture risk control' }) };
    } }), error => error.blocked && error.message.includes(String(code)));
    assert.equal(requests, 1);
  }
  await assert.rejects(getBilibiliJson('https://api.bilibili.com/x/test', { fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('HTML'); } }) }), /非 JSON/);
  await assert.rejects(getBilibiliJson('https://example.com/x/test'), /官方公开 API/);
});

test('请求与正文数量有上限，解析结构改变不悄悄成功', async () => {
  let details = 0;
  const fixture = video();
  const result = await fetchBilibili('starrail', { ...config, maxVideoDetails: 1 }, deps(async url => {
    const pathname = new URL(url).pathname;
    if (pathname.includes('web-dynamic')) return feed([]);
    if (pathname.includes('arc/search')) return { list: { vlist: Array.from({ length: 30 }, () => ({ mid: 1340190821, bvid: fixture.bvid, title: fixture.title, created: timestamp })) } };
    details++; return fixture;
  }));
  assert.equal(details, 1); assert.equal(result.posts.length, 1);
  await assert.rejects(fetchBilibili('starrail', config, deps(async () => ({}))), /结构发生变化/);
});
