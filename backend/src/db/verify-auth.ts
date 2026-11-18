import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';

// Runs inside the caller's rollback-only transaction, including Auth fixtures.
export async function verifyAuthSchema(db: Client) {
  const user = randomUUID();
  const session = randomUUID();
  const resolve = () => db.query('SELECT * FROM streeteye_private.resolve_contributor($1,$2)', [user, session]);
  let count = 0;
  async function check(name: string, body: () => Promise<void>) {
    await body(); count++;
    console.log(JSON.stringify({ test: name, status: 'passed' }));
  }
  async function denied(sql: string) {
    await db.query('SAVEPOINT denied');
    let code: unknown;
    try { await db.query(sql); } catch (error) { code = (error as { code?: unknown }).code; }
    await db.query('ROLLBACK TO SAVEPOINT denied');
    await db.query('RELEASE SAVEPOINT denied');
    assert.equal(code, '42501');
  }
  await db.query('SAVEPOINT auth_fixtures');
  await db.query('INSERT INTO auth.users(id) VALUES ($1)', [user]);
  await check('Auth requires a live session belonging to the same user', async () => {
    assert.equal((await resolve()).rowCount, 0);
    await db.query('INSERT INTO auth.sessions(id,user_id) VALUES ($1,$2)', [session,user]);
    const wrong = await db.query('SELECT * FROM streeteye_private.resolve_contributor($1,$2)', [randomUUID(),session]);
    assert.equal(wrong.rowCount, 0);
  });
  let contributor: string;
  await check('Runtime provisions exactly one default rider and retries preserve its ID', async () => {
    await db.query('SET LOCAL ROLE streeteye_backend');
    const first = (await resolve()).rows[0];
    contributor = first.contributor_id;
    assert.deepEqual(first, { contributor_id: contributor, role: 'rider', disabled: false });
    assert.deepEqual((await resolve()).rows[0], first);
    await db.query('RESET ROLE');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM public.contributors WHERE auth_user_id=$1',[user])).rows[0].n, 1);
  });
  await check('Provisioning preserves maintainer role and disabled status', async () => {
    await db.query("UPDATE public.contributors SET role='maintainer', disabled_at=now() WHERE auth_user_id=$1",[user]);
    await db.query('SET LOCAL ROLE streeteye_backend');
    assert.deepEqual((await resolve()).rows[0], { contributor_id: contributor!, role: 'maintainer', disabled: true });
    await db.query('RESET ROLE');
  });
  await check('Banned/deleted users and expired/revoked sessions are rejected', async () => {
    for (const change of ["banned_until=now()+interval '1 hour'", 'deleted_at=now()']) {
      await db.query(`UPDATE auth.users SET ${change} WHERE id=$1`, [user]);
      assert.equal((await resolve()).rowCount, 0);
      await db.query('UPDATE auth.users SET banned_until=NULL,deleted_at=NULL WHERE id=$1',[user]);
    }
    await db.query("UPDATE auth.sessions SET not_after=now()-interval '1 second' WHERE id=$1",[session]);
    assert.equal((await resolve()).rowCount, 0);
    await db.query('DELETE FROM auth.sessions WHERE id=$1',[session]);
    assert.equal((await resolve()).rowCount, 0);
  });
  await check('Runtime cannot read Auth, change roles, modify data or migration history', async () => {
    await db.query('SET LOCAL ROLE streeteye_backend');
    for (const sql of [
      'SELECT id FROM auth.users LIMIT 1', 'SELECT * FROM public.contributors LIMIT 1',
      "UPDATE public.contributors SET role='maintainer'", 'DELETE FROM public.reports',
      'SELECT * FROM streeteye_meta.schema_migrations', 'CREATE TABLE public.be05_forbidden(id integer)',
    ]) await denied(sql);
    await db.query('RESET ROLE');
    const role = (await db.query("SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname='streeteye_backend'")).rows[0];
    assert.ok(Object.values(role).every((value) => value === false));
  });
  await check('Mobile/API roles cannot invoke private provisioning', async () => {
    for (const role of ['anon','authenticated','service_role']) {
      const result = await db.query("SELECT has_schema_privilege($1,'streeteye_private','USAGE') AS usage, has_function_privilege($1,'streeteye_private.resolve_contributor(uuid,uuid)','EXECUTE') AS execute",[role]);
      assert.deepEqual(result.rows[0], { usage: false, execute: false });
    }
  });
  await db.query('ROLLBACK TO SAVEPOINT auth_fixtures');
  await db.query('RELEASE SAVEPOINT auth_fixtures');
  console.log(JSON.stringify({ authDatabaseChecks: count, fixtures: 'rolled_back' }));
}
