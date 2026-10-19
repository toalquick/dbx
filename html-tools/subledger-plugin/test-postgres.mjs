import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PGlite } = require('./.dbx-dev/node_modules/@electric-sql/pglite');
const html = readFileSync(new URL('./ui/index.html', import.meta.url), 'utf8');
const S = vm.runInNewContext(html.match(/<script id="core">([\s\S]*?)<\/script>/)[1] + '\nSubledger;');
let db, database;
before(async () => { db = new PGlite(); database = (await db.query('SELECT current_database() AS name')).rows[0].name; });
after(async () => { await db?.close(); });
async function fixture(schema) {
  await db.exec(`CREATE SCHEMA ${schema};
CREATE TABLE ${schema}.subledger (
 uid BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 clientuid BIGINT NOT NULL, amount NUMERIC(30,8), balance NUMERIC(30,8), basebalance NUMERIC(30,8),
 description TEXT, posted BOOLEAN, journaldate DATE, details JSONB, payload BYTEA,
 doubled NUMERIC GENERATED ALWAYS AS (amount * 2) STORED
);
CREATE TABLE ${schema}.subledgerbalancehistory (
 uid BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 clientuid BIGINT NOT NULL, subledgeruid BIGINT REFERENCES ${schema}.subledger(uid),
 balance NUMERIC(30,8), basebalance NUMERIC(30,8), balancechange NUMERIC(30,8), identityid TEXT, extra TEXT
);
INSERT INTO ${schema}.subledger (uid,clientuid,amount,balance,basebalance,description,posted,journaldate,details,payload) OVERRIDING SYSTEM VALUE VALUES
(9007199254740993,7,123456789012345678.12345678,7.12345678,9,'Original ''quoted'' description',true,'2026-10-15','{"nested":[1,null,"€"]}',decode('00ff','hex')),
(2,8,20,20,20,NULL,false,NULL,NULL,NULL);
INSERT INTO ${schema}.subledgerbalancehistory (uid,clientuid,subledgeruid,balance,basebalance,balancechange,identityid,extra) OVERRIDING SYSTEM VALUE VALUES
(1,7,9007199254740993,10,10,10,NULL,'first'),(2,7,9007199254740993,7.12345678,9,-2.87654322,'x','deleted later'),(3,8,2,20,20,20,NULL,'another client');`);
  return S.recoveryPlan({ database, schema, dialect: 'postgres', token: 'before_cleanup' });
}
async function rows(schema, table) {
  return (await db.query(`SELECT to_jsonb(t)::text AS row FROM ${schema}.${table} t ORDER BY uid`)).rows;
}
test('PostgreSQL full-table snapshot restores every column, deleted and inserted rows, IDs and exact amounts', async () => {
  const p = await fixture('roundtrip');
  const originalLedger = await rows(p.schema, 'subledger'), originalHistory = await rows(p.schema, 'subledgerbalancehistory');
  await db.exec(S.snapshotSql(p, 'create'));
  await db.exec(`UPDATE roundtrip.subledger SET balance=999,description='changed',details='{}',payload=NULL;
DELETE FROM roundtrip.subledgerbalancehistory WHERE uid IN (2,3);
INSERT INTO roundtrip.subledger (uid,clientuid,amount) OVERRIDING SYSTEM VALUE VALUES (777,9,55);
INSERT INTO roundtrip.subledgerbalancehistory (uid,clientuid,subledgeruid,extra) OVERRIDING SYSTEM VALUE VALUES (777,9,777,'new row');`);
  await db.exec(S.snapshotSql(p, 'restore'));
  assert.deepEqual(await rows(p.schema, 'subledger'), originalLedger);
  assert.deepEqual(await rows(p.schema, 'subledgerbalancehistory'), originalHistory);
  assert.equal((await db.query('SELECT count(*)::text AS n FROM roundtrip.dbx_sbh_before_cleanup')).rows[0].n, '3');
  // Recovery is repeatable; backups are retained.
  await db.exec(S.snapshotSql(p, 'restore'));
  assert.deepEqual(await rows(p.schema, 'subledgerbalancehistory'), originalHistory);
});
test('duplicate snapshot names fail without modifying or replacing the original backup', async () => {
  const p = await fixture('duplicate'); await db.exec(S.snapshotSql(p, 'create'));
  await db.exec('UPDATE duplicate.subledger SET balance=999');
  await assert.rejects(() => db.exec(S.snapshotSql(p, 'create')), /already exists/);
  assert.equal((await db.query('SELECT balance::text AS balance FROM duplicate.dbx_sl_before_cleanup WHERE uid=2')).rows[0].balance, '20.00000000');
});
test('wrong database, changed source definitions and missing backup tables stop before modifying rows', async () => {
  const p = await fixture('guards'); await db.exec(S.snapshotSql(p, 'create'));
  await assert.rejects(() => db.exec(S.snapshotSql({ ...p, database: 'wrong-database' }, 'restore')), /Wrong database/);
  await db.exec('ALTER TABLE guards.subledger ADD COLUMN added TEXT');
  const before = await rows(p.schema, 'subledger');
  await assert.rejects(() => db.exec(S.snapshotSql(p, 'restore')), /definitions changed/);
  assert.deepEqual(await rows(p.schema, 'subledger'), before);
  await db.exec('ALTER TABLE guards.subledger DROP COLUMN added; DROP TABLE guards.dbx_sbh_before_cleanup');
  await assert.rejects(() => db.exec(S.snapshotSql(p, 'restore')), /does not exist/);
  assert.deepEqual(await rows(p.schema, 'subledger'), before.map(row => ({ row: row.row.replace(', "added": null', '').replace('"added": null, ', '') })));
});
test('foreign-key errors for new rows roll back deletion of history rows', async () => {
  const p = await fixture('foreign_keys'); await db.exec(S.snapshotSql(p, 'create'));
  await db.exec('INSERT INTO foreign_keys.subledger (uid,clientuid,amount) OVERRIDING SYSTEM VALUE VALUES (777,9,55); INSERT INTO foreign_keys.subledgerbalancehistory (uid,clientuid,subledgeruid) OVERRIDING SYSTEM VALUE VALUES (777,9,777); CREATE TABLE foreign_keys.external_reference (subledgeruid BIGINT REFERENCES foreign_keys.subledger(uid)); INSERT INTO foreign_keys.external_reference VALUES (777)');
  const before = await rows(p.schema, 'subledgerbalancehistory');
  await assert.rejects(() => db.exec(S.snapshotSql(p, 'restore')), /foreign key constraint/);
  assert.deepEqual(await rows(p.schema, 'subledgerbalancehistory'), before);
});
test('trigger changes during restore are detected and the entire restore rolls back', async () => {
  const p = await fixture('triggers'); await db.exec(S.snapshotSql(p, 'create'));
  await db.exec(`UPDATE triggers.subledger SET balance=99;
CREATE FUNCTION triggers.change_balance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.balance := 55; RETURN NEW; END $$;
CREATE TRIGGER change_balance BEFORE INSERT OR UPDATE ON triggers.subledger FOR EACH ROW EXECUTE FUNCTION triggers.change_balance();`);
  const before = await rows(p.schema, 'subledger');
  await assert.rejects(() => db.exec(S.snapshotSql(p, 'restore')), /Restored rows differ/);
  assert.deepEqual(await rows(p.schema, 'subledger'), before);
});
test('snapshot row count corruption is rejected without deleting current rows', async () => {
  const p = await fixture('corrupt'); await db.exec(S.snapshotSql(p, 'create'));
  await db.exec('DELETE FROM corrupt.dbx_sbh_before_cleanup WHERE uid=2');
  const before = await rows(p.schema, 'subledgerbalancehistory');
  await assert.rejects(() => db.exec(S.snapshotSql(p, 'restore')), /row counts do not match/);
  assert.deepEqual(await rows(p.schema, 'subledgerbalancehistory'), before);
});
test('row security cannot silently produce a partial snapshot', async () => {
  const p = await fixture('row_security');
  await db.exec(`CREATE ROLE snapshot_reader;
GRANT USAGE, CREATE ON SCHEMA row_security TO snapshot_reader;
GRANT SELECT, UPDATE ON ALL TABLES IN SCHEMA row_security TO snapshot_reader;
ALTER TABLE row_security.subledger ENABLE ROW LEVEL SECURITY;
CREATE POLICY client_only ON row_security.subledger FOR SELECT TO snapshot_reader USING (clientuid=7);
SET ROLE snapshot_reader;`);
  try { await assert.rejects(() => db.exec(S.snapshotSql(p, 'create')), /row-level security policy/); }
  finally { await db.exec('RESET ROLE'); }
  assert.equal((await db.query("SELECT count(*)::text AS n FROM pg_tables WHERE schemaname='row_security' AND tablename LIKE 'dbx_%'")).rows[0].n, '0');
});
test('references to existing ledger rows survive an in-place restore', async () => {
  const p = await fixture('reference_keep'); await db.exec(S.snapshotSql(p, 'create'));
  await db.exec('CREATE TABLE reference_keep.external_reference (subledgeruid BIGINT REFERENCES reference_keep.subledger(uid)); INSERT INTO reference_keep.external_reference VALUES (2); UPDATE reference_keep.subledger SET balance=999');
  await db.exec(S.snapshotSql(p, 'restore'));
  assert.equal((await db.query('SELECT balance::text AS n FROM reference_keep.subledger WHERE uid=2')).rows[0].n, '20.00000000');
  assert.equal((await db.query('SELECT count(*)::text AS n FROM reference_keep.external_reference')).rows[0].n, '1');
});
test('read-only snapshot verification reports captured counts and time', async () => {
  const p = await fixture('verification'); await db.exec(S.snapshotSql(p, 'create'));
  const result = await db.query(S.snapshotCheckSql(p));
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].ledger_rows, '2');
  assert.equal(result.rows[0].history_rows, '3');
  assert.equal(result.rows[0].actual_ledger_rows, result.rows[0].ledger_rows);
  assert.equal(result.rows[0].actual_history_rows, result.rows[0].history_rows);
  assert.equal(result.rows[0].database_name, database);
  assert.ok(result.rows[0].captured_at);
});
