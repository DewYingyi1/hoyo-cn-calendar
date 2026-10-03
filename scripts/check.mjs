import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { ROOT, readJson } from './build.mjs';
import { GAMES, validateEvent } from '../lib/calendar.mjs';

const events = await readJson('site/data/events.json', []);
const ids = new Set();
for (const event of events) { validateEvent(event); assert.ok(!ids.has(event.id), `重复：${event.id}`); ids.add(event.id); }
let totalNodes = 0;
for (const game of [...Object.keys(GAMES), 'all']) {
  for (const suffix of ['', '-timeline']) {
    const file = `site/ics/${game}${suffix}.ics`;
    const text = await fs.readFile(path.join(ROOT, file), 'utf8');
    assert.ok(text.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(text.endsWith('END:VCALENDAR\r\n'));
    assert.ok(!text.replaceAll('\r\n', '').includes('\n'), '必须 CRLF');
    for (const line of text.split('\r\n')) assert.ok(Buffer.byteLength(line) <= 75, 'UTF8 折行超长');
    const unfolded = text.replace(/\r\n /g, '');
    const uids = [...unfolded.matchAll(/^UID:(.+)$/gm)].map(match => match[1].trim());
    assert.equal(new Set(uids).size, uids.length, 'UID 重复');
    assert.equal((text.match(/BEGIN:VEVENT/g) ?? []).length, (text.match(/END:VEVENT/g) ?? []).length);
    if (!suffix && game === 'all') totalNodes = uids.length;
    if (game !== 'all') assert.ok(!unfolded.includes('[undefined]'));
  }
}
console.log(`校验通过：${events.length} 源事件，全部订阅节点版 ${totalNodes} 节点，${(Object.keys(GAMES).length + 1) * 2} 个 ICS 格式有效。`);
