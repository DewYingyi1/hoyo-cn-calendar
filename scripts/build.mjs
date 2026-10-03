import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { GAMES, PRESENTATION_REVISION, renderCalendar, validateEvent, readerNotes } from '../lib/calendar.mjs';
import { initializeNodeLedger, reconcileNodeLedger, validateNodeLedger } from '../lib/node-ledger.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_ROOT = path.join(ROOT, '.build');
const LOCK_DIR = path.join(BUILD_ROOT, 'publish.lock');
const TRANSACTIONS_DIR = path.join(BUILD_ROOT, 'transactions');
const LOCK_PORT = 20000 + Number.parseInt(createHash('sha256').update(ROOT.toLowerCase()).digest('hex').slice(0, 8), 16) % 40000;
const lockContext = new AsyncLocalStorage();
const activeLockTokens = new Set();
const MODES = ['nodes', 'timeline'];
const games = () => [...Object.keys(GAMES), 'all'];
const icsPath = (game, mode) => `site/ics/${game}${mode === 'timeline' ? '-timeline' : ''}.ics`;
const expectedIcs = () => games().flatMap(game => MODES.map(mode => icsPath(game, mode)));
const jsonText = value => JSON.stringify(value, null, 2) + '\n';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(path.join(ROOT, file), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

// Non-build maintenance writers still use this helper. A unique same-directory file
// avoids concurrent callers sharing the old fixed .tmp name.
export async function writeJson(file, value) {
  const target = path.join(ROOT, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await fs.writeFile(temporary, jsonText(value), { flag: 'wx' });
    await renameRetry(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function parseCalendar(text, label) {
  if (typeof text !== 'string' || !text.startsWith('BEGIN:VCALENDAR\r\n') || !text.endsWith('END:VCALENDAR\r\n')) throw new Error(`${label} 日历边界无效`);
  if (text.replaceAll('\r\n', '').includes('\n')) throw new Error(`${label} 必须使用CRLF`);
  for (const line of text.split('\r\n')) if (Buffer.byteLength(line) > 75) throw new Error(`${label} UTF8折行超长`);
  const unfolded = text.replace(/\r\n[ \t]/g, '');
  if (unfolded.includes('[undefined]')) throw new Error(`${label} 含未定义游戏名`);
  const items = new Map();
  for (const match of unfolded.matchAll(/BEGIN:VEVENT\r\n([\s\S]*?)\r\nEND:VEVENT/g)) {
    const properties = {};
    for (const line of match[1].split('\r\n')) {
      const colon = line.indexOf(':');
      if (colon < 1) throw new Error(`${label} VEVENT属性无效`);
      properties[line.slice(0, colon)] = line.slice(colon + 1);
    }
    if (!properties.UID || items.has(properties.UID)) throw new Error(`${label} UID重复或缺失`);
    items.set(properties.UID, properties);
  }
  if ((unfolded.match(/BEGIN:VEVENT/g) ?? []).length !== items.size || (unfolded.match(/END:VEVENT/g) ?? []).length !== items.size) throw new Error(`${label} VEVENT不完整`);
  return items;
}

function sameItem(first, second) {
  return JSON.stringify(first) === JSON.stringify(second);
}

export function validateBuildBundle(bundle) {
  const expected = new Set([...expectedIcs(), 'site/data/events.json', 'site/data/status.json', 'site/data/review.json', 'data/published-nodes.json', 'site/.nojekyll']);
  if (!(bundle?.files instanceof Map) || bundle.files.size !== expected.size || [...bundle.files.keys()].some(file => !expected.has(file))) throw new Error('构建产物集合不完整');
  const calendars = new Map(expectedIcs().map(file => [file, parseCalendar(bundle.files.get(file), file)]));
  for (const mode of MODES) {
    const all = calendars.get(icsPath('all', mode));
    const union = new Map();
    for (const game of Object.keys(GAMES)) {
      for (const [uid, item] of calendars.get(icsPath(game, mode))) {
        if (union.has(uid)) throw new Error(`${mode} 单游戏日历UID交叉：${uid}`);
        union.set(uid, item);
      }
    }
    if (union.size !== all.size) throw new Error(`${mode} 全部订阅与单游戏并集数量不一致`);
    for (const [uid, item] of union) if (!sameItem(item, all.get(uid))) throw new Error(`${mode} 全部订阅与单游戏事件不一致：${uid}`);
  }
  const publicEvents = JSON.parse(bundle.files.get('site/data/events.json'));
  const status = JSON.parse(bundle.files.get('site/data/status.json'));
  JSON.parse(bundle.files.get('site/data/review.json'));
  const ledger = JSON.parse(bundle.files.get('data/published-nodes.json'));
  validateNodeLedger(ledger);
  if (!Array.isArray(publicEvents) || publicEvents.some(event => event.cancelled)) throw new Error('公开事件集合无效');
  for (const event of publicEvents) validateEvent(event);
  if (status.generatedAt !== bundle.generatedAt) throw new Error('公开状态构建时间不一致');
  const nowMs = Date.parse(bundle.generatedAt);
  for (const game of Object.keys(GAMES)) {
    const count = bundle.final.filter(event => event.game === game && !event.cancelled && Date.parse(event.end ?? event.start) >= nowMs).length;
    if (status.games?.[game]?.eventCount !== count) throw new Error(`${game} 公开事件计数不一致`);
  }
  for (const mode of MODES) {
    const all = calendars.get(icsPath('all', mode));
    const plan = bundle.publishedNodes[mode];
    if (all.size !== plan.length) throw new Error(`${mode} ICS与发布计划数量不一致`);
    for (const { event, node } of plan) {
      const item = all.get(node.uid);
      if (!item) throw new Error(`${mode} ICS缺账本UID：${node.uid}`);
      const expectedStatus = node.cancelled ? 'CANCELLED' : 'CONFIRMED';
      if (item.STATUS !== expectedStatus || Number(item.SEQUENCE) !== node.sequence + PRESENTATION_REVISION) throw new Error(`${mode} ICS与账本状态或修订不一致：${node.uid}`);
      const gameItem = calendars.get(icsPath(event.game, mode)).get(node.uid);
      if (!gameItem || !sameItem(item, gameItem)) throw new Error(`${mode} 节点未进入正确游戏日历：${node.uid}`);
    }
  }
  return bundle;
}

function validateBaselineCalendars(values) {
  const found = values.filter(value => value !== null).length;
  if (found && found !== values.length) throw new Error('公开ICS基线不完整；须同时保留全部8份ICS');
  if (!found) return;
  const map = new Map(expectedIcs().map((file, index) => [file, parseCalendar(values[index], file)]));
  for (const mode of MODES) {
    const all = map.get(icsPath('all', mode));
    const union = new Map();
    for (const game of Object.keys(GAMES)) for (const [uid, item] of map.get(icsPath(game, mode))) {
      if (union.has(uid)) throw new Error(`公开基线单游戏UID交叉：${uid}`);
      union.set(uid, item);
    }
    if (union.size !== all.size || [...union].some(([uid, item]) => !sameItem(item, all.get(uid)))) throw new Error('公开ICS基线全部订阅与单游戏并集不一致');
  }
}

export async function renderBuildBundle({ now = new Date().toISOString() } = {}) {
  if (!Number.isFinite(Date.parse(now))) throw new Error('构建时间无效');
  const [events, overrides, sourceStatus, review, aliases] = await Promise.all([
    readJson('data/events.json', []),
    readJson('data/overrides.json', { events: [], suppressPostIds: [], replaceParentIds: [] }),
    readJson('data/status.json', { games: {}, issues: ['尚未获取公告'], reviewCount: 0 }),
    readJson('data/review.json', []),
    readJson('data/aliases.json', {}),
  ]);
  const suppressed = new Set((overrides.suppressPostIds ?? []).map(String));
  const replaced = new Set((overrides.replaceParentIds ?? []).map(String));
  const explicitlyRemoved = events.filter(event => suppressed.has(event.id) || suppressed.has(event.id.split(':')[2]) || replaced.has(event.id)).map(event => event.id);
  const active = events.filter(event => !explicitlyRemoved.includes(event.id));
  const map = new Map(active.map(event => [event.id, event]));
  for (const event of overrides.events ?? []) { validateEvent(event); map.set(event.id, event); }
  const final = [...map.values()];

  let previousLedger = await readJson('data/published-nodes.json', null);
  if (!previousLedger) {
    const baselineValues = await Promise.all(expectedIcs().map(async file => {
      try { return await fs.readFile(path.join(ROOT, file), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }));
    validateBaselineCalendars(baselineValues);
    const hasBaseline = baselineValues[0] !== null;
    const publicBaseline = await readJson('site/data/events.json', null);
    const baselineStatus = await readJson('site/data/status.json', null);
    if (hasBaseline && (!publicBaseline || !baselineStatus || !Number.isFinite(Date.parse(baselineStatus.generatedAt)))) throw new Error('公开事件或状态基线缺失');
    const calendars = hasBaseline ? {
      nodes: baselineValues[expectedIcs().indexOf(icsPath('all', 'nodes'))],
      timeline: baselineValues[expectedIcs().indexOf(icsPath('all', 'timeline'))],
    } : undefined;
    previousLedger = initializeNodeLedger(hasBaseline ? publicBaseline : [], {
      now: hasBaseline ? baselineStatus.generatedAt : now,
      publicBaseline: hasBaseline,
      calendars,
    });
  }
  const { ledger, publishedNodes } = reconcileNodeLedger(previousLedger, final, { now, aliases, explicitRemovals: explicitlyRemoved });
  const status = structuredClone(sourceStatus);
  status.generatedAt = now;
  const nowMs = Date.parse(now);
  for (const game of Object.keys(GAMES)) {
    status.games[game] ??= {};
    status.games[game].eventCount = final.filter(event => event.game === game && !event.cancelled && Date.parse(event.end ?? event.start) >= nowMs).length;
  }
  const files = new Map();
  for (const game of games()) for (const mode of MODES) {
    const selected = final.filter(event => game === 'all' || event.game === game);
    const name = `米哈游国服 · ${game === 'all' ? '全部订阅' : GAMES[game].name}${mode === 'timeline' ? ' · 时间轴' : ' · 开始/截止'}`;
    files.set(icsPath(game, mode), renderCalendar(selected, { name, mode, now, publishedNodes: publishedNodes[mode].filter(({ event }) => game === 'all' || event.game === game) }));
  }
  files.set('site/data/events.json', jsonText(final.filter(event => !event.cancelled).map(event => ({ ...event, notes: readerNotes(event) }))));
  files.set('site/data/status.json', jsonText(status));
  files.set('site/data/review.json', jsonText(review));
  files.set('data/published-nodes.json', jsonText(ledger));
  files.set('site/.nojekyll', '');
  return validateBuildBundle({ generatedAt: now, files, final, publishedNodes });
}

async function renameRetry(source, target) {
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(source, target); return; }
    catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

async function hashFile(file) {
  try { return sha256(await fs.readFile(file)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function syncFile(file) {
  // Windows rejects FlushFileBuffers on a read-only handle.
  const handle = await fs.open(file, 'r+');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fs.open(directory, 'r');
    await handle.sync();
  } catch (error) {
    // Windows does not consistently allow opening directory handles. File fsync still
    // protects contents there; POSIX additionally persists directory entries here.
    if (!['EACCES', 'EPERM', 'EINVAL', 'EISDIR', 'EBADF'].includes(error.code)) throw error;
  } finally { await handle?.close(); }
}

async function writeDurable(file, content, options) {
  const handle = await fs.open(file, options?.flag ?? 'w');
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally { await handle.close(); }
}

async function writeJournal(directory, journal) {
  const target = path.join(directory, 'journal.json');
  const temporary = path.join(directory, `journal-${randomUUID()}.tmp`);
  await writeDurable(temporary, jsonText(journal), { flag: 'wx' });
  await renameRetry(temporary, target);
  await syncDirectory(directory);
}

async function restoreTransaction(directory, journal) {
  for (const file of journal.files) {
    const target = path.join(ROOT, file.path);
    if (!file.existed) {
      await fs.rm(target, { force: true });
      await syncDirectory(path.dirname(target));
      continue;
    }
    const backup = path.join(directory, 'previous', file.path);
    const temporary = `${target}.rollback-${randomUUID()}`;
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(backup, temporary);
    await syncFile(temporary);
    try {
      await renameRetry(temporary, target);
      await syncDirectory(path.dirname(target));
    }
    finally { await fs.rm(temporary, { force: true }).catch(() => {}); }
  }
  for (const file of journal.files) if (await hashFile(path.join(ROOT, file.path)) !== file.oldHash) throw new Error(`构建回滚校验失败：${file.path}`);
}

async function recoverTransactions() {
  await fs.mkdir(TRANSACTIONS_DIR, { recursive: true });
  for (const entry of await fs.readdir(TRANSACTIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(TRANSACTIONS_DIR, entry.name);
    let journal;
    try { journal = JSON.parse(await fs.readFile(path.join(directory, 'journal.json'), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') { await fs.rm(directory, { recursive: true, force: true }); continue; }
      throw error;
    }
    if (journal.state === 'staging') { await fs.rm(directory, { recursive: true, force: true }); continue; }
    if (!Array.isArray(journal.files)) throw new Error(`构建事务日志损坏：${entry.name}`);
    const hashes = await Promise.all(journal.files.map(file => hashFile(path.join(ROOT, file.path))));
    const allNew = hashes.every((hash, index) => hash === journal.files[index].newHash);
    const allOld = hashes.every((hash, index) => hash === journal.files[index].oldHash);
    const known = hashes.every((hash, index) => hash === journal.files[index].oldHash || hash === journal.files[index].newHash);
    if (journal.state === 'complete') {
      if (!allNew) {
        if (!known) throw new Error(`已完成构建事务目标遭外部修改：${entry.name}`);
        await restoreTransaction(directory, journal);
      }
      await fs.rm(directory, { recursive: true, force: true });
      continue;
    }
    if (journal.state !== 'prepared') throw new Error(`构建事务状态无效：${entry.name}`);
    if (allNew || allOld) { await fs.rm(directory, { recursive: true, force: true }); continue; }
    if (!known) throw new Error(`构建事务目标遭外部修改：${entry.name}`);
    await restoreTransaction(directory, journal);
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function acquireLock() {
  await fs.mkdir(BUILD_ROOT, { recursive: true });
  const token = randomUUID();
  const server = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => {
    const failed = error => reject(Object.assign(new Error(error.code === 'EADDRINUSE' ? '已有构建持有发布锁' : `发布锁端口失败：${error.code}`), { cause: error }));
    server.once('error', failed);
    server.listen({ host: '127.0.0.1', port: LOCK_PORT, exclusive: true }, () => { server.off('error', failed); resolve(); });
  }).catch(async error => { await new Promise(resolve => server.close(resolve)).catch(() => {}); throw error; });
  const owner = { token, pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString(), port: LOCK_PORT, server };
  // The kernel mutex is authoritative. Any directory left here belongs to a dead
  // process because no second live process can own this repository's lock port.
  await fs.rm(LOCK_DIR, { recursive: true, force: true });
  await fs.mkdir(LOCK_DIR);
  await writeDurable(path.join(LOCK_DIR, 'owner.json'), jsonText({ ...owner, server: undefined }), { flag: 'wx' });
  await syncDirectory(LOCK_DIR);
  return owner;
}

async function releaseLock(owner) {
  try {
    let current;
    try { current = JSON.parse(await fs.readFile(path.join(LOCK_DIR, 'owner.json'), 'utf8')); } catch {}
    if (current && current.token !== owner.token) throw new Error('发布锁所有权已变化');
    await fs.rm(LOCK_DIR, { recursive: true, force: true });
  } finally {
    await new Promise((resolve, reject) => owner.server.close(error => error ? reject(error) : resolve()));
  }
}

export async function withRepositoryLock(operation) {
  const owner = await acquireLock();
  activeLockTokens.add(owner.token);
  try {
    await recoverTransactions();
    return await lockContext.run(owner.token, operation);
  } finally {
    activeLockTokens.delete(owner.token);
    await releaseLock(owner);
  }
}

export async function commitRepositoryFiles(files, { failStageAt = -1, failCommitAt = -1, pauseCommitAt = -1, pauseMs = 0 } = {}) {
  const token = lockContext.getStore();
  if (!token || !activeLockTokens.has(token)) throw new Error('仓库事务必须在发布锁内执行');
  const id = randomUUID();
  const directory = path.join(TRANSACTIONS_DIR, id);
  const next = path.join(directory, 'next');
  const previous = path.join(directory, 'previous');
  await fs.mkdir(next, { recursive: true });
  await syncDirectory(TRANSACTIONS_DIR);
  let journal = { version: 1, id, state: 'staging', files: [] };
  try {
    await writeJournal(directory, journal);
    if (!(files instanceof Map) || !files.size) throw new Error('提交文件集合为空');
    for (const [index, [relative, content]] of [...files].entries()) {
      if (index === failStageAt) throw new Error(`测试暂存故障：${index}`);
      if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || typeof content !== 'string' && !Buffer.isBuffer(content)) throw new Error(`提交文件无效：${relative}`);
      const staged = path.join(next, relative);
      await fs.mkdir(path.dirname(staged), { recursive: true });
      await writeDurable(staged, content, { flag: 'wx' });
      await syncDirectory(path.dirname(staged));
      const target = path.join(ROOT, relative);
      const oldHash = await hashFile(target);
      const newHash = sha256(content);
      if (await hashFile(staged) !== newHash) throw new Error(`构建暂存校验失败：${relative}`);
      if (oldHash !== null) {
        const backup = path.join(previous, relative);
        await fs.mkdir(path.dirname(backup), { recursive: true });
        await fs.copyFile(target, backup);
        await syncFile(backup);
        await syncDirectory(path.dirname(backup));
        if (await hashFile(backup) !== oldHash) throw new Error(`构建备份校验失败：${relative}`);
      }
      journal.files.push({ path: relative, existed: oldHash !== null, oldHash, newHash });
    }
    journal = { ...journal, state: 'prepared' };
    await writeJournal(directory, journal);
    for (const [index, file] of journal.files.entries()) {
      if (index === failCommitAt) throw new Error(`测试提交故障：${index}`);
      const target = path.join(ROOT, file.path);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await renameRetry(path.join(next, file.path), target);
      await syncDirectory(path.dirname(target));
      await syncDirectory(path.dirname(path.join(next, file.path)));
      if (index === pauseCommitAt) {
        console.log(`TEST_COMMIT_PAUSED:${index}`);
        await new Promise(resolve => setTimeout(resolve, pauseMs));
      }
    }
    for (const file of journal.files) if (await hashFile(path.join(ROOT, file.path)) !== file.newHash) throw new Error(`构建提交校验失败：${file.path}`);
    await writeJournal(directory, { ...journal, state: 'complete' });
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  } catch (error) {
    if (journal.state === 'prepared') await restoreTransaction(directory, journal);
    await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export const commitBuildBundle = (bundle, options) => commitRepositoryFiles(bundle.files, options);

export async function build(options = {}) {
  return withRepositoryLock(async () => {
    const bundle = await renderBuildBundle({ now: options.now });
    await commitBuildBundle(bundle, options);
    console.log(`生成 ${bundle.final.length} 个源事件，${expectedIcs().length} 个 ICS 文件。`);
    return bundle;
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await build();
