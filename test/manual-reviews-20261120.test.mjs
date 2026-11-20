import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {validateEvent,calendarNodes} from '../lib/calendar.mjs';
import {renderBuildBundle} from '../scripts/build.mjs';

const read=async n=>JSON.parse(await fs.readFile(new URL(`../data/${n}.json`,import.meta.url),'utf8'));
const key=id=>`genshin:website:${id}`;
const cases=[
  ['zzz','167373','53528323b2664baaac117744a05d5970bd57db75ba868385190f3a72833b2f6e',3],
  ['genshin','167387','3697959b009adfff675658059ff89ddf0b706d7fdc1b45ed0a34b0fc0e51c677',3],
  ['genshin','167388','724e2a2e8c469726c08d97527e7eb39b192ee942bd34b2268e62ec18101f9d64',2],
  ['genshin','167386','71a545637f10fce4d82e124613672be442abb42ef2555ed7064b282c705838a8',2],
  ['genshin','167385','0fc4788b7bd971134b9d36dccf38118e4b8d70c45335977c1bd6569d780c21cd',2],
  ['genshin','167384','c3bf80c5ae928a49c9225e7f90a4080e10faaf5f293e868f63d9af62780fc0ff',2],
];
test('11月20日六篇历史审核与14图完整绑定，不把全局待审锁为零',async()=>{
  const audit=await read('audit'),posts=await read('posts'),confirmations=await read('confirmations');
  for(const [game,id,digest,count]of cases){
    const records=audit.filter(a=>a.game===game&&a.source==='website'&&a.postId===id&&a.digest===digest);
    assert.equal(records.length,1,id);const a=records[0],p=posts[`${game}:website:${id}`];
    assert.equal(a.decision,'confirmed-official-body-and-all-images');assert.equal(Object.keys(a.imageBytes).length,count);
    assert.equal(createHash('sha256').update(JSON.stringify(Object.keys(a.imageBytes))).digest('hex'),a.imagesHash);
    assert.ok(Object.values(a.imageBytes).every(h=>/^[a-f0-9]{64}$/.test(h)));
    assert.deepEqual(a.evidenceUrls,[p.url,...Object.keys(a.imageBytes)]);
    assert.equal(p.imageEvidenceRequired,true);
    assert.equal(confirmations[`${game}:website:${id}`],p.reviewedDigest);
    assert.equal(p.confirmedImageBytesDigest,p.reviewedDigest);
    assert.equal(p.confirmedImagesDigest,p.reviewedDigest);
    assert.equal(createHash('sha256').update(JSON.stringify(Object.keys(p.confirmedImageBytes))).digest('hex'),p.confirmedImagesHash);
    // 当前批准基线必须有完整审核；后续正文/图片观察变化仍可送审，不锁死旧digest。
    const current=audit.find(x=>x.game===game&&x.source==='website'&&x.postId===id&&x.digest===p.reviewedDigest
      &&x.imagesHash===p.confirmedImagesHash&&JSON.stringify(x.imageBytes)===JSON.stringify(p.confirmedImageBytes));
    assert.ok(current,id);
  }
});
test('四独立祈愿与合并且试身手使用图中精确时刻，汇总只补两独有活动',async()=>{
  const o=await read('overrides');
  for(const id of ['167384','167385','167386','167388','167384:trial']){
    const e=o.events.find(e=>e.id===key(id));assert.ok(e);validateEvent(e);
    assert.equal(e.start,'2026-11-24T18:00:00+08:00');assert.equal(e.end,'2026-12-15T14:59:00+08:00');
    assert.equal(e.category,id.includes(':trial')?'event':'banner');assert.equal(calendarNodes(e).length,2);
  }
  const summary=o.events.filter(e=>e.id.startsWith(key('167387')+':'));assert.equal(summary.length,2);
  const photo=summary.find(e=>e.id===key('167387:photo')),ley=summary.find(e=>e.id===key('167387:ley-line'));
  assert.deepEqual([photo.start,photo.end],['2026-11-27T10:00:00+08:00','2026-12-07T03:59:00+08:00']);
  assert.deepEqual([ley.start,ley.end],['2026-12-07T04:00:00+08:00','2026-12-14T03:59:00+08:00']);
  assert.ok(o.replaceParentIds.includes(key('167387')));
});
test('公开构建不重复四祈愿、压力方块与角色试用，工具介绍无日程',async()=>{
  const {final}=await renderBuildBundle({now:'2026-11-20T02:00:00.000Z'});
  assert.equal(new Set(final.map(e=>e.id)).size,final.length);
  assert.equal(final.some(e=>e.id===key('167387')),false);
  assert.equal(final.filter(e=>e.id==='zzz:website:167373'||e.id.startsWith('zzz:website:167373:')).length,0);
  for(const id of ['167384','167385','167386','167388'])assert.equal(final.filter(e=>e.id===key(id)&&e.category==='banner').length,1);
  const trials=final.filter(e=>e.game==='genshin'&&e.start==='2026-11-24T18:00:00+08:00'&&e.id.endsWith(':trial'));assert.equal(trials.length,1);
  assert.equal(final.filter(e=>e.game==='genshin'&&e.title.includes('压力方块粉碎计划')).length,1);
  assert.equal(final.filter(e=>e.id===key('167372')).length,1);
});
