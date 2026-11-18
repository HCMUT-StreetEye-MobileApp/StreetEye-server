import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';
import { parseEnv } from '../config/env.js';
import { connectionSettings } from './database.js';
import { migrationUrl } from './migrations.js';

const point=z.tuple([z.number().min(-180).max(180),z.number().min(-90).max(90)]);
const key=z.string().regex(/^[a-z0-9_-]{1,80}$/);
const region=z.object({
  key,source_ref:z.string().trim().min(1),surveyed_at:z.iso.datetime().nullable(),
  boundary:z.object({type:z.literal('Polygon'),coordinates:z.array(z.array(point).min(4)).min(1)}),
  route:z.object({type:z.literal('LineString'),coordinates:z.array(point).min(2).max(2000)}),
  hazards:z.array(z.object({key,position:point,type:z.enum(['pothole','flood','roadwork','unknown']),severity:z.enum(['low','medium','high','unknown'])})).min(1),
  landmarks:z.array(z.object({key,position:point,name:z.string().min(1).max(200),instruction:z.string().min(1).max(500),approach:z.number().min(0).lt(360),exit:z.number().min(0).lt(360)})).min(1),
});
async function main(){
  const cfg=parseEnv(process.env);
  const manifest=z.object({mode:z.enum(['demo','pilot']),regions:z.array(region).min(1)}).parse(JSON.parse(await readFile(process.argv[2]??'data/demo.json','utf8')));
  const db=new Client(connectionSettings(cfg,migrationUrl(cfg)));
  const {mode}=manifest;
  let imported=0, skipped=0;
  try {
    await db.connect(); await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(19370001,6)');
    for(const r of manifest.regions){
      const digest=createHash('sha256').update(JSON.stringify(r)).digest('hex');
      if(mode==='pilot' && (!r.surveyed_at || Date.parse(r.surveyed_at)>Date.now() || /synthetic|demo/i.test(r.source_ref))) throw Error('Unverified pilot source');
      const existing=await db.query('SELECT manifest_hash FROM streeteye_private.seed_regions WHERE mode=$1 AND region_key=$2',[mode,r.key]);
      if(existing.rowCount){
        if(existing.rows[0].manifest_hash!==digest) throw Error('Changed seed region: review a versioned update first');
        skipped++; continue;
      }
      await db.query(`INSERT INTO streeteye_private.seed_regions(mode,region_key,source_ref,manifest_hash,surveyed_at,boundary,sample_route)
        VALUES($1,$2,$3,$4,$5,extensions.st_geomfromgeojson($6::text),extensions.st_geomfromgeojson($7::text))`,[mode,r.key,r.source_ref,digest,r.surveyed_at,JSON.stringify(r.boundary),JSON.stringify(r.route)]);
      const points=[...r.hazards,...r.landmarks].map(row=>row.position);
      const coverage=await db.query(`SELECT bool_and(extensions.st_covers(boundary,extensions.st_setsrid(extensions.st_makepoint((p->>0)::float8,(p->>1)::float8),4326))) ok
        FROM streeteye_private.seed_regions CROSS JOIN jsonb_array_elements($3::jsonb) p WHERE mode=$1 AND region_key=$2`,[mode,r.key,JSON.stringify(points)]);
      if(!coverage.rows[0].ok) throw Error('Point outside seed region');
      let actor=process.env.SEED_MAINTAINER_ID;
      if(mode==='demo' && !actor){
        // Dedicated offline import identity, permanently banned, no credentials.
        const uid='52f2337a-3796-4674-99ba-902e8eeb1b11';
        const found=await db.query('SELECT id FROM auth.users WHERE id=$1',[uid]);
        if(!found.rowCount){
          await db.query("INSERT INTO auth.users(id,banned_until,raw_app_meta_data) VALUES($1,'infinity','{\"streeteye_demo_import\":true}')",[uid]);
          await db.query("INSERT INTO public.contributors(auth_user_id,role) VALUES($1,'maintainer')",[uid]);
        }
        const a=await db.query("SELECT c.contributor_id FROM public.contributors c JOIN auth.users u ON u.id=c.auth_user_id WHERE u.id=$1 AND c.role='maintainer' AND u.banned_until='infinity' AND u.raw_app_meta_data->>'streeteye_demo_import'='true'",[uid]);
        actor=a.rows[0]?.contributor_id;
      }
      const auth=await db.query("SELECT contributor_id FROM public.contributors WHERE contributor_id=$1 AND role='maintainer' AND disabled_at IS NULL",[actor]);
      if(!auth.rowCount) throw Error('Specify an active SEED_MAINTAINER_ID');
      for(const h of r.hazards){
        const id=randomUUID(), pos='SRID=4326;POINT('+h.position.join(' ')+')';
        await db.query(`INSERT INTO public.hazards(hazard_id,data_mode,hazard_type,severity,location,last_observed_at,expires_at)
          VALUES($1,$2,$3,$4,$5,coalesce($6::timestamptz,now()),coalesce($6::timestamptz,now())+ interval '1 day')`,[id,mode,h.type,h.severity,pos,r.surveyed_at]);
        await db.query(`INSERT INTO public.reports(contributor_id,hazard_id,client_event_id,payload_hash,data_mode,source,hazard_type,severity,position,observed_at_raw,observed_at,source_ref,source_record_key,surveyed_at)
          VALUES($1,$2,$3,$4,$5,'seed',$6,$7,$8,coalesce($9::timestamptz,now()),coalesce($9::timestamptz,now()),$10,$11,$9)`,[actor,id,randomUUID(),digest,mode,h.type,h.severity,pos,r.surveyed_at,r.source_ref,r.key+'/'+h.key]);
        await db.query("INSERT INTO public.hazard_events(hazard_id,actor_kind,actor_id,event_type,to_status,reason) VALUES($1,'contributor',$2,'created','pending',$3)",[id,actor,r.source_ref]);
      }
      for(const l of r.landmarks){
        const pos='SRID=4326;POINT('+l.position.join(' ')+')', id=randomUUID();
        await db.query('INSERT INTO public.landmarks(landmark_id,data_mode,name_vi,location,reviewed_at,review_note,is_active) VALUES($1,$2,$3,$4,$5,$6,true)',[id,mode,l.name,pos,r.surveyed_at,r.source_ref]);
        await db.query('INSERT INTO public.turn_cues(landmark_id,data_mode,turn_location,approach_bearing,exit_bearing,bearing_tolerance_deg,instruction_vi,is_active,reviewed_at) VALUES($1,$2,$3,$4,$5,25,$6,true,$7)',[id,mode,pos,l.approach,l.exit,l.instruction,r.surveyed_at]);
      }
      imported++;
    }
    await db.query('COMMIT'); console.log({mode,imported,skipped});
  } finally {await db.end();}
}
main().catch(e=>{console.error('Seed failed; uncommitted changes rolled back.',e.code??(e.constructor===Error?e.message:'Invalid manifest/configuration'));process.exitCode=1;});
