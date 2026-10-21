import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { normalizeWebsite } from '../lib/sources.mjs';
import { postDigest, imageDigest } from '../lib/parser.mjs';
import { updateWithRecovery } from '../lib/update-recovery.mjs';

test('真实更新跨三轮恢复来源和图片网络失败，旧事件和人工改图锁均保留', async () => {
  const temporary = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : path.join(os.tmpdir(), 'opencode');
  await fs.mkdir(temporary, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(temporary, 'hoyo-recovery-integration-'));
  const put = async (file, value) => {
    await fs.mkdir(path.dirname(path.join(sandbox, file)), { recursive: true });
    await fs.writeFile(path.join(sandbox, file), typeof value === 'string' ? value : JSON.stringify(value));
  };
  const get = async file => JSON.parse(await fs.readFile(path.join(sandbox, file), 'utf8'));
  const hash = value => createHash('sha256').update(value).digest('hex');
  try {
    await fs.cp(new URL('../lib/', import.meta.url), path.join(sandbox, 'lib'), { recursive: true });
    await put('scripts/update.mjs', await fs.readFile(new URL('../scripts/update.mjs', import.meta.url), 'utf8'));
    await put('scripts/build.mjs', `import fs from 'node:fs/promises';
      export const ROOT = ${JSON.stringify(sandbox)};
      export async function readJson(file, fallback) { try { return JSON.parse(await fs.readFile(ROOT+'/'+file,'utf8')); } catch(e) { if(e.code==='ENOENT') return fallback; throw e; } }
      export async function commitRepositoryFiles(files) {
        for(const [file,value] of files) { await fs.mkdir(ROOT+'/'+file.split('/').slice(0,-1).join('/'),{recursive:true}); await fs.writeFile(ROOT+'/'+file,value); }
        await fs.appendFile(ROOT+'/commits.txt','commit\\n');
      }
      export async function withRepositoryLock(operation) { return operation(); }
    `);
    const config = { website: { base: 'https://api.mihoyo.com', fallbackBases: ['https://backup.mihoyo.com'], app: 'test', channel: 1, urlBase: 'https://ys.mihoyo.com/main/news/detail/' } };
    const list = [1, 2].map(id => ({ iInfoId: id, sTitle: `测试活动${id}`, dtStartTime: '2026-10-21 10:00:00',
      sContent: `<p>活动时间：2026/10/22 10:00 ~ 2026/11/30 03:59</p><img src="https://fastcdn.mihoyo.com/${id}.png">` }));
    const registry = {};
    const confirmations = {};
    for (const item of list) {
      const post = normalizeWebsite(item, 'genshin', config);
      const digest = postDigest(post), imagesHash = imageDigest(post);
      const key = 'genshin:website:' + item.iInfoId;
      confirmations[key] = digest;
      registry[key] = { title: post.title, digest, reviewedDigest: digest, imagesHash,
        confirmedImagesHash: imagesHash, confirmedImagesDigest: digest, imageEvidenceRequired: true,
        confirmedImageBytes: { [post.images[0]]: hash('old-bytes') }, confirmedImageBytesDigest: digest };
    }
    const oldEvents = list.map(item => ({ id: 'genshin:website:' + item.iInfoId, game: 'genshin', category: 'event',
      title: item.sTitle, start: '2026-10-22T10:00:00+08:00', end: '2026-11-30T03:59:00+08:00',
      url: config.website.urlBase + item.iInfoId, modified: '2026-10-21T10:00:00Z', sequence: 4 }));
    const overrides = { events: [], suppressPostIds: oldEvents.map(e => e.id) };
    for (const [file, value] of Object.entries({ 'sources/games.json': { genshin: config }, 'data/posts.json': registry,
      'data/events.json': oldEvents, 'data/confirmations.json': confirmations, 'data/aliases.json': {},
      'data/overrides.json': overrides, 'data/review.json': [], 'data/status.json': { games: {} } })) await put(file, value);
    await put('fixture.mjs', `import fs from 'node:fs/promises';
      const phase=Number(await fs.readFile(${JSON.stringify(path.join(sandbox, 'phase.txt'))},'utf8'));
      globalThis.fetch=async url=>{
        if(url.includes('/getContentList?')) {
          if(phase===1) throw Object.assign(new Error('PRIVATE_NETWORK'),{code:'ECONNREFUSED'});
          return new Response(${JSON.stringify(JSON.stringify({ retcode: 0, data: { list, iTotal: 2 } }))},{headers:{'content-type':'application/json'}});
        }
        if(phase===2&&url.endsWith('/1.png')) throw Object.assign(new Error('PRIVATE_NETWORK'),{code:'ECONNREFUSED'});
        return new Response(phase===2&&url.endsWith('/2.png')?'new-bytes':'old-bytes',{headers:{'content-type':'image/png'}});
      };
    `);
    let phase = 0;
    const observed = [], sleeps = [];
    await updateWithRecovery({
      update: async () => {
        await put('phase.txt', String(++phase));
        const result = await promisify(execFile)(process.execPath, ['--import', pathToFileURL(path.join(sandbox, 'fixture.mjs')).href, path.join(sandbox, 'scripts/update.mjs')], {
          cwd: sandbox, timeout: 20000, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH },
        });
        assert.doesNotMatch(result.stdout + result.stderr, /PRIVATE_NETWORK/);
        observed.push(await get('data/status.json'));
        assert.deepEqual(await get('data/events.json'), oldEvents);
      },
      readState: async () => ({ status: await get('data/status.json'), posts: await get('data/posts.json') }),
      sleep: async ms => sleeps.push(ms), log: () => {},
    });
    assert.equal(phase, 3);
    assert.deepEqual(sleeps, [30000, 60000]);
    assert.equal(observed[0].successfulSources, 0);
    assert.equal(observed[1].partialSources, 1);
    assert.equal(observed[2].successfulSources, 1);
    assert.equal(observed[2].reviewCount, 1);
    const finalPosts = await get('data/posts.json');
    assert.equal(finalPosts['genshin:website:1'].imageEvidencePending, false);
    assert.equal(finalPosts['genshin:website:2'].imageEvidencePending, true);
    assert.equal(finalPosts['genshin:website:2'].imageEvidenceManualReview, true);
    for (const key of Object.keys(registry)) assert.deepEqual(finalPosts[key].confirmedImageBytes, registry[key].confirmedImageBytes);
    assert.deepEqual(await get('data/confirmations.json'), confirmations);
    assert.deepEqual(await get('data/overrides.json'), overrides);
    assert.equal((await fs.readFile(path.join(sandbox, 'commits.txt'), 'utf8')).trim().split('\n').length, 3);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});
