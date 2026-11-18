import 'dotenv/config';
import { Client } from 'pg';
import { z } from 'zod';
import { parseEnv } from '../config/env.js';
import { connectionSettings } from './database.js';
import { migrationUrl } from './migrations.js';
import { Mapillary, ProviderError, deliveryExpiry, eligible, distance, type MapImage, type Turn } from '../modules/catalog/mapillary.js';

const attribution=(image:MapImage)=>image.creator?.username
  ? image.creator.username+' / Mapillary (CC BY-SA)' : null;
const viewer=(id:string)=>'https://www.mapillary.com/app/?pKey='+id;
function values(image:MapImage){
  const credit=attribution(image);
  if(!credit || +deliveryExpiry(image)<=Date.now()) throw Error('Missing credit or expired thumbnail');
  return [credit,image.captured_at==null?null:new Date(image.captured_at),
    'SRID=4326;POINT('+image.geometry.coordinates.join(' ')+')', image.compass_angle,
    image.creator!.username,image.thumb_1024_url,deliveryExpiry(image),image.id];
}
const assignments=`attribution=$1,captured_at=$2,position=$3,compass_angle=$4,creator_ref=$5,
 delivery_url=$6,delivery_expires_at=$7,metadata_fetched_at=now()`;

async function main(){
  const [action,cueId,id]=process.argv.slice(2);
  const config=parseEnv(process.env);
  const db=new Client(connectionSettings(config,migrationUrl(config)));
  await db.connect();
  try {
    const sql=`SELECT cue_id,landmark_id,landmark_name_vi,instruction_vi,approach_bearing,bearing_tolerance_deg,
      extensions.st_x(turn_location::extensions.geometry) longitude,
      extensions.st_y(turn_location::extensions.geometry) latitude FROM streeteye_private.read_cues WHERE data_mode=$1`;
    if(action==='cues'){
      console.table((await db.query(sql+' ORDER BY cue_id',[config.DATA_MODE])).rows);
      return;
    }
    if(!process.env.MAPILLARY_ACCESS_TOKEN?.trim()) throw Error('Set MAPILLARY_ACCESS_TOKEN in backend/.env');
    const api=new Mapillary(process.env.MAPILLARY_ACCESS_TOKEN.trim());
    if(action==='refresh'){
      const items=await db.query(`SELECT mapillary_image_id FROM public.landmark_images WHERE data_mode=$1
        AND image_source='mapillary' AND usage_status='approved'
        AND (delivery_expires_at IS NULL OR delivery_expires_at<now()+interval '15 minutes') ORDER BY image_id`,[config.DATA_MODE]);
      let updated=0, failed=0;
      for(const row of items.rows){
        try {
          const image=await api.image(row.mapillary_image_id);
          await db.query('UPDATE public.landmark_images SET '+assignments+
            " WHERE mapillary_image_id=$8 AND usage_status='approved' AND data_mode=$9",[...values(image),config.DATA_MODE]);
          updated++;
        } catch(e){
          failed++;
          if(e instanceof ProviderError && (e.status===429 || e.status===401 || e.status===403)) break;
          if(e instanceof ProviderError && e.status===404) await db.query(
            'UPDATE public.landmark_images SET delivery_expires_at=now() WHERE mapillary_image_id=$1 AND data_mode=$2',[row.mapillary_image_id,config.DATA_MODE]);
        }
      }
      console.log({due:items.rowCount,updated,failed});
      if(failed) process.exitCode=1;
      return;
    }
    if(!z.uuid().safeParse(cueId).success || !['discover','approve'].includes(action??'')) throw Error('Use cues, discover CUE_ID, approve CUE_ID IMAGE_ID, or refresh');
    const cue=(await db.query(sql+' AND cue_id=$2',[config.DATA_MODE,cueId])).rows[0];
    if(!cue) throw Error('Cue unavailable in DATA_MODE');
    const turn=cue as Turn;
    if(action==='discover'){
      const images=await api.discover(turn);
      console.table(images.map(i=>({id:i.id,distance_m:Math.round(distance(turn,i)),heading:i.compass_angle,credit:attribution(i),review:viewer(i.id)})));
      return;
    }
    const image=await api.image(id??'');
    if(!eligible(turn,image)) throw Error('Image outside cue radius or bearing tolerance');
    await db.query('BEGIN');
    await db.query('SELECT cue_id FROM public.turn_cues WHERE cue_id=$1 FOR UPDATE',[cueId]);
    const saved=await db.query(`INSERT INTO public.landmark_images
      (attribution,captured_at,position,compass_angle,creator_ref,delivery_url,delivery_expires_at,mapillary_image_id,
       data_mode,image_source,source_url,reviewed_at,metadata_fetched_at,usage_status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'mapillary',$10,now(),now(),'approved')
      ON CONFLICT(mapillary_image_id) WHERE mapillary_image_id IS NOT NULL DO UPDATE SET `+assignments+
      `, reviewed_at=now(),usage_status='approved' WHERE landmark_images.data_mode=$9 AND landmark_images.usage_status<>'rejected'
      RETURNING image_id`,[...values(image),config.DATA_MODE,viewer(image.id)]);
    if(!saved.rowCount) throw Error('Image already rejected or assigned to another data mode');
    const ids=[cueId,saved.rows[0].image_id,cue.landmark_id];
    await db.query('INSERT INTO public.landmark_image_links(landmark_id,image_id,data_mode) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[cue.landmark_id,ids[1],config.DATA_MODE]);
    await db.query(`INSERT INTO public.cue_images(cue_id,image_id,landmark_id,display_order)
      SELECT $1,$2,$3,coalesce(max(display_order),0)+1 FROM public.cue_images WHERE cue_id=$1
      ON CONFLICT(cue_id,image_id) DO NOTHING`,ids);
    await db.query('COMMIT');
    console.log('Approved for cue',cueId);
  } finally {await db.end();}
}
main().catch((error:unknown)=>{
  console.error(error instanceof ProviderError?error.message:error instanceof Error && error.constructor===Error
    && !/fetch|connection/i.test(error.message)?error.message:'Mapillary configuration, database or upstream request failed.');
  process.exitCode=1;
});
