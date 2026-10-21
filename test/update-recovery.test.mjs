import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { recoveryReasons, updateWithRecovery, MAX_UPDATE_ROUNDS, RECOVERY_DELAYS_MS } from '../lib/update-recovery.mjs';
import { createImageEvidenceChecker } from '../lib/image-evidence.mjs';
import { createUpdatePass, main, UPDATE_SCRIPT } from '../scripts/update-with-recovery.mjs';
import { ROOT } from '../scripts/build.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const imageUrl = 'https://fastcdn.mihoyo.com/evidence.png';
const oldDigest = sha('old body');
const newDigest = sha('new body');
const imageBody = () => new Response('image', { headers: { 'content-type': 'image/png' } });
const fault = code => new Error('PRIVATE_EXCEPTION', { cause: Object.assign(new Error('PRIVATE_ADDRESS'), { code }) });

const transientSource = 'act-api-takumi-static.mihoyo.com：source-connect；api-takumi-static.mihoyo.com：source-connect';
const statusWith = (game, error) => ({ games: { [game]: { error } } });
const imageRecord = (overrides = {}) => ({
  digest: oldDigest, confirmedImageBytesDigest: oldDigest, confirmedImageBytes: { [imageUrl]: sha('image') },
  imageEvidenceRequired: true, imageEvidencePending: true, imageEvidenceRetryable: true,
  imageEvidenceManualReview: false, imageEvidenceErrorCode: 'image-request', ...overrides,
});

// A predictable one-pass-at-a-time fake: records ordering instead of touching child
// processes, files, the network or the clock.
function harness({ states, failUpdateAt = null, failReadAt = null }) {
  const events = [];
  const sleeps = [];
  const logs = [];
  let passes = 0;
  let active = 0;
  let peak = 0;
  const update = async () => {
    passes++;
    active++; peak = Math.max(peak, active);
    events.push(`update:${passes}`);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (passes === failUpdateAt) throw new Error('child-crashed');
  };
  const readState = async () => {
    events.push(`read:${passes}`);
    if (active) throw new Error('read-before-update-finished');
    if (passes === failReadAt) throw new Error('state-unreadable');
    const state = states[Math.min(passes, states.length) - 1];
    return structuredClone(state);
  };
  const sleep = async ms => { sleeps.push(ms); events.push(`sleep:${ms}`); };
  const log = line => logs.push(line);
  return { update, readState, sleep, log, events, sleeps, logs, peak: () => peak, passes: () => passes };
}

test('恢复策略常量：最多3轮、生产退避30/60秒', () => {
  assert.equal(MAX_UPDATE_ROUNDS, 3);
  assert.deepEqual(RECOVERY_DELAYS_MS, [30000, 60000]);
});

test('来源瞬时失败后成功：两轮、有等待，最终状态保持', async () => {
  const finalState = { status: statusWith('genshin', null), posts: {} };
  const h = harness({ states: [{ status: statusWith('genshin', transientSource), posts: {} }, finalState] });
  const summary = await updateWithRecovery(h);
  assert.equal(summary.attempts, 2);
  assert.equal(summary.recovered, true);
  assert.deepEqual(summary.remaining, []);
  assert.deepEqual(h.sleeps, [30000]);
  assert.deepEqual(h.events, ['update:1', 'read:1', 'sleep:30000', 'update:2', 'read:2']);
  assert.deepEqual(finalState, { status: statusWith('genshin', null), posts: {} });
});

test('注入退避大于2项仍最多3轮，且只按前两项等待', async () => {
  const h = harness({ states: [{ status: statusWith('genshin', transientSource), posts: {} }] });
  const summary = await updateWithRecovery({ ...h, retryDelaysMs: [5, 6, 7, 8, 9] });
  assert.equal(summary.attempts, 3);
  assert.equal(h.passes(), 3);
  assert.deepEqual(h.sleeps, [5, 6]);
});

test('耗尽三轮：保留最终状态、返回remaining且不伪造成功', async () => {
  const posts = { [`zzz:website:166995`]: imageRecord() };
  const state = { status: statusWith('genshin', transientSource), posts };
  const h = harness({ states: [state, state, state, state] });
  const summary = await updateWithRecovery(h);
  assert.equal(summary.attempts, 3);
  assert.equal(summary.recovered, false);
  assert.deepEqual(summary.remaining, [{ kind: 'image', game: 'zzz' }, { kind: 'source', game: 'genshin' }]);
  assert.deepEqual(h.sleeps, [30000, 60000]);
  assert.equal(h.passes(), 3);
  assert.deepEqual(posts, { 'zzz:website:166995': imageRecord() });
});

