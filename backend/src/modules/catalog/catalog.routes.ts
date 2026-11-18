import { createHash, randomUUID } from 'node:crypto';
import { Router } from 'express';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { AppError } from '../../http/errors.js';
import { createValidator } from '../../contracts/validation.js';
import { limits, policy } from '../../contracts/schemas.js';
import type { HazardQuery, RouteInput } from '../../contracts/read-types.js';

const queryValidator=createValidator(true), bodyValidator=createValidator();
const invalid=(message:string,code='INVALID_REQUEST')=>new AppError(422,code,message);
const missing=()=>new AppError(404,'NOT_FOUND','Resource not found.');
const unavailable=()=>new AppError(503,'SERVICE_UNAVAILABLE','Catalog is temporarily unavailable.');
const position=(field:string)=>`jsonb_build_object('longitude',extensions.st_x(${field}::extensions.geometry),'latitude',extensions.st_y(${field}::extensions.geometry))`;
const open="status IN ('pending','active') AND expires_at>now()";
const hazards=`SELECT hazard_id,previous_hazard_id,data_mode,hazard_type,severity,${position('location')} location,
 road_ref,direction_bearing,status,is_disputed,last_observed_at,expires_at,updated_at,confidence_score,score_version,computed_at,
 (${open}) alert_eligible,CASE WHEN status='pending' THEN 'unverified' END warning_label,streeteye_private.approved_photos(hazard_id) photos
 FROM streeteye_private.read_hazards`;
