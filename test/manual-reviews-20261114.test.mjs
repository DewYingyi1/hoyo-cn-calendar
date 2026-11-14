import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateEvent,calendarNodes} from '../lib/calendar.mjs';
import {renderBuildBundle} from '../scripts/build.mjs';

const read=async n=>JSON.parse(await fs.readFile(new URL(`../data/${n}.json`,import.meta.url),'utf8'));
const key='starrail:website:167300';
const digest='79dff2465f86292d87c9858295a33b7adc3c39956b07be7723b796cc26747823';
const sha=v=>createHash('sha256').update(v).digest('hex');

test('167300仅补5项独有日程，跨年挑战窗口与补偿语义不混用',async()=>{
  const o=await read('overrides');
  const expected={
    echo:[null,'2026-12-23T03:59:00+08:00'],
    'challenge-1':['2026-11-16T04:00:00+08:00','2026-12-28T03:59:00+08:00'],
    'challenge-2':['2026-11-30T04:00:00+08:00','2027-01-11T03:59:00+08:00'],
    'challenge-3':['2026-12-14T04:00:00+08:00','2027-01-25T03:59:00+08:00'],
    'fix-compensation':[null,'2026-12-11T23:59:00+08:00'],
  };
  const items=o.events.filter(e=>e.id.startsWith(key+':'));assert.equal(items.length,5);
  for(const [suffix,window] of Object.entries(expected)){
    const e=items.find(e=>e.id===`${key}:${suffix}`);assert.ok(e);validateEvent(e);
    assert.deepEqual([e.start,e.end],window);assert.equal(e.url,'https://sr.mihoyo.com/news/167300');
    assert.equal(calendarNodes(e).length,e.start?2:1);
  }
  assert.equal(items.find(e=>e.id===`${key}:echo`).startText,'2026/11/11 4.7版本更新后');
  const fix=items.find(e=>e.id===`${key}:fix-compensation`);
  assert.match(fix.title,/上线收取邮件/);assert.match(fix.displayNotes,/2026\/11\/11 06:00/);assert.equal(fix.startText,undefined);
});

test('167300重复维护父项不发布，已有福利与独立活动截止及身份保留',async()=>{
  const o=await read('overrides');assert.ok(o.replaceParentIds.includes(key));
  const bundle=await renderBuildBundle({now:'2026-11-14T00:00:00.000Z'});
  assert.equal(bundle.final.some(e=>e.id===key),false);
  const maintenance=bundle.final.filter(e=>e.game==='starrail'&&e.category==='maintenance'&&e.start==='2026-11-11T06:00:00+08:00');
  assert.equal(maintenance.length,1);assert.equal(maintenance[0].id,'starrail:website:167296');
  const gifts=bundle.final.filter(e=>e.id.startsWith('starrail:website:167107:'));assert.equal(gifts.length,6);
  for(const e of gifts)assert.equal(e.end,'2026-12-23T05:59:00+08:00');
  for(const id of ['167101','167295','167297','167298'])assert.equal(bundle.final.find(e=>e.id===`starrail:website:${id}`).end,'2026-12-23T03:59:00+08:00');
});

test('167300历史审核绑定完整正文与唯一图片字节，内容变化仍允许重新送审',async()=>{
  const audit=await read('audit'),posts=await read('posts'),confirmations=await read('confirmations');
  const records=audit.filter(a=>a.game==='starrail'&&a.source==='website'&&a.postId==='167300'&&a.digest===digest);
  assert.equal(records.length,1);const a=records[0];
  assert.equal(a.decision,'confirmed-official-body-and-all-images');
  assert.equal(Object.keys(a.imageBytes).length,1);assert.equal(sha(JSON.stringify(Object.keys(a.imageBytes))),a.imagesHash);
  assert.equal(Object.values(a.imageBytes)[0],'74f9848154f106cb9c553c380f247c1e7985b881057e530f9d0135904d6b9d91');
  assert.deepEqual(a.evidenceUrls,['https://sr.mihoyo.com/news/167300',...Object.keys(a.imageBytes)]);
  const p=posts[key];
  // 只在当前确认仍为本次基线时检查绑定；后续新正文/新图片应进入待审，不锁死历史摘要。
  if(p.digest===digest&&confirmations[key]===digest&&p.confirmedImagesHash===a.imagesHash){
    assert.equal(p.confirmedImagesDigest,digest);assert.equal(p.confirmedImageBytesDigest,digest);
    assert.deepEqual(p.confirmedImageBytes,a.imageBytes);
  }
});
