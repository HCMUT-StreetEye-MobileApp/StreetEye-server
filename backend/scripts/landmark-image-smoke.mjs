import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { createApp } from '../dist/app.js';
import { parseEnv } from '../dist/config/env.js';
import { connectionSettings } from '../dist/db/database.js';
import { createValidator } from '../dist/contracts/validation.js';

const config=parseEnv(process.env);
const db=new Client(connectionSettings(config,config.DIRECT_URL));
const schema=createValidator()('Landmark');
await db.connect();
try {
  await db.query('BEGIN');
  const landmark=randomUUID(), cue=randomUUID(), map=randomUUID(), seed=randomUUID();
  const pos='SRID=4326;POINT(106.65 10.75)';
  await db.query("INSERT INTO public.landmarks(landmark_id,data_mode,name_vi,location,is_active) VALUES($1,'demo','Smoke',$2,true)",[landmark,pos]);
  await db.query(`INSERT INTO public.turn_cues(cue_id,landmark_id,data_mode,turn_location,approach_bearing,exit_bearing,bearing_tolerance_deg,instruction_vi,is_active)
    VALUES($1,$2,'demo',$3,0,90,25,'Smoke',true)`,[cue,landmark,pos]);
  for(const [id,source,order] of [[map,'mapillary',2],[seed,'team_seed',1]]){
    await db.query(`INSERT INTO public.landmark_images(image_id,data_mode,image_source,attribution,reviewed_at,
      usage_status,offline_allowed,mapillary_image_id,storage_key,photographer_credit,delivery_url,delivery_expires_at,position,compass_angle)
      VALUES($1,'demo',$2,'Fixture',now(),'approved',true,$3,$4,$5,'https://example.org/test',now()+interval '1 hour',$6,359)`,
      [id,source,id===map?id:null,id===seed?id:null,id===seed?'Fixture':null,pos]);
    await db.query("INSERT INTO public.landmark_image_links VALUES($1,$2,'demo')",[landmark,id]);
    await db.query('INSERT INTO public.cue_images VALUES($1,$2,$3,$4)',[cue,id,landmark,order]);
  }
  const app=createApp({...config,DATA_MODE:'demo'},async()=>'up',()=>{},undefined,db);
  async function read(){
    await db.query('SET LOCAL ROLE streeteye_backend');
    const response=await request(app).get('/api/v1/landmarks/'+landmark).query({data_mode:'demo'}).expect(200);
    assert.ok(schema(response.body),JSON.stringify(schema.errors));
    await db.query('RESET ROLE');
    return response.body.turn_cues[0].images;
  }
  assert.deepEqual((await read()).map(i=>[i.image_id,i.offline_allowed]),[[map,false]]);
  await db.query('UPDATE public.landmark_images SET compass_angle=180 WHERE image_id=$1',[map]);
  assert.deepEqual((await read()).map(i=>i.image_id),[seed]);
  await db.query("UPDATE public.landmark_images SET usage_status='rejected' WHERE image_id=$1",[seed]);
  assert.deepEqual(await read(),[]);
  await db.query("UPDATE public.landmark_images SET compass_angle=0,delivery_expires_at=now()-interval '1 second' WHERE image_id=$1",[map]);
  assert.deepEqual(await read(),[]);
  console.log('Landmark API verified with runtime role: Mapillary, offline rights, opposite direction, team fallback, review and expiry.');
} finally {await db.query('ROLLBACK');await db.end();}
