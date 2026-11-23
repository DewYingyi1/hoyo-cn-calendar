import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {renderBuildBundle} from '../scripts/build.mjs';

const read=async n=>JSON.parse(await fs.readFile(new URL(`../data/${n}.json`,import.meta.url),'utf8'));
const key='zzz:website:167401';
const digest='d1751fca0d84f10b3dd070ffa78967c61a1049c7294e430c909f8ef6fcf65ddc';
const imagesHash='c0c2fc1a7db805b771a5f1dd385bccb14d3a16fb6c5eec49931023610e90720f';
const imageSha='6302cb4cf07cd3cd8c50028267afe3de744f37cbc9d714a76e6a4b2d898184bf';
const sha=value=>createHash('sha256').update(value).digest('hex');
const bytesEqual=(a,b)=>JSON.stringify(Object.entries(a??{}).sort(([a],[b])=>a.localeCompare(b)))===JSON.stringify(Object.entries(b??{}).sort(([a],[b])=>a.localeCompare(b)));
const relevant=a=>a.game==='zzz'&&a.source==='website'&&a.postId==='167401';

test('167401工具介绍保留一次历史全文及原图字节审核，当前批准基线须有对应证据',async()=>{
  const audit=await read('audit'),posts=await read('posts'),confirmations=await read('confirmations');
  const historical=audit.filter(a=>relevant(a)&&a.digest===digest&&a.imagesHash===imagesHash&&Object.values(a.imageBytes??{}).length===1&&Object.values(a.imageBytes)[0]===imageSha);
  assert.ok(historical.length>=1);const a=historical[0];
  assert.equal(a.decision,'confirmed-official-body-and-all-images');
  assert.equal(a.scheduleDecision,'no-calendar-event');assert.deepEqual(a.calendarEventIds,[]);
  assert.equal(sha(JSON.stringify(Object.keys(a.imageBytes))),imagesHash);
  assert.deepEqual(a.evidenceUrls,['https://zzz.mihoyo.com/news/167401',...Object.keys(a.imageBytes)]);
  const p=posts[key];assert.equal(p.imageEvidenceRequired,true);
  assert.equal(confirmations[key],p.reviewedDigest);assert.equal(p.confirmedImagesDigest,p.reviewedDigest);assert.equal(p.confirmedImageBytesDigest,p.reviewedDigest);
  assert.equal(sha(JSON.stringify(Object.keys(p.confirmedImageBytes))),p.confirmedImagesHash);
  assert.ok(audit.some(x=>relevant(x)&&x.digest===p.reviewedDigest&&x.imagesHash===p.confirmedImagesHash&&bytesEqual(x.imageBytes,p.confirmedImageBytes)));
});

test('167401本次无日程确认不造示意图时间节点或永久抑制，未来新审核可增加日程',async()=>{
  const posts=await read('posts'),overrides=await read('overrides');
  // 仅针对本次批准基线检查无日程；未来官方实质变更可送审并采用新的审核结论。
  const p=posts[key];
  if(p.reviewedDigest===digest&&p.confirmedImagesHash===imagesHash&&Object.values(p.confirmedImageBytes).length===1&&Object.values(p.confirmedImageBytes)[0]===imageSha){
    assert.equal(overrides.suppressPostIds.includes(key)||overrides.suppressPostIds.includes('167401'),false);
    const {final}=await renderBuildBundle({now:'2026-11-23T14:00:00.000Z'});
    assert.equal(final.some(e=>e.id===key||e.id.startsWith(key+':')||e.url==='https://zzz.mihoyo.com/news/167401'),false);
  }
});

const summaryKey='genshin:website:167426';
const summaryDigest='8cf0a931adb2d3fe0176c604af9f4f9f2e239cef0e067973c77dfe20990a561d';
const summaryImagesHash='186fef19e8066b8b9ec35026f570585e3488201313635aea7213dddecb838794';
const summaryHashes=['3ec5317e5367d7ca2574f6a190860ddc8a05b9c8eb6cd3b5919a4fc287ea38f2','afb1953e202418a109b05e964dac304422a7d07f00ec43a9ec5f7573a31b973e'];
const coveredIds=['167384','167385','167386','167388'].map(id=>'genshin:website:'+id);
const summaryRelevant=a=>a.game==='genshin'&&a.source==='website'&&a.postId==='167426';

test('167426保留完整正文与两张图片审核和四祈愿覆盖证据，当前批准基线须有对应audit',async()=>{
  const audit=await read('audit'),posts=await read('posts'),confirmations=await read('confirmations');
  const historical=audit.filter(a=>summaryRelevant(a)&&a.digest===summaryDigest&&a.imagesHash===summaryImagesHash&&JSON.stringify(Object.values(a.imageBytes??{}))===JSON.stringify(summaryHashes));
  assert.ok(historical.length>=1);const a=historical[0];
  assert.equal(a.decision,'confirmed-official-body-and-all-images');assert.equal(a.scheduleDecision,'covered-by-existing-independent-events');
  assert.deepEqual(a.calendarEventIds,[]);assert.deepEqual(a.coveredEventIds,coveredIds);
  assert.equal(sha(JSON.stringify(Object.keys(a.imageBytes))),summaryImagesHash);
  assert.deepEqual(a.evidenceUrls,['https://ys.mihoyo.com/main/news/detail/167426',...Object.keys(a.imageBytes)]);
  assert.deepEqual(a.coveredSchedules.map(e=>e.id),coveredIds);
  for(const e of a.coveredSchedules){assert.equal(e.start,'2026-11-24T18:00:00+08:00');assert.equal(e.end,'2026-12-15T14:59:00+08:00');assert.ok(e.url.endsWith('/'+e.id.split(':')[2]));}
  const p=posts[summaryKey];assert.equal(p.imageEvidenceRequired,true);
  assert.equal(confirmations[summaryKey],p.reviewedDigest);assert.equal(p.confirmedImagesDigest,p.reviewedDigest);assert.equal(p.confirmedImageBytesDigest,p.reviewedDigest);
  assert.equal(sha(JSON.stringify(Object.keys(p.confirmedImageBytes))),p.confirmedImagesHash);
  assert.ok(audit.some(x=>summaryRelevant(x)&&x.digest===p.reviewedDigest&&x.imagesHash===p.confirmedImagesHash&&bytesEqual(x.imageBytes,p.confirmedImageBytes)));
});

test('167426当前汇总版本不重复生成四祈愿，不永久抑制后续变化',async()=>{
  const posts=await read('posts'),overrides=await read('overrides'),p=posts[summaryKey];
  if(p.reviewedDigest===summaryDigest&&p.confirmedImagesHash===summaryImagesHash&&JSON.stringify(Object.values(p.confirmedImageBytes))===JSON.stringify(summaryHashes)){
    for(const list of [overrides.suppressPostIds,overrides.replaceParentIds])assert.equal((list??[]).some(id=>id===summaryKey||id==='167426'),false);
    const {final}=await renderBuildBundle({now:'2026-11-23T14:00:00.000Z'});
    assert.equal(final.some(e=>e.id===summaryKey||e.id.startsWith(summaryKey+':')||e.url==='https://ys.mihoyo.com/main/news/detail/167426'),false);
    for(const id of coveredIds)assert.equal(final.filter(e=>e.id===id).length,1,id);
    assert.equal(final.filter(e=>e.id==='genshin:website:167384:trial').length,1);
  }
});
