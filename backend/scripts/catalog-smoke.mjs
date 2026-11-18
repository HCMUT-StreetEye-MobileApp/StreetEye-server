import 'dotenv/config';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import request from 'supertest';
import {createApp} from '../dist/app.js';
import {parseEnv} from '../dist/config/env.js';
import {createDatabase} from '../dist/db/database.js';
import {createValidator} from '../dist/contracts/validation.js';

const cfg=parseEnv(process.env), db=createDatabase(cfg,()=>{});
const app=createApp(cfg,db.check,()=>{},undefined,db.pool);
const schema=createValidator();
const samples=JSON.parse(await readFile(new URL('../data/demo.json',import.meta.url),'utf8')).regions;
try {
  for(const r of samples){
    const [min,max]=[r.boundary.coordinates[0][0],r.boundary.coordinates[0][2]];
    const query={data_mode:'demo',min_longitude:min[0],min_latitude:min[1],max_longitude:max[0],max_latitude:max[1],limit:1};
    const list=async(q,status=200)=>(await request(app).get('/api/v1/hazards').query(q).expect(status)).body;
    const first=await list(query);
    assert.ok(schema('HazardList')(first));
    assert.ok(first.next_cursor);
    const second=await list({...query,cursor:first.next_cursor});
    assert.notEqual(first.hazards[0].hazard_id,second.hazards[0].hazard_id);
    await list({...query,limit:2,cursor:first.next_cursor},422);
    await list({...query,data_mode:'pilot'},403);
    const [longitude,latitude]=r.hazards[0].position;
    const near=await list({...query,longitude,latitude,radius_m:5});
    assert.equal(near.hazards.length,1);
    assert.equal(near.next_cursor,null);
    const h=(await request(app).get('/api/v1/hazards/'+near.hazards[0].hazard_id).query({data_mode:'demo'}).expect(200)).body;
    assert.ok(schema('Hazard')(h));
    const l=r.landmarks[0];
    const body={data_mode:'demo',geometry:r.route,route_revision:r.key,offline:true,maneuvers:[{maneuver_id:'turn',location:{longitude:l.position[0],latitude:l.position[1]},approach_bearing:l.approach,exit_bearing:l.exit}]};
    const snap=async(b,status=200)=>(await request(app).post('/api/v1/route-snapshots').send(b).expect(status)).body;
    const snapshot=await snap(body);
    assert.ok(schema('RouteSnapshot')(snapshot),JSON.stringify(schema('RouteSnapshot').errors));
    assert.equal(snapshot.route_revision,r.key);
    assert.ok(snapshot.hazards.some(x=>x.hazard_id===h.hazard_id));
    assert.equal(snapshot.turn_cues.length,1);
    const landmark=(await request(app).get('/api/v1/landmarks/'+snapshot.turn_cues[0].cue.landmark_id).query({data_mode:'demo'}).expect(200)).body;
    assert.ok(schema('Landmark')(landmark));
    const fallback=await snap({...body,maneuvers:[{...body.maneuvers[0],exit_bearing:null}]});
    assert.equal(fallback.cue_fallbacks[0].reason,'MISSING_BEARING');
    const far=await snap({...body,geometry:{type:'LineString',coordinates:[[0,0],[0,.01]]}});
    assert.equal(far.hazards.length+far.turn_cues.length,0);
    await snap({...body,geometry:{type:'LineString',coordinates:[[0,0],[0,1]]}},413);
    console.log(r.key,'passed: paging, proximity, mode isolation, detail, route, cue, fallback, length');
  }
} finally {await db.close();}