test('初始即健康：只跑一轮且完全不等待', async () => {
  const h = harness({ states: [{ status: { games: { genshin: { error: null } } }, posts: {} }] });
  const summary = await updateWithRecovery(h);
  assert.deepEqual(summary, { attempts: 1, recovered: true, remaining: [] });
  assert.deepEqual(h.sleeps, []);
  assert.deepEqual(h.events, ['update:1', 'read:1']);
});

test('轮次严格串行：每轮先完成再读状态再等待，峰值并发为1', async () => {
  const state = { status: statusWith('starrail', transientSource), posts: {} };
  const h = harness({ states: [state, state, state] });
  await updateWithRecovery(h);
  assert.equal(h.peak(), 1);
  assert.deepEqual(h.events, ['update:1', 'read:1', 'sleep:30000', 'update:2', 'read:2', 'sleep:60000', 'update:3', 'read:3']);
});

test('子进程失败或状态读取失败立即抛出，不重试也不等待', async () => {
  const bad = harness({ states: [{ status: statusWith('genshin', transientSource), posts: {} }], failUpdateAt: 1 });
  await assert.rejects(updateWithRecovery(bad), { message: 'child-crashed' });
  assert.equal(bad.passes(), 1);
  assert.deepEqual(bad.sleeps, []);

  const unreadable = harness({ states: [{ status: statusWith('genshin', transientSource), posts: {} }], failReadAt: 1 });
  await assert.rejects(updateWithRecovery(unreadable), { message: 'state-unreadable' });
  assert.equal(unreadable.passes(), 1);
  assert.deepEqual(unreadable.sleeps, []);

  await assert.rejects(updateWithRecovery({ readState: async () => ({}) }), TypeError);
});

test('来源错误只有整段固定host:source瞬时列表才可重试', () => {
  assert.deepEqual(recoveryReasons(statusWith('genshin', transientSource), {}), [{ kind: 'source', game: 'genshin' }]);
  for (const code of ['dns', 'connect', 'socket', 'timeout', 'fetch', 'read']) {
    assert.deepEqual(recoveryReasons(statusWith('genshin', `act-api-takumi-static.mihoyo.com：source-${code}`), {}),
      [{ kind: 'source', game: 'genshin' }], code);
  }
  const notRetryable = [
    'act-api-takumi-static.mihoyo.com：source-tls',
    'act-api-takumi-static.mihoyo.com：source-http',
    'act-api-takumi-static.mihoyo.com：source-format',
    'act-api-takumi-static.mihoyo.com：source-size',
    'act-api-takumi-static.mihoyo.com：source-response',
    'act-api-takumi-static.mihoyo.com：source-invalid',
    'source-processing',
    // mixed endpoints: a transient host plus a deterministic host is not purely transient
    'act-api-takumi-static.mihoyo.com：source-connect；api-takumi-static.mihoyo.com：source-tls',
    'act-api-takumi-static.mihoyo.com：source-connect；api-takumi-static.mihoyo.com：source-format',
    // free text, raw bodies, URLs and credentials never qualify
    'act-api-takumi-static.mihoyo.com：source-connect PRIVATE_EXCEPTION',
    '获取失败 https://act-api-takumi-static.mihoyo.com/path?token=SECRET',
    '部分公告隔离或图片字节检查失败；保留对应旧事件',
    '',
  ];
  for (const error of notRetryable) {
    assert.deepEqual(recoveryReasons(statusWith('genshin', error), {}), [], error);
  }
});

