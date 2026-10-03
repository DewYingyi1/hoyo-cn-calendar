import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { approveImageEvidence } from '../lib/image-evidence.mjs';
import { readJson, writeJson, withRepositoryLock } from './build.mjs';

export async function approve(key) {
  return withRepositoryLock(async () => {
  if (!/^(genshin|starrail|zzz):website:\d+$/.test(key ?? '')) throw new Error('须提供官网公告键，例如 genshin:website:166263');
  const posts = await readJson('data/posts.json', {});
  const confirmations = await readJson('data/confirmations.json', {});
  if (!posts[key]) throw new Error(`没有公告记录：${key}`);
  if (!confirmations[key]) throw new Error(`当前正文尚未人工确认：${key}`);
  posts[key] = approveImageEvidence(posts[key], confirmations[key]);
  await writeJson('data/posts.json', posts);
  return posts[key];
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const key = process.argv[2];
  await approve(key);
  console.log(`图片字节基线已绑定当前人工确认正文：${key}`);
}
