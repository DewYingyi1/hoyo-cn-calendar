import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('恢复CLI实际启动子进程并等待落盘，子进程失败时不读取旧成功状态', async () => {
  const tempRoot = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Temp', 'opencode') : path.join(os.tmpdir(), 'opencode');
  await fs.mkdir(tempRoot, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(tempRoot, 'hoyo-recovery-cli-'));
  const put = async (file, value) => {
    await fs.mkdir(path.dirname(path.join(sandbox, file)), { recursive: true });
    await fs.writeFile(path.join(sandbox, file), value);
  };
  try {
    await put('scripts/update-with-recovery.mjs', await fs.readFile(new URL('../scripts/update-with-recovery.mjs', import.meta.url), 'utf8'));
    await put('lib/update-recovery.mjs', await fs.readFile(new URL('../lib/update-recovery.mjs', import.meta.url), 'utf8'));
    await put('scripts/build.mjs', `import fs from 'node:fs/promises';
      export const ROOT=${JSON.stringify(sandbox)};
      export async function readJson(file) { return JSON.parse(await fs.readFile(ROOT+'/'+file,'utf8')); }
    `);
    await put('fixture.mjs', 'globalThis.recoveryFixtureLoaded=true;');
    await put('scripts/update.mjs', `import fs from 'node:fs/promises';
      if(!globalThis.recoveryFixtureLoaded) process.exit(7);
      await fs.mkdir('data',{recursive:true});
      await fs.writeFile('data/status.json',JSON.stringify({games:{genshin:{error:null}},successfulSources:1,completeSources:1,reviewCount:0,issues:[]}));
      await fs.writeFile('data/posts.json','{}');
      await fs.writeFile('completed.txt','done');
    `);
    const run = () => promisify(execFile)(process.execPath, ['--import', pathToFileURL(path.join(sandbox, 'fixture.mjs')).href, path.join(sandbox, 'scripts/update-with-recovery.mjs')], {
      cwd: sandbox, timeout: 10000, env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH },
    });
    await run();
    assert.equal(await fs.readFile(path.join(sandbox, 'completed.txt'), 'utf8'), 'done');
    // Prior healthy snapshots remain in place: failure must still propagate.
    await put('scripts/update.mjs', 'process.exit(7);');
    await assert.rejects(run(), error => error.code !== 0);
  } finally {
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});
