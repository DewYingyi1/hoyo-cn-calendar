import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { networkFailure } from '../lib/network-failure.mjs';
import { getJson, fetchWebsite, publicSourceError } from '../lib/sources.mjs';
import { createImageEvidenceChecker } from '../lib/image-evidence.mjs';

const fault = code => new Error('PRIVATE_EXCEPTION', { cause: Object.assign(new Error('PRIVATE_ADDRESS'), { code }) });
const sha = s => createHash('sha256').update(s).digest('hex');
const url = 'https://fastcdn.mihoyo.com/evidence.png';
const oldDigest = sha('old body');
const baseline = { imageEvidenceRequired: true, confirmedImageBytes: { [url]: sha('image') }, confirmedImageBytesDigest: oldDigest };
const image = () => new Response('image', { headers: { 'content-type': 'image/png' } });

test('网络类别只由固定code得出，递归cause与AggregateError有上限', () => {
  for (const [code, kind] of [['ENOTFOUND', 'dns'], ['EAI_AGAIN', 'dns'], ['UND_ERR_CONNECT_TIMEOUT', 'connect'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'], ['CERT_HAS_EXPIRED', 'tls'], ['ECONNRESET', 'socket'], ['UND_ERR_BODY_TIMEOUT', 'timeout']]) {
    assert.equal(networkFailure(fault(code)), kind);
  }
  assert.equal(networkFailure(new AggregateError([fault('ENOTFOUND')])), 'dns');
  const cyclic = new Error('ENOTFOUND PRIVATE_EXCEPTION'); cyclic.cause = cyclic;
  assert.equal(networkFailure(cyclic), 'unknown');
});

test('官网三次失败分类并走备用，日志不含URL路径、认证信息和异常正文', async () => {
  const logs = [];
  const previous = console.warn;
  console.warn = s => logs.push(s);
  let calls = 0;
  try {
    const config = { website: { base: 'https://api.mihoyo.com', fallbackBases: ['https://backup.mihoyo.com'], app: 'PRIVATE_PATH', channel: 1 } };
    const result = await fetchWebsite('genshin', config, location => getJson(location, { retryDelaysMs: [0, 0], request: async () => {
      calls++;
      if (calls <= 3) throw fault('ENOTFOUND');
      return new Response(JSON.stringify({ retcode: 0, data: { list: [] } }), { headers: { 'content-type': 'application/json' } });
    } }));
    assert.equal(calls, 4);
    assert.equal(result.endpoint, config.website.fallbackBases[0]);
    assert.deepEqual(logs.map(s => JSON.parse(s).attempt), [1, 2, 3]);
    assert.ok(logs.every(s => JSON.parse(s).code === 'source-dns'));
    assert.doesNotMatch(logs.join(''), /PRIVATE_|https:|getContentList/);
    assert.equal(publicSourceError(new Error('api.mihoyo.com：source-tls；backup.mihoyo.com：source-connect')),
      'api.mihoyo.com：source-tls；backup.mihoyo.com：source-connect');
    assert.equal(publicSourceError(new Error('api.mihoyo.com：source-dns PRIVATE_EXCEPTION')), 'source-processing');
  } finally { console.warn = previous; }
});

test('官网未知读流中断记录read阶段，下一次成功仍可恢复', async () => {
  const logs = []; const previous = console.warn; console.warn = s => logs.push(JSON.parse(s));
  let calls = 0;
  try {
    const data = await getJson('https://api.mihoyo.com/path', { retryDelaysMs: [0, 0], request: async () => {
      calls++;
      if (calls === 1) return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
        arrayBuffer: async () => { throw new Error('PRIVATE_EXCEPTION'); } };
      return new Response('{"retcode":0,"data":{"list":[]}}', { headers: { 'content-type': 'application/json' } });
    } });
    assert.deepEqual(data.list, []);
    assert.equal(logs[0].code, 'source-read'); assert.equal(logs[0].stage, 'read'); assert.equal(calls, 2);
  } finally { console.warn = previous; }
});

test('图片三次网络失败不改旧基线、不上人工锁，成功后自动恢复', async () => {
  const context = { expectedDigest: oldDigest, digest: oldDigest, now: '2026-10-14T00:00:00Z' };
  const failed = await createImageEvidenceChecker({ retryDelaysMs: [0, 0], request: async () => { throw fault('ENOTFOUND'); } })({ images: [url] }, baseline, context);
  assert.equal(failed.fields.imageEvidenceManualReview, false);
  assert.deepEqual(failed.fields.imageEvidenceDiagnostic, { kind: 'dns', attempts: 3 });
  const saved = { ...baseline, ...failed.fields };
  const recovered = await createImageEvidenceChecker({ request: async () => image() })({ images: [url] }, saved, context);
  assert.equal(recovered.needsReview, false); assert.equal(recovered.fields.imageEvidenceDiagnostic, null);
  assert.deepEqual(saved.confirmedImageBytes, baseline.confirmedImageBytes);
});

test('正文更新但图片一致明确标注重新绑定，后续网络失败或正文回滚仍保持人工锁', async () => {
  const context = { expectedDigest: oldDigest, digest: sha('new body'), now: '2026-10-14T00:00:00Z' };
  const updated = await createImageEvidenceChecker({ request: async () => image() })({ images: [url] }, baseline, context);
  assert.match(updated.reason, /标题或正文已修改.*旧图片基线仍保留/);
  assert.equal(updated.fields.imageEvidenceManualReview, true);
  const saved = { ...baseline, ...updated.fields };
  const failed = await createImageEvidenceChecker({ retryDelaysMs: [0, 0], request: async () => { throw fault('ECONNRESET'); } })({ images: [url] }, saved, context);
  const reverted = await createImageEvidenceChecker({ request: async () => image() })({ images: [url] }, { ...saved, ...failed.fields }, { ...context, digest: oldDigest });
  assert.equal(reverted.needsReview, true); assert.equal(reverted.fields.imageEvidenceManualReview, true);
});

test('图片列表改变同时下载失败，旧URL恢复后仍须人工复核', async () => {
  const context = { expectedDigest: oldDigest, digest: oldDigest, now: '2026-10-14T00:00:00Z' };
  const changed = await createImageEvidenceChecker({ retryDelaysMs: [0, 0], request: async () => { throw fault('ENOTFOUND'); } })(
    { images: ['https://fastcdn.mihoyo.com/replaced.png'] }, baseline, context);
  assert.equal(changed.listChanged, true); assert.equal(changed.fields.imageEvidenceManualReview, true);
  assert.match(changed.reason, /图片列表已修改/);
  const reverted = await createImageEvidenceChecker({ request: async () => image() })(
    { images: [url] }, { ...baseline, ...changed.fields }, context);
  assert.equal(reverted.needsReview, true); assert.equal(reverted.fields.imageEvidenceManualReview, true);
});
