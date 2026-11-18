import 'dotenv/config';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Client} from 'pg';
import {parseEnv} from '../dist/config/env.js';
import {connectionSettings} from '../dist/db/database.js';

// Two independent transactions. Both roll back; no synthetic events are committed.
const cfg=parseEnv(process.env);
const settings={...connectionSettings(cfg,cfg.DIRECT_URL),query_timeout:20000};
const first=new Client(settings),second=new Client(settings),observer=new Client(settings);
try{
 await Promise.all([first.connect(),second.connect(),observer.connect()]);
 const actor=(await observer.query("SELECT contributor_id FROM public.reports WHERE source='seed' AND data_mode='demo' LIMIT 1")).rows[0]?.contributor_id;
 assert.ok(actor,'Import BE-06 demo before running the concurrency test.');
 const pid=(await second.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 const firstPid=(await first.query('SELECT pg_backend_pid() pid')).rows[0].pid;
 const p={client_event_id:randomUUID(),data_mode:'demo',source:'manual',classification_method:'chosen',hazard_type:'unknown',severity:'unknown',
 observed_at:new Date().toISOString(),position:{longitude:106.8015,latitude:10.8815},accuracy_m:3};
 const args=[actor,'report',null,p,'rollback-smoke'];
 const sql='SELECT streeteye_private.submit_event($1,$2,$3,$4,$5) AS result';
 await Promise.all([first.query('BEGIN; SET LOCAL ROLE streeteye_backend'),second.query('BEGIN; SET LOCAL ROLE streeteye_backend')]);
 assert.equal((await first.query(sql,args)).rows[0].result.replay,false);
 const pending=second.query(sql,args).then(result=>({result}),error=>({error}));
 let blocked=false;
 for(let i=0;i<10&&!blocked;i++){
   blocked=(await observer.query('SELECT $1::int=ANY(pg_blocking_pids($2)) AS blocked',[firstPid,pid])).rows[0].blocked;
   if(!blocked) await new Promise(r=>setTimeout(r,100));
 }
 assert.ok(blocked,'Second writer must wait for the first transaction.');
 await first.query('ROLLBACK');
 const output=await pending;if(output.error)throw output.error;
 assert.equal(output.result.rows[0].result.replay,false);
 assert.equal((await second.query(sql,args)).rows[0].result.replay,true);
 console.log('Two independent runtime writers serialized. Waiting writer succeeded after rollback and retry replayed the ACK.');
} finally{
 await first.end();await second.end();await observer.end();
}
