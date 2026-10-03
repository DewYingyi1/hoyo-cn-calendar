import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { approveImageEvidence, createImageEvidenceChecker, loadImageBytes, isOfficialImageURL, MAX_IMAGE_BYTES, MAX_IMAGES_PER_POST } from '../lib/image-evidence.mjs';
import { websitePublished, fetchWebsite, publicSourceError } from '../lib/sources.mjs';
import { postDigest, imageDigest } from '../lib/parser.mjs';

const url = 'https://upload-bbs.mihoyo.com/schedule.gif';
const hash = value => createHash('sha256').update(value).digest('hex');
const context = { expectedDigest: 'reviewed-text', digest: 'reviewed-text', now: '2026-10-03T00:00:00Z' };
const post = { images: [url] };
const response = (bytes = 'GIF89a-one', headers = {}) => new Response(bytes, { headers: { 'content-type': 'image/gif', ...headers } });
const baseline = { imageEvidenceRequired: true, confirmedImageBytes: { [url]: hash('GIF89a-one') }, confirmedImageBytesDigest: context.expectedDigest };

test('字节检查只接受官方HTTPS图片、禁止认证URL及其他端口', () => {
  assert.equal(isOfficialImageURL(url), true);
  assert.equal(isOfficialImageURL('https://assets.hoyoverse.com/file.png'), true);
  for (const bad of ['http://upload-bbs.mihoyo.com/a', 'https://mihoyo.com.evil.test/a', 'https://evil.test/a', 'https://user:password@mihoyo.com/a', 'https://mihoyo.com:8443/a', 'not-url']) assert.equal(isOfficialImageURL(bad), false);
});

test('未设置imageEvidenceRequired不抓图，GIF按原始字节SHA256校验且redirect:error', async () => {
  let calls = 0;
  const checker = createImageEvidenceChecker({ request: async (location, options) => {
    calls++;
    assert.equal(location, url);
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return response();
  } });
  assert.equal((await checker(post, undefined, context)).required, false);
  assert.equal((await checker(post, { imageEvidenceRequired: false }, context)).required, false);
  assert.equal(calls, 0);
  const result = await checker(post, baseline, context);
  assert.equal(result.needsReview, false);
  assert.deepEqual(result.fields.observedImageBytes, baseline.confirmedImageBytes);
  assert.equal(calls, 1);
  await checker(post, baseline, context);
  assert.equal(calls, 1, '同轮同URL去重，不跨轮缓存');
});

test('无字节基线首轮只记观察，旧digest绑定的基线也不得自动确认', async () => {
  for (const reference of [{ imageEvidenceRequired: true }, { ...baseline, confirmedImageBytesDigest: 'old-text' }, { ...baseline, confirmedImageBytes: {} }]) {
    const result = await createImageEvidenceChecker({ request: async () => response() })(post, reference, context);
    assert.equal(result.baselineMissing, true);
    assert.equal(result.needsReview, true);
    assert.equal(result.fields.imageEvidencePending, true);
    assert.equal(result.fields.observedImageBytesDigest, context.digest);
    assert.equal(Object.hasOwn(result.fields, 'confirmedImageBytes'), false);
    assert.equal(Object.hasOwn(result.fields, 'confirmedImageBytesDigest'), false);
  }
});

test('同URL换字节跨轮持续待审，即便图片回滚也不会自动清除', async () => {
  const first = await createImageEvidenceChecker({ request: async () => response('GIF89a-two') })(post, baseline, context);
  assert.equal(first.bytesChanged, true);
  const saved = { ...baseline, ...first.fields };
  const second = await createImageEvidenceChecker({ request: async () => response('GIF89a-two') })(post, saved, context);
  assert.equal(second.needsReview, true);
  const reverted = await createImageEvidenceChecker({ request: async () => response() })(post, { ...saved, ...second.fields }, context);
  assert.equal(reverted.bytesChanged, false);
  assert.equal(reverted.needsReview, true);
  assert.deepEqual(saved.confirmedImageBytes, baseline.confirmedImageBytes);
  const manuallyApproved = { ...saved, confirmedImageBytes: saved.observedImageBytes,
    confirmedImageBytesDigest: context.digest, imageEvidencePending: false };
  assert.equal((await createImageEvidenceChecker({ request: async () => response('GIF89a-two') })(post, manuallyApproved, context)).needsReview, false);
});

