// Collection entry point with bounded transient-failure recovery.
//
// Each pass is a brand-new Node child that runs the existing scripts/update.mjs
// unchanged, with inherited stdio and the repository root as working directory. The
// child is fully awaited, so it exits and releases the repository lock before this
// process reads state or waits; passes never overlap. Only transient failures
// (see lib/update-recovery.mjs) may earn another pass, at most three passes total,
// separated by 30s and then 60s. This script never builds, notifies, commits or
// pushes: the workflow keeps owning those steps.
import path from 'node:path';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ROOT } from './build.mjs';
import { updateWithRecovery } from '../lib/update-recovery.mjs';

export const UPDATE_SCRIPT = path.join(ROOT, 'scripts', 'update.mjs');

// One collection pass in a fresh child process. Inherited execArgv keeps fixture
// loaders working for import-level testing, and inherited stdio keeps the
// collector's own bounded JSON logs visible in the workflow output.
export function createUpdatePass({ spawnChild = spawn, execPath = process.execPath,
  execArgv = process.execArgv, scriptPath = UPDATE_SCRIPT, cwd = ROOT } = {}) {
  return () => new Promise((resolve, reject) => {
    const child = spawnChild(execPath, [...execArgv, scriptPath], { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      // A killed or failed pass must surface as-is: masking it as a retryable
      // transient failure would hide a real collection bug.
      if (signal) { reject(new Error(`update-child-signal-${signal}`)); return; }
      if (code !== 0) { reject(new Error(`update-child-exit-${code}`)); return; }
      resolve();
    });
  });
}

// Only the persisted state is inspected, and only after the pass has finished.
export async function readCollectionState() {
  const [status, posts] = await Promise.all([
    fs.readFile(path.join(ROOT, 'data/status.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(ROOT, 'data/posts.json'), 'utf8').then(JSON.parse),
  ]);
  return { status, posts };
}

// Exhaustion is a normal return: the pass keeps the retained old schedules and the
// summary reports what is still eligible, so the workflow's existing health gate and
// manual review flow decide what happens next. Hard child or state-read failures are
// never caught here, so they still fail the step.
export async function main({ update = createUpdatePass(), readState = readCollectionState, ...options } = {}) {
  return updateWithRecovery({ update, readState, log: line => console.log(line), ...options });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