const imageTime=(field:string)=>`to_char(i.${field} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
function cues(offline:boolean){
  return `SELECT cue_id, landmark_id,data_mode,landmark_name_vi,${position('turn_location')} turn_location,
    approach_bearing,exit_bearing,bearing_tolerance_deg,instruction_vi,
    ARRAY(SELECT (to_jsonb(i)-'cue_id') || jsonb_build_object(
      'captured_at',${imageTime('captured_at')}, 'url_expires_at',${imageTime('url_expires_at')},
      'offline_expires_at',${imageTime('offline_expires_at')}) FROM streeteye_private.read_cue_images i
      WHERE i.cue_id=read_cues.cue_id ${offline?'AND i.offline_allowed':''}
      ORDER BY (i.image_source='mapillary') DESC, i.display_order LIMIT 1) AS images
    FROM streeteye_private.read_cues`;
}
const route="extensions.st_geomfromgeojson($2::text)::extensions.geography";

async function snapshot(db:PoolClient,input:RouteInput){
  const geometry=JSON.stringify(input.geometry), bindings=[input.data_mode,geometry];
  const length=await db.query('SELECT extensions.st_length(extensions.st_geomfromgeojson($1::text)::extensions.geography) meters',[geometry]);
  if(length.rows[0].meters>limits.max_route_length_m) throw new AppError(413,'ROUTE_TOO_LARGE','Route exceeds 50 km.');
  if(!length.rows[0].meters) throw invalid('Route must have length.','INVALID_COORDINATES');
  const hits=await db.query(hazards+` WHERE data_mode=$1 AND ${open} AND extensions.st_dwithin(location,${route},$3) ORDER BY hazard_id LIMIT $4`,
    [...bindings,policy.experimental.route_corridor_m,limits.max_snapshot_hazards+1]);
  if(hits.rows.length>limits.max_snapshot_hazards) throw new AppError(413,'SNAPSHOT_TOO_LARGE','Request a shorter route.');
  // One lateral nearest match per maneuver. Both the maneuver and cue must lie in the corridor.
  const matches=await db.query(`SELECT m.maneuver_id, c.* FROM jsonb_to_recordset($3::jsonb)
    m(maneuver_id text,location jsonb,approach_bearing float8,exit_bearing float8)
    CROSS JOIN LATERAL (SELECT extensions.st_setsrid(extensions.st_makepoint((m.location->>'longitude')::float8,(m.location->>'latitude')::float8),4326)::extensions.geography AS pos) p
    CROSS JOIN LATERAL (${cues(!!input.offline)} WHERE data_mode=$1
    AND extensions.st_dwithin(p.pos,${route},$4) AND extensions.st_dwithin(streeteye_private.read_cues.turn_location,${route},$4)
    AND extensions.st_dwithin(streeteye_private.read_cues.turn_location,p.pos,$4)
    AND least(abs(approach_bearing-m.approach_bearing),360-abs(approach_bearing-m.approach_bearing))<=bearing_tolerance_deg
    AND least(abs(exit_bearing-m.exit_bearing),360-abs(exit_bearing-m.exit_bearing))<=bearing_tolerance_deg
    ORDER BY extensions.st_distance(streeteye_private.read_cues.turn_location,p.pos),cue_id LIMIT 1) c`,
    [...bindings,JSON.stringify(input.maneuvers),policy.experimental.route_corridor_m]);
  const byId=new Map(matches.rows.map(({maneuver_id,...cue})=>[maneuver_id,cue]));
  const turn_cues=[],cue_fallbacks=[];
  for(const m of input.maneuvers){
    const cue=byId.get(m.maneuver_id);
    if(cue) turn_cues.push({maneuver_id:m.maneuver_id,cue});
    else cue_fallbacks.push({maneuver_id:m.maneuver_id,reason:m.approach_bearing==null||m.exit_bearing==null?'MISSING_BEARING':'NO_ELIGIBLE_CUE'});
  }
  const generated=(await db.query('SELECT now() AS t')).rows[0].t as Date;
  return {snapshot_id:randomUUID(),data_mode:input.data_mode,route_revision:input.route_revision,policy_version:policy.policy_version,
    generated_at:generated,expires_at:new Date(+generated+limits.snapshot_ttl_seconds*1000),complete:true,hazards:hits.rows,turn_cues,cue_fallbacks,
    warnings:turn_cues.some(({cue})=>!cue.images.length)?[input.offline?'NO_OFFLINE_IMAGE':'LANDMARK_IMAGES_UNAVAILABLE']:[]};
}

export function catalogRoutes(pool:Pool|undefined,mode:'demo'|'pilot'){
  const router=Router();
  function checkMode(value:string){if(value!==mode) throw new AppError(403,'FORBIDDEN','Data mode is disabled.');}
  function db(){if(!pool) throw unavailable();return pool;}
  function checkedQuery(name:string,query:unknown){
    if(!queryValidator(name)(query)) throw invalid('Invalid query parameters.');
  }
  router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
  router.get('/config',(_req,res)=>{res.json(policy);});
  router.get('/hazards',async(req,res)=>{
    const input={...req.query};checkedQuery('HazardListQuery',input);
    const q=input as unknown as HazardQuery;
    checkMode(q.data_mode);
    if(q.min_longitude>=q.max_longitude||q.min_latitude>=q.max_latitude) throw invalid('Invalid viewport.','INVALID_COORDINATES');
    const near=[q.longitude,q.latitude,q.radius_m];
    if(near.some(v=>v!==undefined)&&near.some(v=>v===undefined)) throw invalid('Supply longitude, latitude and radius_m together.');
    const limit=q.limit??100;
    const bounds=[q.min_longitude,q.min_latitude,q.max_longitude,q.max_latitude];
    const signature=createHash('sha256').update(JSON.stringify([mode,...bounds,...near,limit])).digest('base64url');
    let last=null;
    if(q.cursor){
      const [sig,id,...rest]=q.cursor.split('.');
      if(sig!==signature||rest.length||!z.uuid().safeParse(id).success) throw invalid('Invalid cursor for this query.');
      last=id;
    }
    const sql=hazards+` WHERE data_mode=$1 AND ${open} AND extensions.st_intersects(location::extensions.geometry,extensions.st_makeenvelope($2,$3,$4,$5,4326))
      AND ($6::uuid IS NULL OR hazard_id>$6) AND ($8::float8 IS NULL OR extensions.st_dwithin(location,extensions.st_setsrid(extensions.st_makepoint($8,$9),4326)::extensions.geography,$10))
      ORDER BY hazard_id LIMIT $7`;
    const result=await db().query(sql,[mode,...bounds,last,limit+1,...near]).catch(()=>{throw unavailable();});
    const rows=result.rows.slice(0,limit);
    res.json({data_mode:mode,generated_at:new Date(),hazards:rows,next_cursor:result.rows.length>limit?signature+'.'+rows.at(-1)!.hazard_id:null});
  });
  for(const kind of ['hazards','landmarks'] as const){
    router.get('/'+kind+'/:id',async(req,res)=>{
      checkedQuery('ModeQuery',req.query);checkMode(String(req.query.data_mode));
      if(!z.uuid().safeParse(req.params.id).success) throw invalid('Invalid ID.');
      const sql=kind==='hazards'?hazards+' WHERE data_mode=$1 AND hazard_id=$2':
        `SELECT landmark_id,data_mode,name_vi,description_vi,${position('location')} location,reviewed_at,
        ARRAY(SELECT row_to_json(t) FROM (${cues(false)} WHERE landmark_id=$2 AND data_mode=$1 ORDER BY cue_id LIMIT 201) t) turn_cues
        FROM streeteye_private.read_landmarks WHERE data_mode=$1 AND landmark_id=$2`;
      const result=await db().query(sql,[mode,req.params.id]).catch(()=>{throw unavailable();});
      if(!result.rowCount) throw missing();
      if(result.rows[0].turn_cues?.length>limits.max_snapshot_cues) throw new AppError(413,'SNAPSHOT_TOO_LARGE','Too many cues.');
      res.json(result.rows[0]);
    });
  }
  router.post('/route-snapshots',async(req,res)=>{
    if(!req.is('application/json')) throw new AppError(415,'UNSUPPORTED_MEDIA_TYPE','Expected application/json.');
    const validate=bodyValidator('RouteSnapshotRequest');
    if(!validate(req.body)){
      if(validate.errors?.some(e=>e.keyword==='maxItems')) throw new AppError(413,'ROUTE_TOO_LARGE','Route exceeds limits.');
      throw invalid('Invalid route request.',validate.errors?.some(e=>e.instancePath.includes('coordinates'))?'INVALID_COORDINATES':'INVALID_REQUEST');
    }
    const input=req.body as RouteInput;checkMode(input.data_mode);
    if(input.geometry.coordinates.some(([,lat])=>Math.abs(lat)>90)) throw invalid('Invalid latitude.','INVALID_COORDINATES');
    if(new Set(input.maneuvers.map(m=>m.maneuver_id)).size!==input.maneuvers.length) throw invalid('Duplicate maneuver IDs.');
    const client=await db().connect().catch(()=>{throw unavailable();});
    try{
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result=await snapshot(client,input);await client.query('COMMIT');res.json(result);
    }catch(e){await client.query('ROLLBACK');throw e instanceof AppError?e:unavailable();}
    finally{client.release();}
  });
  return router;
}