test('人工批准必须绑定当前正文、当前图片列表与完整观察字节', () => {
  const digest = hash('current-body');
  const imagesHash = hash('current-image-list');
  const observed = { [url]: hash('GIF89a-current') };
  const reference = { imageEvidenceRequired: true, digest, imagesHash, observedImageBytes: observed,
    observedImageBytesDigest: digest, imageEvidencePending: true, imageEvidenceError: null };
  const approved = approveImageEvidence(reference, digest);
  assert.deepEqual(approved.confirmedImageBytes, observed);
  assert.notEqual(approved.confirmedImageBytes, observed);
  assert.equal(approved.confirmedImageBytesDigest, digest);
  assert.equal(approved.confirmedImagesHash, imagesHash);
  assert.equal(approved.confirmedImagesDigest, digest);
  assert.equal(approved.imageEvidencePending, false);
  for (const bad of [
    [{ ...reference, imageEvidenceRequired: false }, digest],
    [reference, hash('old-body')],
    [{ ...reference, observedImageBytesDigest: hash('old-body') }, digest],
    [{ ...reference, observedImageBytes: {} }, digest],
    [{ ...reference, imageEvidenceError: '图片失败' }, digest],
    [{ ...reference, imagesHash: null }, digest],
  ]) assert.throws(() => approveImageEvidence(...bad), /image-approval-/);
});

test('正文digest变化后，旧确认图片基线不能用于新正文，即使字节没变也送审', async () => {
  const result = await createImageEvidenceChecker({ request: async () => response() })(post, baseline, { ...context, digest: 'modified-text' });
  assert.equal(result.needsReview, true);
  assert.equal(result.baselineMissing, true);
  assert.equal(result.fields.observedImageBytesDigest, 'modified-text');
  assert.equal(Object.hasOwn(result.fields, 'confirmedImageBytesDigest'), false);
});

test('图片列表变更或清空也送审，不允许子集基线通过', async () => {
  const extra = 'https://upload-bbs.mihoyo.com/another.png';
  const checker = createImageEvidenceChecker({ request: async () => response() });
  assert.equal((await checker({ images: [url, extra] }, baseline, context)).bytesChanged, true);
  assert.equal((await checker(post, { ...baseline, confirmedImageBytes: { ...baseline.confirmedImageBytes, [extra]: hash('other') } }, context)).bytesChanged, true);
  const empty = await checker({ images: [] }, baseline, context);
  assert.equal(empty.needsReview, true);
  assert.ok(empty.failure);
});

test('图片失败保留原观察及确认基线，不暴露远端异常内容', async () => {
  const reference = { ...baseline, observedImageBytes: { [url]: hash('older-observation') }, observedImageBytesDigest: 'old-observed' };
  const result = await createImageEvidenceChecker({ request: async () => { throw new Error('secret-token raw-content'); } })(post, reference, context);
  assert.equal(result.needsReview, true);
  assert.doesNotMatch(JSON.stringify(result), /secret-token|raw-content/);
  const saved = { ...reference, ...result.fields };
  assert.deepEqual(saved.confirmedImageBytes, reference.confirmedImageBytes);
  assert.deepEqual(saved.observedImageBytes, reference.observedImageBytes);
  assert.equal(saved.observedImageBytesDigest, reference.observedImageBytesDigest);
  assert.ok(saved.imageEvidenceError);
});

