import 'dotenv/config';
import assert from 'node:assert/strict';
import { Mapillary } from '../dist/modules/catalog/mapillary.js';

const token=process.env.MAPILLARY_ACCESS_TOKEN;
if(!token) throw Error('Set MAPILLARY_ACCESS_TOKEN in backend/.env');
// Public control image, independent of the two demonstration routes.
const api=new Mapillary(token);
const image=await api.image(process.argv[2]??'568070274306488');
const thumb=await fetch(image.thumb_1024_url,{headers:{Range:'bytes=0-511'},signal:AbortSignal.timeout(10000)});
assert.ok(thumb.ok && thumb.headers.get('content-type')?.startsWith('image/'),'Thumbnail HTTP '+thumb.status);
const reader=thumb.body.getReader();
try {
  const first=await reader.read();
  assert.ok(first.value?.length);
} finally { await reader.cancel(); }
console.log({id:image.id,thumbnail:thumb.headers.get('content-type'),catalogWrites:0});