test('图片记录需同时满足可重试、未人工锁定、基线绑定与可重试错误码', () => {
  assert.deepEqual(recoveryReasons({ games: {} }, { 'zzz:website:1': imageRecord() }), [{ kind: 'image', game: 'zzz' }]);
  for (const code of ['image-request', 'image-read', 'image-timeout', 'image-fetch']) {
    assert.equal(recoveryReasons({ games: {} }, { 'zzz:website:1': imageRecord({ imageEvidenceErrorCode: code }) }).length, 1, code);
  }
  const http = status => recoveryReasons({ games: {} },
    { 'zzz:website:1': imageRecord({ imageEvidenceErrorCode: 'image-http', imageEvidenceDiagnostic: { httpStatus: status } }) });
  for (const status of [429, 500, 502, 503, 599]) assert.equal(http(status).length, 1, String(status));
  for (const status of [404, 400, 401, 403, 418, 600, undefined]) assert.deepEqual(http(status), [], String(status));

  const blocked = {
    '人工锁定': { imageEvidenceManualReview: true },
    '基线摘要不匹配': { confirmedImageBytesDigest: newDigest },
    '正文摘要缺失': { digest: undefined, confirmedImageBytesDigest: undefined },
    '证书故障': { imageEvidenceDiagnostic: { kind: 'tls', attempts: 3 } },
    '基线为空': { confirmedImageBytes: {} },
    '基线缺失': { confirmedImageBytes: undefined },
    '基线非法': { confirmedImageBytes: { [imageUrl]: 'not-a-digest' } },
    '非必检公告': { imageEvidenceRequired: false },
    '未待审': { imageEvidencePending: false },
    '未标记可重试': { imageEvidenceRetryable: false },
    '预算错误': { imageEvidenceErrorCode: 'image-budget' },
    '格式错误': { imageEvidenceErrorCode: 'image-format' },
    '体积错误': { imageEvidenceErrorCode: 'image-size' },
    '列表为空': { imageEvidenceErrorCode: 'image-empty' },
    '数量超限': { imageEvidenceErrorCode: 'image-count' },
  };
  for (const [label, overrides] of Object.entries(blocked)) {
    assert.deepEqual(recoveryReasons({ games: {} }, { 'zzz:website:1': imageRecord(overrides) }), [], label);
  }
  // 预算错误即便遗留 retryable=true 也不得触发重试
  assert.deepEqual(recoveryReasons({ games: {} },
    { 'zzz:website:1': imageRecord({ imageEvidenceErrorCode: 'image-budget', imageEvidenceRetryable: true }) }), []);
  // 非对象/分隔异常记录被忽略
  assert.deepEqual(recoveryReasons({ games: {} }, { 'zzz:website:1': null, 'genshin:website:2': [], bare: imageRecord() }), []);
});

test('真实图片检查链路：正文变更→网络失败→回滚后人工锁仍锁，字节基线未变', async () => {
  const baseline = { imageEvidenceRequired: true, confirmedImageBytes: { [imageUrl]: sha('image') }, confirmedImageBytesDigest: oldDigest };
  const changedContext = { expectedDigest: oldDigest, digest: newDigest, now: '2026-10-21T00:00:00Z' };
  const changed = await createImageEvidenceChecker({ request: async () => imageBody() })({ images: [imageUrl] }, baseline, changedContext);
  assert.equal(changed.fields.imageEvidenceManualReview, true);
  const afterChange = { ...baseline, digest: newDigest, ...changed.fields };

  const failed = await createImageEvidenceChecker({ retryDelaysMs: [0, 0], request: async () => { throw fault('ENOTFOUND'); } })(
    { images: [imageUrl] }, afterChange, changedContext);
  assert.equal(failed.fields.imageEvidenceRetryable, true);
  assert.equal(failed.fields.imageEvidenceManualReview, true);
  const afterFailure = { ...afterChange, ...failed.fields };

  // 正文回滚到人工确认摘要，图片字节未变：仍须人工复核，锁不清除。
  const reverted = await createImageEvidenceChecker({ request: async () => imageBody() })(
    { images: [imageUrl] }, afterFailure, { expectedDigest: oldDigest, digest: oldDigest, now: '2026-10-21T00:00:00Z' });
  assert.equal(reverted.needsReview, true);
  assert.equal(reverted.fields.imageEvidenceManualReview, true);
  assert.deepEqual(reverted.fields.observedImageBytes, baseline.confirmedImageBytes);
  const afterRevert = { ...afterFailure, digest: oldDigest, ...reverted.fields };

  // 回滚后再次网络失败：除人工锁外所有可重试条件都满足，仍不得被当作可重试。
  const latched = await createImageEvidenceChecker({ retryDelaysMs: [0, 0], request: async () => { throw fault('ECONNRESET'); } })(
    { images: [imageUrl] }, afterRevert, { expectedDigest: oldDigest, digest: oldDigest, now: '2026-10-21T00:00:00Z' });
  const latchedRecord = { ...afterRevert, ...latched.fields };
  assert.equal(latchedRecord.imageEvidencePending, true);
  assert.equal(latchedRecord.imageEvidenceRetryable, true);
  assert.equal(latchedRecord.imageEvidenceManualReview, true);
  assert.equal(latchedRecord.imageEvidenceErrorCode, 'image-request');
  assert.equal(latchedRecord.confirmedImageBytesDigest, latchedRecord.digest);
  assert.deepEqual(latchedRecord.confirmedImageBytes, baseline.confirmedImageBytes);
  assert.deepEqual(recoveryReasons({ games: {} }, { 'zzz:website:166995': latchedRecord }), []);

  // 同一轮里来源瞬时失败与人工锁定并存：只有来源触发重试，人工锁保持不动。
  const posts = { 'zzz:website:166995': structuredClone(latchedRecord) };
  const h = harness({ states: [{ status: statusWith('genshin', transientSource), posts }, { status: statusWith('genshin', null), posts }] });
  const summary = await updateWithRecovery(h);
  assert.equal(summary.attempts, 2);
  assert.deepEqual(summary.remaining, []);
  assert.deepEqual(h.sleeps, [30000]);
  assert.deepEqual(posts['zzz:website:166995'], latchedRecord);
  assert.equal(posts['zzz:website:166995'].imageEvidenceManualReview, true);
  assert.equal(posts['zzz:website:166995'].imageEvidencePending, true);
});