test('拒绝超16MiB、重定向、错误格式、空流，流实际长度也受限', async () => {
  await assert.rejects(loadImageBytes('https://evil.test/image', { request: async () => assert.fail('不能请求非白名单') }), /image-domain/);
  await assert.rejects(loadImageBytes(url, { request: async () => response('small', { 'content-length': String(MAX_IMAGE_BYTES + 1) }) }), /image-size/);
  await assert.rejects(loadImageBytes(url, { request: async () => response(Buffer.alloc(MAX_IMAGE_BYTES + 1)) }), /image-size/);
  await assert.rejects(loadImageBytes(url, { request: async () => new Response('redirect', { status: 302 }) }), /image-http/);
  await assert.rejects(loadImageBytes(url, { request: async () => response('html', { 'content-type': 'text/html' }) }), /image-format/);
  await assert.rejects(loadImageBytes(url, { request: async () => response('') }), /image-body/);
  const exact = await loadImageBytes(url, { request: async () => response(Buffer.alloc(MAX_IMAGE_BYTES)) });
  assert.equal(exact.size, MAX_IMAGE_BYTES);
});

test('请求或读流挂起都受总超时约束，信号会中断', async () => {
  let signal;
  await assert.rejects(loadImageBytes(url, { timeoutMs: 15, request: async (_, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } }), /image-timeout/);
  assert.equal(signal.aborted, true);
  let cancelled = false;
  const stream = new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { cancelled = true; } });
  await assert.rejects(loadImageBytes(url, { timeoutMs: 15, request: async () => new Response(stream, { headers: { 'content-type': 'image/gif' } }) }), /image-timeout/);
  assert.equal(cancelled, true);
});

test('全局并发限制覆盖多公告，单轮URL去重', async () => {
  let active = 0, peak = 0, calls = 0;
  const checker = createImageEvidenceChecker({ concurrency: 2, request: async () => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return response();
  } });
  const images = Array.from({ length: 7 }, (_, index) => `https://assets.mihoyo.com/${index}.gif`);
  const results = await Promise.all([checker({ images }, { imageEvidenceRequired: true }, context), checker({ images }, { imageEvidenceRequired: true }, context)]);
  assert.equal(calls, images.length);
  assert.equal(peak, 2);
  assert.ok(results.every(result => result.needsReview));
});

test('限制单篇图片数与整轮下载总字节，预算失败保持待审', async () => {
  const tooMany = Array.from({ length: MAX_IMAGES_PER_POST + 1 }, (_, index) => `https://assets.mihoyo.com/${index}.gif`);
  let calls = 0;
  const countResult = await createImageEvidenceChecker({ request: async () => { calls++; return response(); } })(
    { images: tooMany }, { imageEvidenceRequired: true }, context);
  assert.equal(calls, 0);
  assert.equal(countResult.needsReview, true);
  assert.match(countResult.failure, /数量/);

  const first = 'https://assets.mihoyo.com/first.gif';
  const second = 'https://assets.mihoyo.com/second.gif';
  const checker = createImageEvidenceChecker({ concurrency: 1, maxTotalBytes: 12, request: async () => response('12345678') });
  const budgetResult = await checker({ images: [first, second] }, { imageEvidenceRequired: true }, context);
  assert.equal(budgetResult.needsReview, true);
  assert.match(budgetResult.failure, /总预算/);
  assert.equal(Object.hasOwn(budgetResult.fields, 'observedImageBytes'), false);
});

test('官网发布时间支持无偏移北京时间、Z及offset，非法日期不自动滚动', () => {
  for (const value of ['2026-10-03 08:00:00', '2026-10-03T08:00:00+08:00', '2026-10-03T08:00:00+0800', '2026-10-03T00:00:00Z', '2026-10-02T19:00:00-05:00']) assert.equal(websitePublished(value), '2026-10-03T00:00:00.000Z');
  assert.equal(websitePublished('2024-02-29 08:00:00'), '2024-02-29T00:00:00.000Z');
  assert.equal(websitePublished('2026-10-03T00:00:00.125Z'), '2026-10-03T00:00:00.125Z');
  for (const value of [null, undefined, 42, '', '2026-02-29 08:00:00', '2026-04-31 08:00:00', '2026-13-01 08:00:00', '2026-01-00 08:00:00', '2026-10-03 24:00:00', '2026-10-03 08:60:00', '2026-10-03 08:00:60', '2026-10-03T08:00:00+24:00', '2026-10-03T08:00:00+08:60', '2026-10-03T08:00:00Z+08:00']) assert.throws(() => websitePublished(value), /发布时间无效/);
});

