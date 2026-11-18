import express, { Router } from 'express';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { z } from 'zod';
import type { Pool } from 'pg';
import { AppError } from '../../http/errors.js';
import { createValidator } from '../../contracts/validation.js';
import { requireAuth, requireActiveContributor, authenticatedContributor } from '../auth/auth.middleware.js';
import type { AuthDependencies } from '../auth/auth.types.js';

const schema=createValidator();
const invalid=(message:string,code='INVALID_REQUEST')=>new AppError(422,code,message);
const missing=()=>new AppError(404,'NOT_FOUND','Resource not found.');
function uuid(input:unknown){
  if(typeof input!=='string'||!z.uuid().safeParse(input).success) throw invalid('Expected a UUID.');
  return input.toLowerCase();
}
function sorted(value:unknown):unknown {
  if(Array.isArray(value)) return value.map(sorted);
  if(value && typeof value==='object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,sorted(v)]));
  return value;
}
// PostgreSQL jsonb emits timestamps with an offset. The API uses milliseconds and Z.
function dto(value:unknown):unknown {
  if(Array.isArray(value)) return value.map(dto);
  if(value && typeof value==='object') return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,
    typeof v==='string' && /^(observed_at_raw|observed_at|received_at|uploaded_at|captured_at|confirmed_at)$/.test(k)?new Date(v).toISOString():dto(v)]));
  return value;
}
export function contributionRoutes(auth:AuthDependencies,pool:Pick<Pool,'query'>|undefined, mode:string){
  const router=Router(), login=requireAuth(auth);
  async function query(sql:string,args:unknown[]){
    try {if(!pool) throw Error(); return (await pool.query(sql,args)).rows[0];}
    catch(e){
      switch((e as {code?:string}).code){
        case 'SE429':throw new AppError(429,'RATE_LIMITED','Too many new contributions. Retry later.');
        case 'SE403':throw new AppError(403,'FORBIDDEN','Account is disabled.');
        case 'SE404':throw missing();
        case 'SE409':throw new AppError(409,'IDEMPOTENCY_CONFLICT','Event ID reused with different content.');
        case 'SE422':throw invalid('Observation or confirmation is in the future.','INVALID_TIMESTAMP');
        case 'SE423':throw invalid('Outside the configured region.','OUTSIDE_PILOT');
        case 'SE413':throw new AppError(413,'PHOTO_LIMIT','Report already has 20 photos.');
        default:throw new AppError(503,'SERVICE_UNAVAILABLE','Contribution database unavailable.');
      }
    }
  }
  for(const kind of ['report','verification'] as const){
    router.post(kind==='report'?'/reports':'/hazards/:id/verifications',login,requireActiveContributor,async(req,res)=>{
      if(!req.is('application/json')) throw new AppError(415,'UNSUPPORTED_MEDIA_TYPE','Expected JSON.');
      const p={...req.body};
      if(p.source==='seed'||['role','actor','status','contributor_id','confidence_score','score','hazard_id','eligibility','received_at'].some(k=>Object.hasOwn(p,k))) throw new AppError(403,'FORBIDDEN','Server-managed field.');
      const validate=schema(kind==='report'?'ReportRequest':'VerificationRequest');
      const valid:boolean=Boolean(validate(p));
      if(!valid) throw invalid('Invalid contribution payload.',validate.errors?.some(e=>e.instancePath.includes('position'))?'INVALID_COORDINATES':validate.errors?.some(e=>e.instancePath.endsWith('_at'))?'INVALID_TIMESTAMP':'INVALID_REQUEST');
      if(p.data_mode!==mode) throw new AppError(403,'FORBIDDEN','Data mode is disabled.');
      const hid=kind==='verification'?uuid(req.params.id):null;
      p.client_event_id=uuid(p.client_event_id);
      p.observed_at=new Date(p.observed_at).toISOString(); p.accuracy_m??=null;
      if(kind==='report'){
        p.hazard_type??='unknown';p.severity??='unknown';p.heading_deg??=null;
        if(p.classification_method==='timeout' && p.hazard_type!=='unknown') throw invalid('Timed-out flag requires unknown hazard type.');
        if(p.source==='sensor_confirmed'){
          p.confirmed_at=new Date(p.confirmed_at).toISOString();p.peak_accel_g??=null;p.speed_kmh??=null;
          if(p.confirmed_at<p.observed_at) throw invalid('Confirmation precedes observation.','INVALID_TIMESTAMP');
        }
      }
      const hash=createHash('sha256').update(JSON.stringify(sorted([hid,p]))).digest('hex');
      const {result}=await query('SELECT streeteye_private.submit_event($1,$2,$3,$4,$5) result',[authenticatedContributor(res).contributor_id,kind,hid,p,hash]);
      res.set('Idempotency-Replayed',String(result.replay)).status(result.replay?200:201).json(dto(result.body));
    });
  }
  router.get('/reports/:id',login,async(req,res)=>{
    const {result}=await query('SELECT streeteye_private.own_report($1,$2,$3) result',[authenticatedContributor(res).contributor_id,uuid(req.params.id),mode]);
    if(!result) throw missing();res.json(dto(result));
  });
  router.post('/reports/:id/photos',login,requireActiveContributor,express.raw({type:['image/jpeg','image/png','image/webp'],limit:'2mb'}),async(req,res)=>{
    const rid=uuid(req.params.id),key=uuid(req.get('Idempotency-Key'));
    const mime=req.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
    if(!mime||!['image/jpeg','image/png','image/webp'].includes(mime)||!Buffer.isBuffer(req.body)) throw new AppError(415,'UNSUPPORTED_MEDIA_TYPE','Expected a JPEG, PNG or WebP image.');
    const originalHash=createHash('sha256').update(req.body).digest('hex');
    let bytes:Buffer;
    try{
      const image=sharp(req.body,{limitInputPixels:16000000,failOn:'warning'});
      const metadata=await image.metadata();
      if('image/'+metadata.format!==mime || (metadata.pages??1)>1) throw Error();
      bytes=await image.rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).webp({quality:80}).toBuffer();
    }catch{throw invalid('Invalid image or image exceeds pixel limit.');}
    if(bytes.length>2097152) throw new AppError(413,'PAYLOAD_TOO_LARGE','Encoded image exceeds 2 MiB.');
    const {result}=await query('SELECT streeteye_private.put_photo($1,$2,$3,$4,$5,$6,$7) result',[authenticatedContributor(res).contributor_id,rid,mode,key,'image/webp',originalHash,bytes]);
    res.status(result.replay?200:201).set('Idempotency-Replayed',String(result.replay)).json({report_id:rid,photo_no:result.photo_no,moderation_status:'pending'});
  });
  router.get('/reports/:id/photos/:no',login,async(req,res)=>{
    const n=Number(req.params.no);
    if(!Number.isInteger(n)||n<1||n>20)throw missing();
    const row=await query('SELECT * FROM streeteye_private.get_photo($1,$2,$3,$4)',[authenticatedContributor(res).contributor_id,uuid(req.params.id),mode,n]);
    if(!row)throw missing();res.type(row.mime).send(row.content);
  });
  router.get('/evidence/:id/:no',async(req,res)=>{
    const n=Number(req.params.no),expires=Number(req.query.expires),key=req.query.key;
    if(!Number.isInteger(n)||n<1||n>20||!Number.isSafeInteger(expires)||typeof key!=='string'||!/^[0-9a-f]{64}$/.test(key))throw missing();
    const row=await query('SELECT * FROM streeteye_private.public_photo($1,$2,$3,$4,$5)',[uuid(req.params.id),n,mode,expires,key]);
    if(!row)throw missing();res.set('Cache-Control','no-store').type(row.mime).send(row.content);
  });
  return router;
}
