const binary={type:'string',format:'binary'};
const auth=[{bearerAuth:[]}];
const reportId={name:'report_id',in:'path',required:true,schema:{type:'string',format:'uuid'}};
const ack={type:'object',required:['report_id','photo_no','moderation_status'],properties:{
  report_id:{type:'string',format:'uuid'},photo_no:{type:'integer',minimum:1,maximum:20},moderation_status:{type:'string',enum:['pending']}}};
const error=(description:string)=>({description,content:{'application/json':{schema:{$ref:'#/components/schemas/Error'}}}});
export const photoPaths={
  '/api/v1/evidence/{report_id}/{photo_no}':{get:{operationId:'getApprovedPhoto',tags:['Reports'],security:[],summary:'Retrieve an approved public evidence image using the URL supplied by the hazard API',parameters:[reportId,{name:'photo_no',in:'path',required:true,schema:{type:'integer'}},{name:'expires',in:'query',required:true,schema:{type:'integer'}},{name:'key',in:'query',required:true,schema:{type:'string'}}],responses:{'200':{description:'Approved image',content:{'image/webp':{schema:binary}}},'404':error('Expired or unavailable image')}}},
  '/api/v1/reports/{report_id}/photos':{post:{
    operationId:'uploadReportPhoto',tags:['Reports'],security:auth,'x-implementation':'implemented',
    summary:'Attach private evidence to an owned report',
    description:'Send raw JPEG, PNG or WebP (2 MiB, up to 16 megapixels). The server strips metadata and stores WebP. Retry the same original bytes with the same upload UUID. Up to 20 photos per report.',
    parameters:[reportId,{in:'header',name:'Idempotency-Key',required:true,schema:{type:'string',format:'uuid'}}],
    requestBody:{required:true,content:Object.fromEntries(['image/jpeg','image/png','image/webp'].map(m=>[m,{schema:binary}]))},
    responses:{'201':{description:'Pending photo stored',content:{'application/json':{schema:ack}}},
      '200':{description:'Original upload replayed',content:{'application/json':{schema:ack}}},
      '401':error('Invalid session'),'403':error('Disabled contributor'),'404':error('Report unavailable'),'409':error('Upload ID conflict'),
      '413':error('File or photo count limit'),'415':error('Unsupported media type'),'422':error('Invalid ID or image'),'503':error('Database unavailable')}
  }},
  '/api/v1/reports/{report_id}/photos/{photo_no}':{get:{
    operationId:'getOwnReportPhoto',tags:['Reports'],security:auth,'x-implementation':'implemented',summary:'Read owned evidence',
    parameters:[reportId,{in:'path',name:'photo_no',required:true,schema:{type:'integer',minimum:1,maximum:20}}],
    responses:{'200':{description:'Private image',content:{'image/webp':{schema:binary}}},'401':error('Invalid session'),'404':error('Photo unavailable'),'503':error('Database unavailable')}
  }}
};