test('公开来源错误只保留固定错误码与官网主机，不泄露原始异常', () => {
  assert.equal(publicSourceError(new Error('private token and body')), 'source-processing');
  assert.equal(publicSourceError(new Error('api.mihoyo.com：source-timeout；fallback.mihoyo.com：source-invalid')),
    'api.mihoyo.com：source-timeout；fallback.mihoyo.com：source-invalid');
  assert.equal(publicSourceError(new Error('api.mihoyo.com：source-timeout；secret')), 'source-processing');
});

const config = { website: { base: 'https://api.mihoyo.com', fallbackBases: ['https://fallback.mihoyo.com'], app: 'test', channel: 'test', urlBase: 'https://ys.mihoyo.com/main/news/detail/' } };
const item = (id, extra = {}) => ({ iInfoId: id, sTitle: '正常活动', sContent: '<p>有效正文</p>', dtStartTime: '2026-10-03 08:00:00', ...extra });

test('坏官网记录逐条隔离，有效正文、图片正文与宣传保留，空正文正常filtered', async () => {
  let calls = 0;
  const list = [item(1), item(2, { dtStartTime: '2026-02-30 00:00:00' }), item(3, { dtStartTime: null }),
    item(4, { sContent: '<p> &nbsp; </p>', dtStartTime: 'invalid-but-filtered' }),
    item(5, { sContent: `<img src="${url}">` }), item(6, { sTitle: '宣传视频' }), null];
  const result = await fetchWebsite('genshin', config, async () => { calls++; return { list, iTotal: list.length }; });
  assert.equal(calls, 1, '部分成功不重新抓全来源或调用fallback');
  assert.deepEqual(result.posts.map(post => post.id), ['1', '5', '6']);
  assert.equal(result.scanned, 7);
  assert.equal(result.filtered, 1);
  assert.equal(result.qualityIssues.length, 3);
  assert.deepEqual(result.qualityIssues.map(issue => issue.postId), ['2', '3', null]);
  assert.doesNotMatch(JSON.stringify(result.qualityIssues), /有效正文|invalid-but-filtered/);
  const filtered = await fetchWebsite('genshin', config, async () => ({ list: [item(7, { sContent: '' })], iTotal: 1 }));
  assert.deepEqual(filtered.posts, []);
  assert.deepEqual(filtered.qualityIssues, []);
  assert.equal(filtered.filtered, 1);
});

