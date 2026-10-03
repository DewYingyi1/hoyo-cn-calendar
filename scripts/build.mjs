import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAMES, renderCalendar, validateEvent, readerNotes } from '../lib/calendar.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(path.join(ROOT, file), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(path.join(ROOT, file)), { recursive: true });
  const target = path.join(ROOT, file);
  await fs.writeFile(target + '.tmp', JSON.stringify(value, null, 2) + '\n');
  await fs.rename(target + '.tmp', target);
}
export async function build() {
  const events = await readJson('data/events.json', []);
  const overrides = await readJson('data/overrides.json', { events: [], suppressPostIds: [] });
  const status = await readJson('data/status.json', { games: {}, issues: ['尚未获取公告'], reviewCount: 0 });
  const suppressed = new Set(overrides.suppressPostIds.map(String));
  const active = events.filter(event => !suppressed.has(event.id) && !suppressed.has(event.id.split(':')[2]) && !overrides.events.some(manual => manual.id.startsWith(event.id + ':')));
  const map = new Map(active.map(event => [event.id, event]));
  for (const event of overrides.events) { validateEvent(event); map.set(event.id, event); }
  const final = [...map.values()];
  await fs.mkdir(path.join(ROOT, 'site/ics'), { recursive: true });
  const now = new Date().toISOString();
  for (const game of [...Object.keys(GAMES), 'all']) {
    const selected = final.filter(event => game === 'all' || event.game === game);
    for (const mode of ['nodes', 'timeline']) {
      const calendar = renderCalendar(selected, { name: `米哈游国服 · ${game === 'all' ? '全部订阅' : GAMES[game].name}${mode === 'timeline' ? ' · 时间轴' : ' · 开始/截止'}`, mode, now });
      await fs.writeFile(path.join(ROOT, `site/ics/${game}${mode === 'timeline' ? '-timeline' : ''}.ics`), calendar);
    }
  }
  status.generatedAt = now;
  for (const game of Object.keys(GAMES)) {
    status.games[game] ??= {};
    status.games[game].eventCount = final.filter(event => event.game === game && !event.cancelled && Date.parse(event.end ?? event.start) >= Date.now()).length;
  }
  // Maintenance evidence stays in repository data; the public calendar/page needs reader-facing notes.
  await writeJson('site/data/events.json', final.map(event => ({ ...event, notes: readerNotes(event) })));
  await writeJson('site/data/status.json', status);
  await writeJson('site/data/review.json', await readJson('data/review.json', []));
  await fs.writeFile(path.join(ROOT, 'site/.nojekyll'), '');
  console.log(`生成 ${final.length} 个源事件，${(Object.keys(GAMES).length + 1) * 2} 个 ICS 文件。`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await build();
