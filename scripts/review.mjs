import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT, readJson, writeJson } from './build.mjs';
import { fetchWebsite } from '../lib/sources.mjs';
import { fetchBilibili } from '../lib/bilibili.mjs';
import { postDigest, imageDigest } from '../lib/parser.mjs';
import { REVIEW_PROMPT, parseModelJSON, checkCandidate, loadReviewImage } from '../lib/review.mjs';

const config = await readJson('sources/review.json');
if (config.baseURL !== 'https://api.siliconflow.cn/v1' || config.model !== 'Qwen/Qwen3.8-27B') throw new Error('审核服务配置未通过固定入口校验');
const keyPath = process.env.SILICONFLOW_KEY_FILE || 'E:/opencode归档/私密配置/siliconflow.key';
const key = (await fs.readFile(keyPath, 'utf8')).replace(/^\uFEFF/, '').trim();
if (!key || /[\r\n]/.test(key)) throw new Error('密钥文件必须为单行原始值');
const redact = value => JSON.parse(JSON.stringify(value).replaceAll(key, '[REDACTED]'));
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const privateDir = path.join(ROOT, 'local-private');
await fs.mkdir(privateDir, { recursive: true });
const store = await readJson('local-private/model-review.json', { schema: 1, records: {} });
let inputs, existing;
if (process.argv.includes('--live')) {
  const base = 'https://dewyingyi1.github.io/hoyo-cn-calendar/';
  const json = async file => {
    const response = await fetch(base + file + '?review=' + Date.now(), { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error('公开审核数据HTTP ' + response.status);
    return response.json();
  };
  const pending = (await json('data/review.json')).filter(item => !item.resolved);
  existing = await json('data/events.json');
  const games = await readJson('sources/games.json');
  const bilibili = await readJson('sources/bilibili.json', {});
  inputs = [];
  for (const game of Object.keys(games)) {
    const wanted = pending.filter(item => item.game === game);
    if (!wanted.length) continue;
    try {
      const result = await fetchWebsite(game, games[game]);
      for (const review of wanted) {
        const post = result.posts.find(post => post.url === review.url);
        if (post) inputs.push({ ...post, canonical: `${review.game}:${review.source}:${review.postId}`, digest: postDigest(post), imagesHash: imageDigest(post) });
      }
    } catch { console.log(`${game}官网审核输入读取失败，旧候选保留。`); }
    if (wanted.some(item => item.url.includes('bilibili.com'))) {
      try {
        const result = await fetchBilibili(game, bilibili[game]);
        for (const review of wanted) {
          const post = result.posts.find(post => post.url === review.url);
          if (post) inputs.push({ ...post, canonical: `${review.game}:${review.source}:${review.postId}`, digest: postDigest(post), imagesHash: imageDigest(post) });
        }
      } catch { console.log(`${game}B站审核输入不可用，旧候选保留。`); }
    }
  }
} else {
  inputs = await readJson('local-private/review-inputs.json', []);
  existing = await readJson('site/data/events.json', []);
}
let calls = 0, tokens = 0;
for (const post of inputs) {
  const id = `${post.game}:${post.source}:${post.id}`;
  const images = (post.images ?? []).slice(0, config.maxImagesPerPost);
  const loaded = [];
  try { for (const url of images) loaded.push(await loadReviewImage(url)); }
  catch { console.log(`${post.game}:${post.id}图片读取不完整；保留待复核。`); continue; }
  const imageHashes = loaded.map(image => ({ url: image.url, sha256: createHash('sha256').update(image.bytes).digest('hex') }));
  const inputHash = hash([post.digest, post.imagesHash, imageHashes, config.model, REVIEW_PROMPT]);
  if (store.records[id]?.inputHash === inputHash && store.records[id]?.status === 'reviewed') {
    const record = store.records[id];
    for (const candidate of record.candidates) candidate.check = checkCandidate(candidate, post, existing);
    if (post.text.length > 28000 || (post.images?.length ?? 0) > images.length) {
      for (const candidate of record.candidates) { candidate.check.eligible = false; candidate.check.problems.push('正文或图片超出本轮预算，证据不完整'); }
    }
    record.active = true;
    record.conflictsCheckedAt = new Date().toISOString();
    continue;
  }
  if (calls >= config.maxPostsPerRun) break;
  const content = [{ type: 'text', text: JSON.stringify({ title: post.title, game: post.game, url: post.url, published: post.published, body: post.text.slice(0, 28000), suppliedImages: images }) }, ...loaded.flatMap(image => [{ type: 'text', text: 'Original image URL: ' + image.url }, { type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.bytes.toString('base64')}` } }])];
  calls++;
  try {
    const response = await fetch(config.baseURL + '/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, enable_thinking: false, temperature: 0, max_tokens: config.maxOutputTokens, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: REVIEW_PROMPT }, { role: 'user', content }] }),
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const responseData = await response.json();
    if (responseData.choices?.[0]?.finish_reason === 'length') throw new Error('模型输出被截断');
    const data = redact(parseModelJSON(responseData.choices?.[0]?.message?.content));
    const checked = data.candidates.map(candidate => ({ ...candidate, check: checkCandidate(candidate, post, existing) }));
    if (post.text.length > 28000 || (post.images?.length ?? 0) > images.length) {
      for (const candidate of checked) { candidate.check.eligible = false; candidate.check.problems.push('正文或图片超出本轮预算，证据不完整'); }
    }
    tokens += responseData.usage?.total_tokens ?? 0;
    store.records[id] = { inputHash, checkedAt: new Date().toISOString(), status: 'reviewed', model: config.model, officialURL: post.url, imageHashes, images, imagesOmitted: Math.max(0, (post.images?.length ?? 0) - images.length), bodyTruncated: post.text.length > 28000, candidates: checked, unresolved: data.unresolved ?? [], usage: responseData.usage };
    console.log(`${post.game}:${post.id}：${checked.length}个带证据候选，保持待复核。`);
  } catch {
    // Never print API response bodies, request objects or credential-containing exceptions.
    store.records[id] = { inputHash, checkedAt: new Date().toISOString(), status: 'failed', reason: '模型调用或结构校验失败；未发布，后续重试', officialURL: post.url };
    console.log(`${post.game}:${post.id}模型审核未完成；保留待复核。`);
  }
  await writeJson('local-private/model-review.json', redact(store));
}
store.lastRun = { at: new Date().toISOString(), inputCount: inputs.length, calls, totalTokens: tokens, mode: 'candidates-only' };
for (const [id, record] of Object.entries(store.records)) record.active = inputs.some(post => id === `${post.game}:${post.source}:${post.id}`);
await writeJson('local-private/model-review.json', redact(store));
console.log(`模型审核完成：${calls}次调用，${tokens} token。候选仅保存在本机；没有自动推送或覆盖日程。`);
