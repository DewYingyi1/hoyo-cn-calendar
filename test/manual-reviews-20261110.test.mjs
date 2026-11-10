import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateEvent,calendarNodes} from '../lib/calendar.mjs';
const read=async n=>JSON.parse(await fs.readFile(new URL(`../data/${n}.json`,import.meta.url),'utf8'));
test('167296维护区分预下载，167299八卡池和两试用分别使用官方截止',async()=>{
  const o=await read('overrides');
  const m=o.events.find(x=>x.id==='starrail:website:167296');assert.ok(m);validateEvent(m);
  assert.equal(m.start,'2026-11-11T06:00:00+08:00');assert.equal(m.end,'2026-11-11T11:00:00+08:00');assert.match(m.displayNotes,/预计/);
  const items=o.events.filter(x=>x.id.startsWith('starrail:website:167299:'));
  assert.equal(items.length,10);assert.equal(items.filter(x=>x.category==='banner').length,8);
  assert.ok(o.replaceParentIds.includes('starrail:website:167299'));
  assert.equal(o.events.some(x=>x.id==='starrail:website:167299'),false);
  for(const e of items){validateEvent(e);assert.equal(e.start,null);assert.equal(e.startText,'2026/11/11 4.7版本更新后');assert.equal(calendarNodes(e).length,1);
    assert.equal(e.end,e.id.split(':')[3].includes('aha')?'2026-12-22T15:00:00+08:00':'2026-12-02T11:59:00+08:00');}
});
test('两条审核的历史正文与全部图字节保留证据，后续内容变化允许送审',async()=>{
  const a=await read('audit');
  for(const [id,digest,count]of [['167296','475b6c3efb77d36b1d9d87c875042e7e84bd6751bcc9ebf5562142082799ff31',1],['167299','ea54365361df6960cc7977f40ba02ceed5471ffc91cb4af681c3244f40f4b405',14]]){
    const record=a.find(x=>x.game==='starrail'&&x.source==='website'&&x.postId===id&&x.digest===digest);assert.ok(record);
    assert.equal(Object.keys(record.imageBytes).length,count);
    assert.equal(createHash('sha256').update(JSON.stringify(Object.keys(record.imageBytes))).digest('hex'),record.imagesHash);
    assert.deepEqual(new Set(record.evidenceUrls),new Set([`https://sr.mihoyo.com/news/${id}`,...Object.keys(record.imageBytes)]));
  }
});
