import assert from 'node:assert/strict';
import test from 'node:test';
import { Mapillary, deliveryExpiry } from '../src/modules/catalog/mapillary.js';

const turn={longitude:106.65,latitude:10.75,approach_bearing:358,bearing_tolerance_deg:10};
const candidate={id:'42',geometry:{type:'Point' as const,coordinates:[106.65,10.75] as [number,number]},
  thumb_1024_url:'https://example.org/image.jpg',compass_angle:2,creator:{username:'photo'}};
test('discovers only nearby direction-compatible candidates, with credentials sent in header',async()=>{
  const api=new Mapillary('local',async(url,init)=>{
    const target=new URL(String(url));
    assert.equal(target.origin,'https://graph.mapillary.com');
    assert.equal(target.pathname,'/images');
    assert.ok(target.searchParams.has('bbox'));
    assert.ok(!target.href.includes('local'));
    assert.equal(new Headers(init?.headers).get('Authorization'),'OAuth local');
    return Response.json({data:[candidate,{...candidate,id:'43',compass_angle:178},
      {...candidate,id:'44',geometry:{type:'Point',coordinates:[106,10]}},{id:'45'}]});
  });
  assert.deepEqual((await api.discover(turn)).map(row=>row.id),['42']);
});
test('retries a temporary upstream failure once and stops immediately on rate limit',async()=>{
  let calls=0;
  const api=new Mapillary('local',async()=>++calls===1?new Response(null,{status:503}):Response.json(candidate));
  assert.equal((await api.image('42')).id,'42');
  assert.equal(calls,2);
  calls=0;
  const limited=new Mapillary('local',async()=>{calls++;return new Response(null,{status:429});});
  await assert.rejects(limited.image('42'),/429/);
  assert.equal(calls,1);
  await assert.rejects(limited.image('../images'),/Invalid/);
  assert.equal(calls,1);
});
test('thumbnail cache expires at the earlier of one hour and signed expiry',()=>{
  const now=1700000000000;
  assert.equal(+deliveryExpiry(candidate,now),now+3600000);
  assert.equal(+deliveryExpiry({...candidate,thumb_1024_url:candidate.thumb_1024_url+'?oe='+((now+60000)/1000).toString(16)},now),now+60000);
});
