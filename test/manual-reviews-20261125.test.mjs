import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createImageEvidenceChecker,approveImageEvidence} from '../lib/image-evidence.mjs';

const read=async n=>JSON.parse(await fs.readFile(new URL(`../data/${n}.json`,import.meta.url),'utf8'));
const sha=value=>createHash('sha256').update(value).digest('hex');
const sameBytes=(a,b)=>JSON.stringify(Object.entries(a??{}).sort())===JSON.stringify(Object.entries(b??{}).sort());
const cases=[
  ['167384','eeca4c0333f5392ca7e8e3c09816d0c66906825aea5c6f9bf39f9321931e7beb','c3bf80c5ae928a49c9225e7f90a4080e10faaf5f293e868f63d9af62780fc0ff'],
  ['167385','2f1ee6d7f63cc461b5244539a1d78ca3f89a46686afc786df3b9595342b9ed4a','0fc4788b7bd971134b9d36dccf38118e4b8d70c45335977c1bd6569d780c21cd'],
  ['167386','e074acce3ca28b20b88c63d6a83e5f3ab7b9e0b7479f4dc6e6d645b437b10011','71a545637f10fce4d82e124613672be442abb42ef2555ed7064b282c705838a8'],
  ['167388','27abb14a9e0740e6ca79dcc1a0d93d0a5a6e3b7152d9755706e772c51dd7fc07','724e2a2e8c469726c08d97527e7eb39b192ee942bd34b2268e62ec18101f9d64'],
];

test('11月25日四篇现已开启公告重新绑定完整正文与八图，不丢旧审核或锁死未来新确认',async()=>{
  const posts=await read('posts'),audit=await read('audit'),confirmations=await read('confirmations');
  for(const [id,digest,previousDigest]of cases){
    const key=`genshin:website:${id}`,p=posts[key];
    const old=audit.find(a=>a.game==='genshin'&&a.source==='website'&&a.postId===id&&a.digest===previousDigest);
    const current=audit.find(a=>a.game==='genshin'&&a.source==='website'&&a.postId===id&&a.digest===digest&&a.previousDigest===previousDigest);
    assert.ok(old,id);assert.ok(current,id);
    assert.equal(current.decision,'confirmed-official-body-and-all-images');assert.equal(current.scheduleDecision,'retain-existing-schedules');
    assert.equal(Object.keys(current.imageBytes).length,2);assert.ok(sameBytes(old.imageBytes,current.imageBytes));
    assert.equal(current.imagesHash,old.imagesHash);assert.equal(sha(JSON.stringify(Object.keys(current.imageBytes))),current.imagesHash);
    assert.deepEqual(current.evidenceUrls,[`https://ys.mihoyo.com/main/news/detail/${id}`,...Object.keys(current.imageBytes)]);
    assert.equal(current.changeSummary.bodyUnchanged,true);assert.equal(current.changeSummary.imageListUnchanged,true);assert.equal(current.changeSummary.imageBytesUnchanged,true);
    const expectedIds=[key,...(id==='167384'?['genshin:website:167384:trial']:[])];assert.deepEqual(current.calendarEventIds,expectedIds);
    assert.deepEqual(current.retainedSchedules.map(e=>e.id),expectedIds);
    for(const e of current.retainedSchedules){assert.equal(e.start,'2026-11-24T18:00:00+08:00');assert.equal(e.end,'2026-12-15T14:59:00+08:00');assert.equal(e.sequence,0);assert.equal(e.modified,'2026-11-20T01:41:43.519Z');}
    assert.equal(p.imageEvidenceRequired,true);assert.equal(confirmations[key],p.reviewedDigest);
    assert.equal(p.confirmedImagesDigest,p.reviewedDigest);assert.equal(p.confirmedImageBytesDigest,p.reviewedDigest);
    assert.equal(sha(JSON.stringify(Object.keys(p.confirmedImageBytes))),p.confirmedImagesHash);
    assert.ok(audit.some(a=>a.game==='genshin'&&a.source==='website'&&a.postId===id&&a.digest===p.reviewedDigest&&a.imagesHash===p.confirmedImagesHash&&sameBytes(a.imageBytes,p.confirmedImageBytes)));
  }
});

test('四篇图片证据分别拦截仅正文、仅列表、仅字节变更，重新批准后解除人工锁',async()=>{
  const posts=await read('posts');
  for(const [id]of cases){
    const ref=posts[`genshin:website:${id}`],urls=Object.keys(ref.confirmedImageBytes);
    // 使用可重算的合成字节作隔离夹具，不联网；沿用真实记录的证据开关及URL列表。
    const now='2026-11-25T00:00:00.000Z';
    const stableBytes=Object.fromEntries(urls.map(url=>[url,sha('stable fixture '+url)]));
    const baseline=approveImageEvidence({...ref,digest:ref.reviewedDigest,observedImageBytes:stableBytes,observedImageBytesDigest:ref.reviewedDigest,imageEvidenceError:null},ref.reviewedDigest);
    const requestFor=mode=>async url=>new Response(mode==='bytes'?'changed fixture '+url:'stable fixture '+url,{headers:{'content-type':'image/png'}});
    const unchanged=await createImageEvidenceChecker({request:requestFor('stable'),attempts:1})({images:urls},baseline,{expectedDigest:baseline.reviewedDigest,digest:baseline.reviewedDigest,now});
    assert.equal(unchanged.needsReview,false,id+' stable baseline');
    for(const mode of ['body','list','bytes']){
      const images=mode==='list'?[...urls,`https://fastcdn.mihoyo.com/test-${id}.png`]:urls;
      const digest=mode==='body'?sha('future changed body '+id):baseline.reviewedDigest;
      const check=createImageEvidenceChecker({request:requestFor(mode),attempts:1});
      const result=await check({images},baseline,{expectedDigest:baseline.reviewedDigest,digest,now});
      assert.equal(result.needsReview,true,`${id}:${mode}`);assert.equal(result.fields.imageEvidenceManualReview,true);
      if(mode==='body'){
        assert.equal(result.baselineMissing,true);assert.equal(result.listChanged,false);assert.equal(result.bytesChanged,false);
        assert.deepEqual(result.fields.observedImageBytes,stableBytes);
      }
      if(mode==='list'){assert.equal(result.listChanged,true);for(const url of urls)assert.equal(result.fields.observedImageBytes[url],stableBytes[url]);}
      if(mode==='bytes'){assert.equal(result.bytesChanged,true);assert.equal(result.listChanged,false);assert.equal(result.baselineMissing,false);}
      const approved=approveImageEvidence({...baseline,...result.fields,digest,imagesHash:sha(JSON.stringify(images))},digest);
      assert.equal(approved.imageEvidencePending,false);assert.equal(approved.imageEvidenceManualReview,false);assert.equal(approved.imageEvidenceError,null);
      assert.equal(approved.confirmedImageBytesDigest,digest);assert.deepEqual(approved.confirmedImageBytes,result.fields.observedImageBytes);
      const after=await createImageEvidenceChecker({request:requestFor(mode),attempts:1})({images},approved,{expectedDigest:digest,digest,now});
      assert.equal(after.needsReview,false,`${id}:${mode} approved baseline`);
    }
  }
});