test('更新入口隔离测试：图片失败不吞有效posts，跨轮不自动确认且不改实际data', async () => {
  const tempRoot = path.join(process.env.LOCALAPPDATA ?? 'C:\\Users\\PC\\AppData\\Local', 'Temp', 'opencode');
  await fs.mkdir(tempRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tempRoot, 'hoyo-image-evidence-'));
  const put = async (file, value) => {
    await fs.mkdir(path.dirname(path.join(sandbox, file)), { recursive: true });
    await fs.writeFile(path.join(sandbox, file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const get = async file => JSON.parse(await fs.readFile(path.join(sandbox, file), 'utf8'));
  try {
    for (const name of ['calendar', 'time', 'parser', 'sources', 'identity', 'selection', 'review', 'review-state', 'image-evidence']) {
      await put(`lib/${name}.mjs`, await fs.readFile(new URL(`../lib/${name}.mjs`, import.meta.url), 'utf8'));
    }
    await put('scripts/update.mjs', await fs.readFile(new URL('../scripts/update.mjs', import.meta.url), 'utf8'));
    // Only the import contract is needed; the production build file is not changed or run.
    await put('scripts/build.mjs', `import fs from 'node:fs/promises';
      export const ROOT = ${JSON.stringify(sandbox)};
      export async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(ROOT + '/' + file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }
       export async function writeJson(file, value) { await fs.mkdir(ROOT + '/' + file.split('/').slice(0, -1).join('/'), {recursive:true}); await fs.writeFile(ROOT + '/' + file, JSON.stringify(value)); }
       export async function commitRepositoryFiles(files) { for (const [file, value] of files) await writeJson(file, JSON.parse(value)); }
       export async function withRepositoryLock(operation) { return operation(); }`);
    const list = Array.from({ length: 7 }, (_, i) => item(i + 1, {
      sTitle: `限时活动${i + 1}`,
      sContent: `<p>活动时间：2026/10/03 10:00 ~ 2026/10/10 10:00</p><img src="https://upload-bbs.mihoyo.com/${i + 1}.gif">`,
    }));
    list[4].dtStartTime = '2026-02-30 00:00:00';
    list[5].sContent = '';
    list[6].sTitle = '宣传视频';
    list[6].sContent = '<p>宣传正文</p>';
    const referencePost = i => ({ title: list[i - 1].sTitle, text: '活动时间：2026/10/03 10:00 ~ 2026/10/10 10:00\n', images: [`https://upload-bbs.mihoyo.com/${i}.gif`] });
    const registry = {};
    for (const i of [1, 2, 3]) {
      const p = referencePost(i);
      registry[`genshin:website:${i}`] = { imageEvidenceRequired: true, reviewedDigest: postDigest(p),
        confirmedImagesHash: imageDigest(p), confirmedImagesDigest: postDigest(p),
        ...(i === 1 ? {} : { confirmedImageBytes: { [p.images[0]]: hash('old-bytes') }, confirmedImageBytesDigest: postDigest(p) }) };
    }
    registry['genshin:miyoushe:99'] = { title: list[0].sTitle, published: '2026-10-03T00:00:00.000Z' };
    const previous = [1, 2, 3, 5].map(i => ({ id: `genshin:website:${i}`, game: 'genshin', category: 'event', title: `旧事件${i}`,
      start: '2026-10-03T10:00:00+08:00', end: '2026-10-10T10:00:00+08:00', url: config.website.urlBase + i,
      sequence: 9, modified: '2026-10-02T00:00:00Z' }));
    await put('sources/games.json', { genshin: config });
    await put('data/posts.json', registry);
    await put('data/events.json', previous);
    await put('data/overrides.json', { events: [], suppressPostIds: ['genshin:website:1', 'genshin:website:2', 'genshin:website:3'] });
    await put('fixture.mjs', `globalThis.fetch = async (url, options) => {
       if (url.includes('/getContentList?')) return new Response(JSON.stringify({retcode:0,data:{list:${JSON.stringify(list)},iTotal:7}}), {headers:{'content-type':'application/json'}});
      if (!${JSON.stringify([1, 2, 3].map(i => `https://upload-bbs.mihoyo.com/${i}.gif`))}.includes(url)) throw new Error('UNEXPECTED_REQUEST');
      if (options.redirect !== 'error') throw new Error('REDIRECT_POLICY');
      if (url.endsWith('/3.gif')) throw new Error('PRIVATE_BODY_DO_NOT_PRINT');
      return new Response('new-bytes', {headers:{'content-type':'image/gif'}});
    };`);
    const run = () => promisify(execFile)(process.execPath, ['--import', pathToFileURL(path.join(sandbox, 'fixture.mjs')).href, path.join(sandbox, 'scripts/update.mjs')], {
      cwd: sandbox, timeout: 10000, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH },
    });
    for (let round = 0; round < 2; round++) {
      const output = await run();
      assert.doesNotMatch(output.stdout + output.stderr, /PRIVATE_BODY_DO_NOT_PRINT|UNEXPECTED_REQUEST|REDIRECT_POLICY/);
      assert.match(output.stdout, /部分成功/);
      const saved = await get('data/posts.json');
      for (const i of [1, 2, 3]) assert.equal(saved[`genshin:website:${i}`].imageEvidencePending, true);
      assert.equal(Object.hasOwn(saved['genshin:website:1'], 'confirmedImageBytes'), false);
      assert.deepEqual(saved['genshin:website:2'].confirmedImageBytes, registry['genshin:website:2'].confirmedImageBytes);
      assert.equal(Object.hasOwn(saved['genshin:website:3'], 'observedImageBytes'), false);
      assert.equal(saved['genshin:website:1'].canonical, 'genshin:website:1');
      assert.equal(Object.hasOwn(await get('data/aliases.json'), 'genshin:website:1'), false, '未确认图片公告不得提交跨源alias');
      const reviews = await get('data/review.json');
      for (const i of [1, 2, 3]) assert.ok(reviews.some(review => review.postId === String(i) && !review.resolved));
      const events = await get('data/events.json');
      for (const old of previous) assert.deepEqual(events.find(event => event.id === old.id), old);
      assert.ok(events.some(event => event.id === 'genshin:website:4'));
      const status = await get('data/status.json');
      assert.equal(status.partialSources, 1);
      assert.equal(status.completeSources, 0);
      assert.equal(status.games.genshin.qualityIssues.length, 1);
      assert.equal(status.games.genshin.filteredPosts, 1);
      assert.equal(status.games.genshin.imageEvidenceIssues.length, 3);
      assert.equal(status.issues.length, 4);
    }
  } finally {
    // This unique directory was created by this test; no project or user files are removed.
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test('首次采集全败且无基线时在事务前拒绝，不留下半套数据', async () => {
  const tempRoot = path.join(process.env.LOCALAPPDATA ?? 'C:\\Users\\PC\\AppData\\Local', 'Temp', 'opencode');
  await fs.mkdir(tempRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tempRoot, 'hoyo-empty-update-'));
  const put = async (file, value) => {
    await fs.mkdir(path.dirname(path.join(sandbox, file)), { recursive: true });
    await fs.writeFile(path.join(sandbox, file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  try {
    for (const name of ['calendar', 'time', 'parser', 'sources', 'identity', 'selection', 'review', 'review-state', 'image-evidence']) {
      await put(`lib/${name}.mjs`, await fs.readFile(new URL(`../lib/${name}.mjs`, import.meta.url), 'utf8'));
    }
    await put('scripts/update.mjs', await fs.readFile(new URL('../scripts/update.mjs', import.meta.url), 'utf8'));
    await put('scripts/build.mjs', `import fs from 'node:fs/promises';
      export const ROOT = ${JSON.stringify(sandbox)};
      export async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(ROOT + '/' + file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; } }
      export async function commitRepositoryFiles() { throw new Error('COMMIT_MUST_NOT_RUN'); }
      export async function withRepositoryLock(operation) { return operation(); }`);
    const originals = new Map([
      ['data/events.json', '[]'],
      ['data/overrides.json', JSON.stringify({ events: [], suppressPostIds: [] })],
      ['data/status.json', JSON.stringify({ games: {}, sentinel: 'unchanged' })],
      ['data/posts.json', '{}'], ['data/review.json', '[]'], ['data/aliases.json', '{}'], ['data/confirmations.json', '{}'],
      ['local-private/review-inputs.json', '[{"sentinel":"unchanged"}]'],
    ]);
    await put('sources/games.json', '{}');
    for (const [file, bytes] of originals) await put(file, bytes);
    await assert.rejects(promisify(execFile)(process.execPath, [path.join(sandbox, 'scripts/update.mjs')], {
      cwd: sandbox, timeout: 10000, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH },
    }), error => /首次采集全部失败且没有已确认事件/.test(error.stderr) && !/COMMIT_MUST_NOT_RUN/.test(error.stderr));
    for (const [file, bytes] of originals) assert.equal(await fs.readFile(path.join(sandbox, file), 'utf8'), bytes, `失败前不得改写：${file}`);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});