test('理由与日志只含固定kind和game：不含原始错误、URL、主机、凭据或正文', async () => {
  const posts = { 'zzz:website:166995': imageRecord({ imageEvidenceLastRaw: 'PRIVATE_BODY token=SECRET' }) };
  const state = { status: statusWith('genshin', transientSource), posts };
  const reasons = recoveryReasons(state.status, posts);
  assert.deepEqual(reasons, [{ kind: 'image', game: 'zzz' }, { kind: 'source', game: 'genshin' }]);
  const serialized = JSON.stringify(reasons);
  assert.doesNotMatch(serialized, /PRIVATE|SECRET|https|mihoyo|source-connect|image-request|token/);

  const h = harness({ states: [state, state, state] });
  await updateWithRecovery(h);
  assert.equal(h.logs.length, 3);
  const logged = h.logs.map(line => JSON.parse(line));
  assert.deepEqual(logged.map(entry => entry.phase), ['retry', 'retry', 'exhausted']);
  assert.deepEqual(logged.map(entry => entry.attempts), [1, 2, 3]);
  assert.deepEqual(logged[2].remaining, ['image:zzz', 'source:genshin']);
  assert.doesNotMatch(h.logs.join('\n'), /PRIVATE|SECRET|https|mihoyo|source-connect|image-request|token/);
});

class FakeChild extends EventEmitter {
  constructor() { super(); this.exitCode = null; this.signalCode = null; }
}

const fakeSpawn = recorder => (command, args, options) => {
  const child = new FakeChild();
  recorder.push({ command, args, options, child });
  return child;
};

test('CLI 每次通过新子进程在仓库根执行既有 update.mjs，继承stdio与execArgv', async () => {
  const calls = [];
  const pass = createUpdatePass({ spawnChild: fakeSpawn(calls), execPath: '/fake/node', execArgv: ['--experimental-loader=./fixture.mjs'] });
  const running = pass();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, '/fake/node');
  assert.deepEqual(calls[0].args, ['--experimental-loader=./fixture.mjs', UPDATE_SCRIPT]);
  assert.equal(calls[0].options.cwd, ROOT);
  assert.equal(calls[0].options.stdio, 'inherit');
  assert.equal(path.basename(UPDATE_SCRIPT), 'update.mjs');
  assert.equal(path.dirname(UPDATE_SCRIPT), path.join(ROOT, 'scripts'));
  calls[0].child.emit('exit', 0, null);
  await running;
});

test('CLI 子进程非零退出、信号终止、spawn失败与状态读取失败都不被吞掉', async () => {
  for (const [exit, signal, message] of [[1, null, 'update-child-exit-1'], [null, 'SIGKILL', 'update-child-signal-SIGKILL']]) {
    const calls = [];
    const pass = createUpdatePass({ spawnChild: fakeSpawn(calls), execPath: '/fake/node', execArgv: [] });
    const running = pass();
    calls[0].child.emit('exit', exit, signal);
    await assert.rejects(running, { message });
  }
  const calls = [];
  const throwing = createUpdatePass({ spawnChild: () => { throw new Error('spawn-failed'); }, execPath: '/fake/node', execArgv: [] });
  await assert.rejects(throwing(), { message: 'spawn-failed' });
  const spawnError = createUpdatePass({ spawnChild: fakeSpawn(calls), execPath: '/fake/node', execArgv: [] })();
  calls[0].child.emit('error', new Error('ENOENT'));
  await assert.rejects(spawnError, { message: 'ENOENT' });
});

test('CLI main：单轮成功后即返回，子进程失败直接抛出且不重试', async () => {
  const ok = harness({ states: [{ status: { games: {} }, posts: {} }] });
  assert.deepEqual(await main({ update: ok.update, readState: ok.readState, sleep: ok.sleep, log: ok.log }),
    { attempts: 1, recovered: true, remaining: [] });

  let passes = 0;
  await assert.rejects(main({
    update: async () => { passes++; throw new Error('update-child-exit-2'); },
    readState: async () => ({ status: {}, posts: {} }),
    sleep: () => assert.fail('不应等待'),
    log: () => assert.fail('不应记录'),
  }), { message: 'update-child-exit-2' });
  assert.equal(passes, 1);
});
