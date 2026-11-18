import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

// Reference client for the P2/P4 integration test. Both HTTP snapshots and
// receipts come from the Express app backed by PostgreSQL.
export async function exerciseOfflineReview({owner,otherOwner,post,readReport,report,oldHazard,before,after}){
  const dir=mkdtempSync(join(tmpdir(),'streeteye-ride-'));
  const path=join(dir,'ride.sqlite');
  let local=new DatabaseSync(path);
  try {
    local.exec(`CREATE TABLE outbox(owner TEXT, id TEXT, payload TEXT, PRIMARY KEY(owner,id));
      CREATE TABLE routes(revision TEXT PRIMARY KEY, snapshot TEXT NOT NULL)`);
    const event={source:'sensor_confirmed',data_mode:'demo',client_event_id:randomUUID(),
      observed_at:report.observed_at,confirmed_at:new Date().toISOString(),position:report.position,
      accuracy_m:report.accuracy_m,heading_deg:report.heading_deg,hazard_type:report.hazard_type};
    local.prepare('INSERT INTO outbox VALUES(?,?,?)').run(owner,event.client_event_id,JSON.stringify(event));
    const pending=actor=>local.prepare('SELECT payload FROM outbox WHERE owner=?').all(actor);
    const replace=snap=>{
      if(!snap?.complete || snap.route_revision!==before.route_revision || snap.data_mode!==before.data_mode) return;
      local.prepare('INSERT OR REPLACE INTO routes VALUES(?,?)').run(snap.route_revision,JSON.stringify(snap));
    };
    const cached=()=>JSON.parse(local.prepare('SELECT snapshot FROM routes WHERE revision=?').get(before.route_revision).snapshot);
    replace(before);
    const first=(await post('reports',JSON.parse(pending(owner)[0].payload)).expect(201)).body;
    assert.equal(first.eligible_for_alert,false);
    assert.deepEqual(first.reason_codes,['NEEDS_REVIEW']);
    assert.equal(first.hazard_id,null);
    assert.equal(first.observed_at,event.observed_at);
    // Simulate losing the ACK and restarting the client before dequeue.
    local.close();
    local=new DatabaseSync(path);
    assert.equal(pending(otherOwner).length,0);
    const retry=JSON.parse(pending(owner)[0].payload);
    const replay=await post('reports',retry).expect(200).expect('Idempotency-Replayed','true');
    assert.deepEqual(replay.body,first);
    await post('reports',{...retry,heading_deg:90}).expect(409);
    const stored=(await readReport(first.report_id)).body;
    assert.equal(stored.observation.confirmed_at,event.confirmed_at);
    local.prepare('DELETE FROM outbox WHERE owner=? AND id=?').run(owner,replay.body.client_event_id);
    assert.equal(pending(owner).length,0);
    for(const failed of [null,{...after,complete:false},{...after,route_revision:'previous'}]){
      replace(failed);
      assert.equal(cached().snapshot_id,before.snapshot_id);
    }
    replace(after);
    assert.equal(cached().snapshot_id,after.snapshot_id);
    assert.ok(!cached().hazards.some(h=>h.hazard_id===oldHazard));
  } finally {
    local.close();
    rmSync(dir,{recursive:true,force:true});
  }
}
