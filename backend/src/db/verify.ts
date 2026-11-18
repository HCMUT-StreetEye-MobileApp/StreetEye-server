import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';
import { DatabaseCommandError } from './migrations.js';

// Only called inside a transaction that the CLI always rolls back. Never seed
// committed auth identities or sample hazard data in a user's project.
export async function verifySchema(db: Client) {
  const point = 'SRID=4326;POINT(106.7 10.8)';
  const actor = randomUUID();
  const auth = randomUUID();
  const ids = { hazard: randomUUID(), report: randomUUID(), landmark: randomUUID(), image: randomUUID(), cue: randomUUID() };
  let passed = 0;
  async function check(name: string, body: () => Promise<void>) {
    try { await body(); passed++; console.log(JSON.stringify({ test: name, status: 'passed' })); }
    catch (error) { console.error(JSON.stringify({ test: name, status: 'failed' })); throw error; }
  }
  async function rejected(code: string, body: () => Promise<unknown>) {
    await db.query('SAVEPOINT expected_failure');
    let actual: unknown;
    try {
      await body();
      await db.query('SET CONSTRAINTS ALL IMMEDIATE');
    } catch (error) {
      actual = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    }
    await db.query('ROLLBACK TO SAVEPOINT expected_failure');
    await db.query('RELEASE SAVEPOINT expected_failure');
    if (actual !== code) throw new DatabaseCommandError(`Expected SQLSTATE ${code}, received ${typeof actual === 'string' ? actual : 'no SQL error'}.`);
  }
  async function report(id: string, hazard: string | null = null, mode = 'demo', event = randomUUID()) {
    await db.query(`INSERT INTO public.reports(report_id,contributor_id,hazard_id,client_event_id,payload_hash,
      data_mode,source,classification_method,position,observed_at_raw,observed_at)
      VALUES ($1,$2,$3,$4,'fixture',$5,'manual','timeout',$6,now(),now())`, [id,actor,hazard,event,mode,point]);
  }
  async function hazard(id: string, mode = 'demo') {
    await db.query(`INSERT INTO public.hazards(hazard_id,data_mode,location,last_observed_at,expires_at)
      VALUES ($1,$2,$3,now(),now()+interval '1 hour')`, [id,mode,point]);
  }
  async function creation(id: string) {
    await db.query(`INSERT INTO public.hazard_events(hazard_id,actor_kind,event_type,to_status,reason)
      VALUES ($1,'system','created','pending','migration verification fixture')`, [id]);
  }
  async function landmark(id: string, mode='demo') {
    await db.query(`INSERT INTO public.landmarks(landmark_id,data_mode,name_vi,location,is_active)
      VALUES ($1,$2,'Test fixture',$3,true)`, [id,mode,point]);
  }
  async function image(id: string, sourceId = randomUUID(), mode='demo') {
    await db.query(`INSERT INTO public.landmark_images(image_id,data_mode,image_source,attribution,mapillary_image_id)
      VALUES ($1,$2,'mapillary','Test fixture',$3)`, [id,mode,sourceId]);
  }
  await db.query('SAVEPOINT all_fixtures');
  await db.query('SET CONSTRAINTS ALL DEFERRED');
  await db.query('INSERT INTO auth.users(id) VALUES ($1)', [auth]);
  await db.query("INSERT INTO public.contributors(contributor_id,auth_user_id,role) VALUES ($1,$2,'maintainer')", [actor,auth]);
  await check('unattached report and empty landmark/cue are allowed', async () => {
    await report(ids.report);
    await landmark(ids.landmark);
    await db.query(`INSERT INTO public.turn_cues(cue_id,landmark_id,data_mode,turn_location,instruction_vi,
      approach_bearing,exit_bearing,bearing_tolerance_deg,is_active)
      VALUES ($1,$2,'demo',$3,'Test fixture',0,90,30,true)`, [ids.cue,ids.landmark,point]);
    await db.query('SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED');
  });
  await check('report actor/source and strict disjoint subtype fields', async () => {
    await rejected('23502', () => db.query('UPDATE public.reports SET contributor_id=NULL WHERE report_id=$1',[ids.report]));
    for (const change of ["source='invalid'", "classification_method=NULL", "confirmed_at=now()",
      "source='sensor_confirmed',classification_method=NULL", "source='seed',classification_method=NULL",
      "source='seed',classification_method=NULL,source_ref='test',source_record_key=''",
      "source='sensor_confirmed',classification_method=NULL,confirmed_at=observed_at-interval '1 second'"]) {
      await rejected('23514', () => db.query(`UPDATE public.reports SET ${change} WHERE report_id=$1`,[ids.report]));
    }
    await db.query("UPDATE public.reports SET source='sensor_confirmed',classification_method=NULL,confirmed_at=observed_at WHERE report_id=$1",[ids.report]);
    await db.query("UPDATE public.reports SET source='manual',classification_method='timeout',confirmed_at=NULL WHERE report_id=$1",[ids.report]);
  });
  await check('report idempotency key and stable seed key', async () => {
    const event = randomUUID();
    await report(randomUUID(),null,'demo',event);
    await rejected('23505', () => report(randomUUID(),null,'demo',event));
    const seed = randomUUID();
    const seedRef = randomUUID();
    await report(seed);
    await db.query("UPDATE public.reports SET source='seed',classification_method=NULL,source_ref=$2,source_record_key='1' WHERE report_id=$1",[seed,seedRef]);
    await rejected('23505', () => db.query("UPDATE public.reports SET source='seed',classification_method=NULL,source_ref=$2,source_record_key='1' WHERE report_id=$1",[ids.report,seedRef]));
  });
  await check('deferred hazard participation rejects missing report or creation', async () => {
    await rejected('23514', () => hazard(randomUUID()));
    await rejected('23514', async () => { const id=randomUUID(); await hazard(id); await report(randomUUID(),id); });
    await rejected('23514', async () => { const id=randomUUID(); await hazard(id); await creation(id); });
    await hazard(ids.hazard);
    await db.query('UPDATE public.reports SET hazard_id=$1 WHERE report_id=$2',[ids.hazard,ids.report]);
    await creation(ids.hazard);
    await db.query('SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED');
    await rejected('23514', () => db.query('UPDATE public.reports SET hazard_id=NULL WHERE report_id=$1',[ids.report]));
    await rejected('23514', () => db.query('DELETE FROM public.reports WHERE report_id=$1',[ids.report]));
  });
  await check('mode consistency for report, verification, predecessor and cue', async () => {
    await rejected('23503', () => report(randomUUID(),ids.hazard,'pilot'));
    await rejected('23503', () => db.query(`INSERT INTO public.verifications(contributor_id,hazard_id,client_event_id,
      payload_hash,data_mode,result,position,observed_at_raw,observed_at)
      VALUES ($1,$2,$3,'fixture','pilot','cleared',$4,now(),now())`,[actor,ids.hazard,randomUUID(),point]));
    await rejected('23503', () => db.query(`INSERT INTO public.hazards(data_mode,location,last_observed_at,expires_at,previous_hazard_id)
      VALUES ('pilot',$1,now(),now(),$2)`,[point,ids.hazard]));
    await rejected('23503', () => db.query("UPDATE public.turn_cues SET data_mode='pilot' WHERE cue_id=$1",[ids.cue]));
  });
  await check('latest eligible verification uses observation, receive time, then ID', async () => {
    const newer = randomUUID(), event = randomUUID();
    await db.query(`INSERT INTO public.verifications(verification_id,contributor_id,hazard_id,client_event_id,payload_hash,
      data_mode,result,position,observed_at_raw,observed_at,received_at,eligibility)
      VALUES ($1,$2,$3,$4,'fixture','demo','cleared',$5,now(),now(),now(),'eligible'),
      ($6,$2,$3,$7,'fixture','demo','still_present',$5,now()-interval '1 hour',now()-interval '1 hour',now()+interval '1 hour','eligible'),
      ($8,$2,$3,$9,'fixture','demo','still_present',$5,now()+interval '1 second',now()+interval '1 second',now(),'ineligible')`,
    [newer,actor,ids.hazard,event,point,randomUUID(),randomUUID(),randomUUID(),randomUUID()]);
    let latest = await db.query('SELECT verification_id FROM public.latest_effective_verification WHERE hazard_id=$1 AND contributor_id=$2',[ids.hazard,actor]);
    assert.deepEqual(latest.rows.map((r) => r.verification_id),[newer]);
    const tied = [randomUUID(),randomUUID()].sort();
    for (const id of tied) await db.query(`INSERT INTO public.verifications(verification_id,contributor_id,hazard_id,
      client_event_id,payload_hash,data_mode,result,position,observed_at_raw,observed_at,received_at,eligibility)
      VALUES ($1,$2,$3,$4,'fixture','demo','still_present',$5,now(),now(),now()+interval '1 second','eligible')`,
    [id,actor,ids.hazard,randomUUID(),point]);
    latest = await db.query('SELECT verification_id FROM public.latest_effective_verification WHERE hazard_id=$1 AND contributor_id=$2',[ids.hazard,actor]);
    assert.equal(latest.rows[0].verification_id,tied[1]);
    await rejected('23505', () => db.query(`INSERT INTO public.verifications(contributor_id,hazard_id,client_event_id,payload_hash,
      data_mode,result,position,observed_at_raw,observed_at) VALUES ($1,$2,$3,'changed payload','demo','still_present',$4,now(),now())`,[actor,ids.hazard,event,point]));
    await rejected('55000', () => db.query("UPDATE public.verifications SET result='cleared' WHERE verification_id=$1",[newer]));
    const count=await db.query('SELECT count(*)::int AS n FROM public.verifications WHERE hazard_id=$1',[ids.hazard]);
    assert.equal(count.rows[0].n,5);
  });
  await check('photo composite key permits shared storage keys across reports', async () => {
    const other=randomUUID(); await report(other);
    await db.query(`INSERT INTO public.report_photos(report_id,photo_no,storage_key,mime_type)
      VALUES ($1,1,'fixture/shared','image/jpeg'),($2,1,'fixture/shared','image/jpeg')`,[ids.report,other]);
    await rejected('23505', () => db.query(`INSERT INTO public.report_photos(report_id,photo_no,storage_key,mime_type)
      VALUES ($1,1,'fixture/other','image/jpeg')`,[ids.report]));
  });
  const nextHazard=randomUUID();
  await check('predecessor permits new episode; self-loop/cycle rejected', async () => {
    await hazard(nextHazard); await report(randomUUID(),nextHazard); await creation(nextHazard);
    await db.query('UPDATE public.hazards SET previous_hazard_id=$1 WHERE hazard_id=$2',[ids.hazard,nextHazard]);
    await db.query('SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED');
    await rejected('23514', () => db.query('UPDATE public.hazards SET previous_hazard_id=hazard_id WHERE hazard_id=$1',[ids.hazard]));
    await rejected('23514', () => db.query('UPDATE public.hazards SET previous_hazard_id=$1 WHERE hazard_id=$2',[nextHazard,ids.hazard]));
  });
  await check('score remains null before calculation; snapshots have per-hazard keys', async () => {
    const before=await db.query('SELECT score FROM public.latest_hazard_score WHERE hazard_id=$1',[ids.hazard]);
    assert.equal(before.rows[0].score,null);
    await db.query(`INSERT INTO public.score_snapshots(hazard_id,calculation_no,score,score_version,evidence_cutoff_at,input_summary)
      VALUES ($1,1,50,'test-only',now(),'{}'),($2,1,60,'test-only',now(),'{}'),($1,2,55,'test-only',now(),'{}')`,[ids.hazard,nextHazard]);
    await rejected('23505', () => db.query(`INSERT INTO public.score_snapshots(hazard_id,calculation_no,score,score_version,evidence_cutoff_at,input_summary)
      VALUES ($1,1,50,'test-only',now(),'{}')`,[ids.hazard]));
    await rejected('23514', () => db.query(`INSERT INTO public.score_snapshots(hazard_id,calculation_no,score,score_version,evidence_cutoff_at,input_summary)
      VALUES ($1,3,101,'test-only',now(),'{}')`,[ids.hazard]));
    const after=await db.query('SELECT calculation_no,score FROM public.latest_hazard_score WHERE hazard_id=$1',[ids.hazard]);
    assert.equal(after.rows[0].calculation_no,'2'); assert.equal(after.rows[0].score,'55.00');
    await rejected('55000', () => db.query('DELETE FROM public.score_snapshots WHERE hazard_id=$1',[ids.hazard]));
  });
  await check('event actor/source, score FK and immutable audit', async () => {
    await rejected('23514', () => db.query(`INSERT INTO public.hazard_events(hazard_id,actor_kind,event_type,from_status,to_status,reason)
      VALUES ($1,'contributor','status_changed','pending','active','fixture')`,[ids.hazard]));
    await rejected('23514', () => db.query(`INSERT INTO public.hazard_events(hazard_id,actor_kind,actor_id,event_type,from_status,to_status,reason)
      VALUES ($1,'system',$2,'status_changed','pending','active','fixture')`,[ids.hazard,actor]));
    await rejected('23503', () => db.query(`INSERT INTO public.hazard_events(hazard_id,actor_kind,event_type,from_status,to_status,reason,score_calculation_no)
      VALUES ($1,'system','status_changed','pending','active','fixture',99)`,[ids.hazard]));
    await rejected('55000', () => db.query('DELETE FROM public.hazard_events WHERE hazard_id=$1',[ids.hazard]));
  });
  const sourceId=randomUUID();
  await check('catalog image requires a landmark; source fields remain disjoint', async () => {
    await rejected('23514', () => image(randomUUID()));
    await image(ids.image,sourceId);
    await db.query("INSERT INTO public.landmark_image_links(landmark_id,image_id,data_mode) VALUES ($1,$2,'demo')",[ids.landmark,ids.image]);
    await db.query('SET CONSTRAINTS ALL IMMEDIATE; SET CONSTRAINTS ALL DEFERRED');
    await rejected('23514', () => db.query("UPDATE public.landmark_images SET storage_key='team/key' WHERE image_id=$1",[ids.image]));
    await rejected('23514', () => db.query('UPDATE public.landmark_images SET mapillary_image_id=NULL WHERE image_id=$1',[ids.image]));
    await rejected('23505', () => image(randomUUID(),sourceId));
    await rejected('23514', () => db.query('DELETE FROM public.landmark_image_links WHERE image_id=$1',[ids.image]));
    const otherImage=randomUUID();
    const otherLandmark=randomUUID(); await landmark(otherLandmark);
    await image(otherImage);
    await db.query("INSERT INTO public.landmark_image_links(landmark_id,image_id,data_mode) VALUES ($1,$2,'demo')",[otherLandmark,otherImage]);
    await rejected('23514', () => db.query('UPDATE public.landmark_image_links SET image_id=$1 WHERE image_id=$2',[otherImage,ids.image]));
  });
  await check('team image requires credit/storage and excludes Mapillary fields', async () => {
    const team=randomUUID(), key=`fixture/${randomUUID()}`;
    await db.query(`INSERT INTO public.landmark_images(image_id,data_mode,image_source,attribution,storage_key,photographer_credit)
      VALUES ($1,'demo','team_seed','Test fixture',$2,'Test fixture')`,[team,key]);
    await db.query("INSERT INTO public.landmark_image_links(landmark_id,image_id,data_mode) VALUES ($1,$2,'demo')",[ids.landmark,team]);
    for (const change of ["photographer_credit=NULL", "storage_key=NULL", "source_url='https://example.invalid/image'", "mapillary_image_id='test'"]) {
      await rejected('23514', () => db.query(`UPDATE public.landmark_images SET ${change} WHERE image_id=$1`,[team]));
    }
    await rejected('23505', () => db.query(`INSERT INTO public.landmark_images(data_mode,image_source,attribution,storage_key,photographer_credit)
      VALUES ('demo','team_seed','Test fixture',$1,'Test fixture')`,[key]));
    await rejected('23514', () => db.query("UPDATE public.landmark_images SET image_source='invalid' WHERE image_id=$1",[team]));
  });
  await check('image mode and cue landmark composite FKs', async () => {
    const other=randomUUID(); await landmark(other);
    const pilot=randomUUID(); await landmark(pilot,'pilot');
    await rejected('23503', () => db.query("INSERT INTO public.landmark_image_links(landmark_id,image_id,data_mode) VALUES ($1,$2,'pilot')",[pilot,ids.image]));
    await rejected('23503', () => db.query('INSERT INTO public.cue_images(cue_id,image_id,landmark_id,display_order) VALUES ($1,$2,$3,1)',[ids.cue,ids.image,other]));
    const unlinked=randomUUID(); await image(unlinked);
    await db.query("INSERT INTO public.landmark_image_links(landmark_id,image_id,data_mode) VALUES ($1,$2,'demo')",[other,unlinked]);
    await rejected('23503', () => db.query('INSERT INTO public.cue_images(cue_id,image_id,landmark_id,display_order) VALUES ($1,$2,$3,1)',[ids.cue,unlinked,ids.landmark]));
    await db.query('INSERT INTO public.cue_images(cue_id,image_id,landmark_id,display_order) VALUES ($1,$2,$3,1)',[ids.cue,ids.image,ids.landmark]);
  });
  await check('eligible cue view filters unapproved images and preserves empty arrays', async () => {
    let result=await db.query('SELECT images FROM public.eligible_turn_cues WHERE cue_id=$1',[ids.cue]);
    assert.deepEqual(result.rows[0].images,[]);
    await db.query("UPDATE public.landmark_images SET usage_status='approved' WHERE image_id=$1",[ids.image]);
    result=await db.query('SELECT images FROM public.eligible_turn_cues WHERE cue_id=$1',[ids.cue]);
    assert.equal(result.rows[0].images[0].offline_allowed,false);
    await db.query('UPDATE public.turn_cues SET approach_bearing=NULL WHERE cue_id=$1',[ids.cue]);
    result=await db.query('SELECT images FROM public.eligible_turn_cues WHERE cue_id=$1',[ids.cue]);
    assert.equal(result.rowCount,0);
  });
  await check('public hazard view excludes expired/closed and labels pending', async () => {
    let result=await db.query('SELECT is_unverified FROM public.public_hazards WHERE hazard_id=$1',[ids.hazard]);
    assert.equal(result.rows[0].is_unverified,true);
    await db.query("UPDATE public.hazards SET expires_at=now()-interval '1 second' WHERE hazard_id=$1",[ids.hazard]);
    result=await db.query('SELECT 1 FROM public.public_hazards WHERE hazard_id=$1',[ids.hazard]); assert.equal(result.rowCount,0);
    await db.query("UPDATE public.hazards SET status='resolved',expires_at=now()+interval '1 hour' WHERE hazard_id=$1",[ids.hazard]);
    result=await db.query('SELECT 1 FROM public.public_hazards WHERE hazard_id=$1',[ids.hazard]); assert.equal(result.rowCount,0);
  });
  await check('RLS and ACLs close direct Data API access to tables, views and functions', async () => {
    const tables=['contributors','hazards','reports','verifications','report_photos','score_snapshots','hazard_events',
      'landmarks','turn_cues','landmark_images','landmark_image_links','cue_images'];
    const rows=await db.query('SELECT relname,relrowsecurity FROM pg_class WHERE relnamespace=\'public\'::regnamespace AND relname=ANY($1::text[])',[tables]);
    assert.equal(rows.rowCount,12); assert.ok(rows.rows.every((r) => r.relrowsecurity));
    for (const role of ['anon','authenticated','service_role']) {
      const acl=await db.query(`SELECT c.relname FROM pg_class c WHERE c.relnamespace='public'::regnamespace
        AND c.relname=ANY($2::text[]) AND (has_table_privilege($1,c.oid,'SELECT') OR has_table_privilege($1,c.oid,'INSERT')
        OR has_table_privilege($1,c.oid,'UPDATE') OR has_table_privilege($1,c.oid,'DELETE') OR has_table_privilege($1,c.oid,'TRUNCATE'))`,
      [role,[...tables,'latest_effective_verification','latest_hazard_score','public_hazards','eligible_turn_cues']]);
      assert.equal(acl.rowCount,0);
      const rpc=await db.query(`SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace
        AND starts_with(proname,'streeteye_') AND has_function_privilege($1,oid,'EXECUTE')`,[role]); assert.equal(rpc.rowCount,0);
    }
    await rejected('42501', async () => { await db.query('SET LOCAL ROLE anon'); await db.query('SELECT * FROM public.public_hazards'); });
  });
  await db.query('SET CONSTRAINTS ALL IMMEDIATE');
  await db.query('ROLLBACK TO SAVEPOINT all_fixtures; RELEASE SAVEPOINT all_fixtures');
  const leftovers=await db.query('SELECT 1 FROM public.contributors WHERE contributor_id=$1 UNION ALL SELECT 1 FROM auth.users WHERE id=$2',[actor,auth]);
  assert.equal(leftovers.rowCount,0);
  console.log(JSON.stringify({ database_tests_passed: passed, fixtures: 'rolled_back' }));
}
