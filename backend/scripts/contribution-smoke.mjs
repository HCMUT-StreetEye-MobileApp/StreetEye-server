import 'dotenv/config';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import sharp from 'sharp';
import {Client} from 'pg';
import {parseEnv} from '../dist/config/env.js';
import {connectionSettings} from '../dist/db/database.js';
import {createApp} from '../dist/app.js';
import {createValidator} from '../dist/contracts/validation.js';
import {exerciseOfflineReview} from './offline-review-fixture.mjs';
const cfg=parseEnv(process.env),db=new Client(connectionSettings(cfg,cfg.DIRECT_URL));
const validate=createValidator();
const ids=[randomUUID(),randomUUID(),randomUUID()];
let actor=ids[0];
// Emulate separate HTTP transactions inside a rollback-only fixture.
const adapter={async query(sql,args){
 await db.query('SAVEPOINT http_request');
 try {const rows=await db.query(sql,args);await db.query('RELEASE SAVEPOINT http_request');return rows;}
 catch(e){await db.query('ROLLBACK TO SAVEPOINT http_request');await db.query('RELEASE SAVEPOINT http_request');console.error('SQLSTATE',e.code);throw e;}
},async connect(){
 // The API opens a read transaction for a complete snapshot. Keep its reads
 // inside the outer rollback-only test transaction so it sees the test writes.
 return {release(){},query:(sql,args)=>{
   if(sql.startsWith('BEGIN ISOLATION LEVEL')) return db.query('SAVEPOINT route_snapshot');
   if(sql==='COMMIT') return db.query('RELEASE SAVEPOINT route_snapshot');
   if(sql==='ROLLBACK') return db.query('ROLLBACK TO SAVEPOINT route_snapshot');
   return db.query(sql,args);
 }};
}};
const app=createApp(cfg,async()=>'up',()=>{},{
 verifyToken:async()=>({authUserId:actor,sessionId:actor}),
 resolveContributor:async()=>({contributor_id:actor,role:'rider',disabled:false})
},adapter);
const api=request(app), auth={Authorization:'Bearer a.b.c'};
let stage='setup';
try{
 await db.connect();await db.query('BEGIN');
 for(const id of ids){
   await db.query('INSERT INTO auth.users(id) VALUES($1)',[id]);
   await db.query('INSERT INTO public.contributors(contributor_id,auth_user_id) VALUES($1,$1)',[id]);
 }
 await db.query('SET LOCAL ROLE streeteye_backend');
 const report={source:'manual',classification_method:'chosen',hazard_type:'flood',data_mode:'demo',client_event_id:randomUUID(),observed_at:new Date().toISOString(),position:{longitude:106.8015,latitude:10.8815},accuracy_m:3,heading_deg:45};
 const post=(path,body)=>api.post('/api/v1/'+path).set(auth).send(body);
 stage='report';
 const created=(await post('reports',report).expect(201)).body;
 assert.ok(validate('ReportReceipt')(created)); assert.ok(created.hazard_id);
 const hid=created.hazard_id,rid=created.report_id;
 const route={data_mode:'demo',route_revision:'ride-11',offline:true,maneuvers:[],
   geometry:{type:'LineString',coordinates:[[106.8014,10.8814],[106.8016,10.8816]]}};
 const snapshot=async()=>{
   const response=await post('route-snapshots',route).expect(200);
   assert.ok(validate('RouteSnapshot')(response.body));
   return response.body;
 };
 const before=await snapshot();
 assert.ok(before.hazards.some(h=>h.hazard_id===hid));
 assert.deepEqual((await post('reports',report).expect(200)).body,created);
 await post('reports',{...report,severity:'high'}).expect(409);
 const detail=()=>api.get('/api/v1/hazards/'+hid+'?data_mode=demo');
 const status=async(expected)=>assert.equal((await detail().expect(200)).body.status,expected);
 await status('pending');
 stage='photos';
 const photo=await sharp({create:{width:4,height:4,channels:3,background:'red'}}).png().toBuffer();
 const uploadId=randomUUID();
 const upload=()=>api.post('/api/v1/reports/'+rid+'/photos').set(auth).set('Idempotency-Key',uploadId).type('image/png').send(photo);
 await upload().expect(201);await upload().expect(200);
 const own=()=>api.get('/api/v1/reports/'+rid).set(auth);
 const stored=(await own().expect(200)).body;
 assert.ok(validate('Report')(stored));assert.equal(stored.photos.length,1);
 await api.get(stored.photos[0].url).set(auth).expect(200).expect('Content-Type',/webp/);
 assert.equal((await detail()).body.photos.length,0);
 await db.query('RESET ROLE');await db.query("UPDATE public.report_photos SET moderation_status='approved' WHERE report_id=$1",[rid]);await db.query('SET LOCAL ROLE streeteye_backend');
 const publicHazard=(await detail().expect(200)).body;
 assert.ok(validate('Hazard')(publicHazard));
 const link=publicHazard.photos[0].url;
 await api.get(link).expect(200);await api.get(link.replace(/key=./,'key=x')).expect(404);
 await db.query('RESET ROLE');await db.query("UPDATE public.report_photos SET moderation_status='rejected' WHERE report_id=$1",[rid]);await db.query('SET LOCAL ROLE streeteye_backend');
 await api.get(link).expect(404);
 stage='verification';
 const vote=async(result,extra={})=>{
 const body={client_event_id:randomUUID(),data_mode:'demo',result,observed_at:new Date().toISOString(),position:report.position,accuracy_m:4,...extra};
 const path='hazards/'+hid+'/verifications';
 const ack=(await post(path,body).expect(201)).body;assert.ok(validate('VerificationReceipt')(ack));
 assert.deepEqual((await post(path,body).expect(200)).body,ack);return ack;};
 await vote('still_present');await status('pending');
 actor=ids[1];await own().expect(404);await upload().expect(404);
 await vote('still_present');await status('active');
 const late=await vote('cleared',{observed_at:new Date(Date.now()-60000).toISOString()});assert.equal(late.effective_at_receipt,false);
 await vote('cleared');const once=(await detail().expect(200)).body;assert.ok(once.alert_eligible && once.is_disputed);
 actor=ids[2];await vote('cleared');await status('resolved');
 stage='offline review and route refresh';
 const readReport=id=>api.get('/api/v1/reports/'+id).set(auth).expect(200);
 await exerciseOfflineReview({owner:actor,otherOwner:ids[0],post,readReport,report,oldHazard:hid,before,after:await snapshot()});
 assert.equal((await vote('still_present')).eligible_for_score,false);
 stage='sensor';
 const sensor={...report,client_event_id:randomUUID(),source:'sensor_confirmed',accuracy_m:null,confirmed_at:new Date().toISOString()};
 delete sensor.classification_method;
 const sensorAck=(await post('reports',sensor).expect(201)).body;
 assert.equal(sensorAck.eligibility,'needs_review');
 assert.equal(sensorAck.hazard_id,null);
 await post('reports',{...sensor,confirmed_at:'2000-01-01T00:00:00Z'}).expect(422);
 stage='matching';
 const fresh={...report,client_event_id:randomUUID(),observed_at:new Date().toISOString()};
 const second=(await post('reports',fresh).expect(201)).body;assert.notEqual(second.hazard_id,hid);
 assert.ok(second.hazard_id);
 const delayed={...fresh,client_event_id:randomUUID(),observed_at:report.observed_at};
 const delayedReceipt=(await post('reports',delayed).expect(201)).body;
 assert.equal(delayedReceipt.hazard_id,null);
 assert.deepEqual(delayedReceipt.reason_codes,['NEEDS_REVIEW']);
 assert.equal((await post('reports',{...fresh,client_event_id:randomUUID()}).expect(201)).body.hazard_id,second.hazard_id);
 assert.equal((await post('reports',{...fresh,client_event_id:randomUUID(),heading_deg:225}).expect(201)).body.hazard_id,null);
 await post('reports',{...fresh,client_event_id:randomUUID(),position:{longitude:0,latitude:0}}).expect(422);
 const stale=(await post('reports',{...fresh,client_event_id:randomUUID(),observed_at:'2020-01-01T00:00:00Z'}).expect(201)).body;
 assert.deepEqual(stale.reason_codes,['STALE_OBSERVATION']);
 stage='decay';
 await db.query('RESET ROLE');await db.query("UPDATE public.hazards SET expires_at=now()-interval '1 second' WHERE hazard_id=$1",[second.hazard_id]);
 await db.query('SET LOCAL ROLE streeteye_backend');await db.query('SELECT streeteye_private.decay_batch()');
 assert.equal((await api.get('/api/v1/hazards/'+second.hazard_id+'?data_mode=demo').expect(200)).body.status,'expired');
 assert.ok(!(await snapshot()).hazards.some(h=>h.hazard_id===second.hazard_id));
 const expiredObservation={...fresh,client_event_id:randomUUID(),observed_at:new Date(Date.now()-60000).toISOString()};
 const expiredAck=(await post('reports',expiredObservation).expect(201)).body;
 assert.equal(expiredAck.hazard_id,null);
 assert.deepEqual(expiredAck.reason_codes,['NEEDS_REVIEW']);
 console.log('Passed: contribution API, offline SQLite restart, replay, Post-Ride confirmation, late observations, snapshot replacement and expiry.');
}catch(e){console.error('Failed at',stage,e.message);process.exitCode=1;}
finally{await db.query('ROLLBACK');await db.end();}
