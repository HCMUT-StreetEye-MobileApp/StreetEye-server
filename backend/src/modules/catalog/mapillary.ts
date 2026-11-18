import { z } from 'zod';

export interface Turn {
  longitude:number; latitude:number; approach_bearing:number; bearing_tolerance_deg:number;
}
const imageSchema=z.object({
  id:z.string().regex(/^\d+$/), geometry:z.object({type:z.literal('Point'),coordinates:z.tuple([
    z.number().min(-180).max(180),z.number().min(-90).max(90)])}),
  compass_angle:z.number().min(0).lt(360), captured_at:z.number().int().min(0).max(8640000000000000).nullish(),
  thumb_1024_url:z.url({protocol:/^https$/}), creator:z.object({username:z.string().trim().min(1).max(120)}).nullish()
});
export type MapImage=z.infer<typeof imageSchema>;
const fields='id,geometry,compass_angle,captured_at,thumb_1024_url,creator';
const radians=Math.PI/180;

export function distance(turn:Turn,image:MapImage){
  const [lon,lat]=image.geometry.coordinates;
  const a=Math.sin((lat-turn.latitude)*radians/2)**2 +
    Math.cos(turn.latitude*radians)*Math.cos(lat*radians)*Math.sin((lon-turn.longitude)*radians/2)**2;
  return 12742000*Math.asin(Math.sqrt(Math.min(1,a)));
}
export function eligible(turn:Turn,image:MapImage){
  const delta=Math.abs(turn.approach_bearing-image.compass_angle);
  return distance(turn,image)<=50 && Math.min(delta,360-delta)<=turn.bearing_tolerance_deg;
}
export function deliveryExpiry(image:MapImage,now=Date.now()){
  const oe=new URL(image.thumb_1024_url).searchParams.get('oe');
  const ttl=now+60*60*1000;
  return new Date(oe && /^[\da-f]{8}$/i.test(oe)?Math.min(ttl,parseInt(oe,16)*1000):ttl);
}

export class Mapillary {
  constructor(private token:string,private request:typeof fetch=fetch){}
  private async read(path:string,params:Record<string,string>){
    const url=new URL(path,'https://graph.mapillary.com/');
    url.search=new URLSearchParams({fields,...params}).toString();
    for(let attempt=0;attempt<2;attempt++){
      try {
        const response=await this.request(url,{headers:{Authorization:'OAuth '+this.token},redirect:'error',signal:AbortSignal.timeout(3000)});
        if(response.ok) return await response.json() as unknown;
        await response.body?.cancel();
        if(response.status<500 || attempt===1) throw new ProviderError(response.status);
      } catch(error){
        if(error instanceof ProviderError || attempt===1) throw error;
      }
      await new Promise(resolve=>setTimeout(resolve,150));
    }
    throw Error('Mapillary unavailable');
  }
  async discover(turn:Turn){
    const dy=0.00046, dx=dy/Math.cos(turn.latitude*radians);
    const bbox=[turn.longitude-dx,turn.latitude-dy,turn.longitude+dx,turn.latitude+dy].join(',');
    const response=z.object({data:z.array(z.unknown())}).parse(await this.read('images',{bbox,limit:'100'}));
    return response.data.flatMap(row=>{
      const result=imageSchema.safeParse(row);
      return result.success && eligible(turn,result.data)?[result.data]:[];
    }).sort((a,b)=>distance(turn,a)-distance(turn,b)||a.id.localeCompare(b.id));
  }
  async image(id:string){
    if(!/^\d+$/.test(id)) throw Error('Invalid Mapillary ID');
    const row=imageSchema.parse(await this.read(id,{}));
    if(row.id!==id) throw Error('Unexpected image ID');
    return row;
  }
}
export class ProviderError extends Error {
  constructor(readonly status:number){super('Mapillary HTTP '+status);}
}
