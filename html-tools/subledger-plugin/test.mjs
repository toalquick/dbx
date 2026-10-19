import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const html = readFileSync(new URL('./ui/index.html', import.meta.url), 'utf8');
const core = html.match(/<script id="core">([\s\S]*?)<\/script>/)[1];
const S = vm.runInNewContext(core + '\nSubledger;');
const input = { client: '7', entities: '12', seeds: '1', type: 'customer' };
const l = (uid, ref = null, cross = null, extra = {}) => ({ uid, clientuid: '7', customeruid: '12', referencenumber: ref, crossreferencenumber: cross, amount: '10.00', balance: '0', basebalance: '0', description: '', journaldate: '', ...extra });
const h = (uid, subledgeruid, identityid = null, extra = {}) => ({ uid, clientuid: '7', subledgeruid, identityid, balance: '10.00', basebalance: '20.00', balancechange: '10', ...extra });
const data = rows => ({ columns: Object.keys(rows[0]), rows });
const analyze = (ledgers, history, params = input) => S.analyze(data(ledgers), data(history), params);
test('reference and identity traversal reaches a fixed point and ignores null/zero identities', () => {
  const result = analyze([l('1', 'a'), l('2', null, 'a'), l('3', 'b'), l('4', null, 'b'), l('5'), l('6')], [h('11', '1'), h('12', '2', 'x'), h('13', '3', 'x'), h('14', '4', 'y'), h('15', '5', 'y'), h('16', '6', '0')]);
  assert.equal(result.connected.map(r => r.uid).sort().join(','), '1,2,3,4,5');
});
test('scope isolates other clients and entities, and rejects missing seeds', () => {
  const r = analyze([l('1', 'a'), l('2', 'a', null, { clientuid: '8' }), l('3', 'a', null, { customeruid: '13' })], [h('10', '1')]);
  assert.equal(r.connected.length, 1);
  assert.throws(() => analyze([l('1')], [h('10', '1')], { ...input, seeds: '2' }), /outside/);
});
test('supplier wildcard selects the entire scoped set', () => {
  const r = analyze([l('1', null, null, { supplieruid: '12' }), l('2', null, null, { supplieruid: '12' })], [h('10', '1')], { ...input, type: 'supplier', seeds: '*' });
  assert.equal(r.connected.length, 2);
  assert.equal(r.warnings.length, 1);
});
test('big UIDs and exact decimals survive cleanup and SQL generation', () => {
  const uid = '9007199254740993123';
  const r = analyze([l(uid)], [h('9007199254740993125', uid), h('9007199254740993124', uid, null, { balance: '123456789012345678.12345678' })], { ...input, seeds: '*' });
  const sql = S.sql(r, 'dbo', 'mssql');
  assert.match(sql, /SET balance = 123456789012345678\.12345678/);
  assert.match(sql, /DELETE FROM \[dbo\]\.\[subledgerbalancehistory\] WHERE clientuid = 7 AND subledgeruid = 9007199254740993123 AND uid = 9007199254740993125/);
  assert.doesNotMatch(sql, /uid !=/);
  assert.match(sql, /AND balance = 0 AND basebalance = 0/);
  assert.equal(S.decimal('-0.00'), '0');
  assert.equal(S.decimal('+00010.1000'), '10.1');
});
test('decimal equality avoids unnecessary updates and invalid amounts block SQL', () => {
  const r = analyze([l('1', null, null, { balance: '10', basebalance: '20.0' })], [h('10', '1')]);
  assert.match(S.sql(r), /No corrections needed/);
  for (const value of [null, '1; DROP TABLE subledger', 'NaN', 0.1]) {
    assert.throws(() => analyze([l('1', null, null, { balance: value })], [h('10', '1')]));
  }
  assert.throws(() => S.id(9007199254740992), /precision/);
});
test('CSV supports BOM, delimiter detection, escaped quotes, newlines and leading zero references', () => {
  const parsed = S.csv('\uFEFFUID;Description;ReferenceNumber\r\n9007199254740993123;"a; b ""quote""\nline";00123\r\n');
  assert.equal(parsed.rows[0].uid, '9007199254740993123');
  assert.equal(parsed.rows[0].description, 'a; b "quote"\nline');
  assert.equal(parsed.rows[0].referencenumber, '00123');
  assert.equal(S.csv('uid\tdescription\n1\t"hello"').rows[0].uid, '1');
  assert.equal(S.csv('uid,x\n1,NULL').rows[0].x, null);
  assert.throws(() => S.csv('uid,x\n1,"unclosed'), /Unclosed/);
  assert.throws(() => S.csv('uid,UID\n1,2'), /unique/);
  assert.throws(() => S.csv('uid,x\n1,2,3'), /fields/);
});
test('duplicates, missing columns and injected inputs are rejected', () => {
  assert.throws(() => analyze([l('1'), l('1')], [h('10', '1')]), /Duplicate/);
  assert.throws(() => analyze([l('1')], [h('10', '1'), h('10', '1')]), /Duplicate/);
  assert.throws(() => S.analyze(data([{ uid: '1' }]), data([h('10', '1')]), input), /column/);
  assert.throws(() => S.scope({ ...input, client: '7 OR 1=1' }), /integer/);
  assert.throws(() => S.select('subledger', S.scope(input), 'dbo;DROP', 'postgres'), /identifier/);
});
test('history DELETE checks original values and escapes identity IDs', () => {
  const r = analyze([l('1')], [h('10', '1'), h('11', '1', "a'b")]);
  assert.match(S.sql(r), /identityid = 'a''b'/);
  assert.match(S.sql(r), /AND balance = 10 AND basebalance = 20 AND balancechange = 10/);
});
test('live keyset paging continues truncated pages, preserving precision', async () => {
  const calls = [];
  const result = await S.load(async req => {
    calls.push(req);
    return { columns: [{ name: 'uid' }], rows: [[calls.length === 1 ? '9007199254740993123' : '9007199254740993124']], truncated: calls.length === 1 };
  }, { connectionId: 'test' }, 'subledger', S.scope(input), '', 'postgres', () => {});
  assert.equal(result.rows.length, 2);
  assert.match(calls[1].sql, /AND dbx_row\.uid > 9007199254740993123 ORDER BY dbx_row\.uid/);
  assert.match(calls[0].sql, /CAST\(balance AS VARCHAR\(100\)\)/);
  await assert.rejects(() => S.load(async () => ({ columns: ['uid'], rows: [], truncated: true }), {}, 'subledger', S.scope(input), '', 'postgres', () => {}), /truncated/);
});
test('UI imports CSV, displays results safely, copies through host, and invalidates stale SQL', async () => {
  const { Window } = require('happy-dom');
  const window = new Window({ url: 'http://localhost/' });
  const doc = window.document;
  doc.write(html.replace(/<script[\s\S]*?<\/script>/g, ''));
  const requests = [];
  window.dbxPlugin = { ready: Promise.resolve({ connectionId: 'test', dbType: 'mssql', schema: 'dbo' }), onContext() {}, request: async (...args) => requests.push(args) };
  window.eval(core + '\nwindow.Subledger = Subledger;');
  window.eval(html.match(/<script>\n([\s\S]*?)<\/script>/)[1]);
  await new Promise(resolve => setTimeout(resolve, 0));
  const $ = id => doc.getElementById(id);
  assert.equal($('connection').value, 'test');
  assert.equal($('dialect').value, 'mssql');
  $('source').value = 'csv'; $('source').dispatchEvent(new window.Event('change'));
  $('client').value = '7'; $('entities').value = '12'; $('seeds').value = '1';
  const ledger = l('1', null, null, { description: '<img src=x onerror=alert(1)>' });
  const history = h('10', '1');
  const csv = row => Object.keys(row).join(',') + '\n' + Object.values(row).map(v => v ?? '').join(',');
  Object.defineProperty($('ledgerFile'), 'files', { value: [{ text: async () => csv(ledger) }] });
  Object.defineProperty($('historyFile'), 'files', { value: [{ text: async () => csv(history) }] });
  $('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal($('results').hidden, false, $('status').textContent);
  assert.equal($('rows').querySelector('img'), null);
  assert.match($('rows').textContent, /<img/);
  assert.match($('sql').value, /UPDATE \[dbo\]\.\[subledger\]/);
  $('copySql').click(); await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(requests[0][0], 'host.copy');
  $('entities').dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal($('results').hidden, true);
  assert.equal($('sql').value, '');
  await window.happyDOM.close();
});
test('generated SQL corrects SQLite fixtures while preserving other clients and unobserved history', async () => {
  const { spawnSync } = await import('node:child_process');
  const result = analyze([l('1')], [h('10', '1'), h('11', '1', 'x')]);
  const script = S.sql(result, '', 'sqlite');
  const python = `import sqlite3, sys, json
c = sqlite3.connect(':memory:')
c.executescript('''CREATE TABLE subledger (uid INTEGER, clientuid INTEGER, customeruid INTEGER, balance NUMERIC, basebalance NUMERIC);
CREATE TABLE subledgerbalancehistory (uid INTEGER, clientuid INTEGER, subledgeruid INTEGER, identityid TEXT, balance NUMERIC, basebalance NUMERIC, balancechange NUMERIC);
INSERT INTO subledger VALUES (1,7,12,0,0),(1,8,12,0,0);
INSERT INTO subledgerbalancehistory VALUES (10,7,1,NULL,10,20,10),(11,7,1,'x',10,20,10),(12,7,1,'new',10,20,10),(11,8,1,'x',10,20,10);''')
c.executescript(sys.stdin.read())
assert c.execute('SELECT balance,basebalance FROM subledger WHERE clientuid=7').fetchone() == (10,20)
assert c.execute('SELECT balance,basebalance FROM subledger WHERE clientuid=8').fetchone() == (0,0)
assert c.execute('SELECT uid,clientuid FROM subledgerbalancehistory ORDER BY clientuid,uid').fetchall() == [(10,7),(12,7),(11,8)]
print('verified')`;
  const run = spawnSync('python3', ['-c', python], { input: script, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
});
test('live queries page both tables in numeric UID order across digit boundaries', async () => {
  const { spawnSync } = await import('node:child_process');
  for (const name of ['subledger', 'subledgerbalancehistory']) {
    const calls = [];
    const result = await S.load(async request => {
      calls.push(request.sql);
      const python = `import sqlite3,json,sys
c=sqlite3.connect(':memory:')
c.executescript('''CREATE TABLE subledger (uid INTEGER, clientuid INTEGER, customeruid INTEGER, referencenumber TEXT, crossreferencenumber TEXT, amount NUMERIC, balance NUMERIC, basebalance NUMERIC, description TEXT, journaldate TEXT);
CREATE TABLE subledgerbalancehistory (uid INTEGER, clientuid INTEGER, subledgeruid INTEGER, identityid TEXT, balance NUMERIC, basebalance NUMERIC, balancechange NUMERIC);''')
for uid in [2,10,100,1000,10000]:
 c.execute('INSERT INTO subledger VALUES (?,7,12,NULL,NULL,10,0,0,NULL,NULL)',(uid,))
 c.execute('INSERT INTO subledgerbalancehistory VALUES (?,7,?,NULL,10,20,10)',(uid,uid))
cursor=c.execute(sys.stdin.read())
rows=cursor.fetchmany(3)
print(json.dumps({'columns':[{'name':x[0]} for x in cursor.description],'rows':rows[:2],'truncated':len(rows)>2}))`;
      const run = spawnSync('python3', ['-c', python], { input: request.sql, encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr);
      return JSON.parse(run.stdout);
    }, { connectionId: 'test' }, name, S.scope(input), '', 'sqlite', () => {});
    assert.equal(result.rows.map(r => r[0]).join(','), '2,10,100,1000,10000');
    assert.equal(calls.length, 3);
  }
});
test('paging still rejects actual duplicate or decreasing UIDs', async () => {
  for (const rows of [[['2'], ['2']], [['10'], ['2']]]) {
    await assert.rejects(() => S.load(async () => ({ columns: ['uid'], rows, truncated: false }), {}, 'subledger', S.scope(input), '', 'postgres', () => {}), /Unordered or duplicate/);
  }
});
test('database menu context populates connection, database and dialect and clears previous results on reuse', async () => {
  const { Window } = require('happy-dom');
  const window = new Window({ url: 'http://localhost/' });
  const doc = window.document;
  doc.write(html.replace(/<script[\s\S]*?<\/script>/g, ''));
  let updateContext;
  window.dbxPlugin = {
    ready: Promise.resolve({ connectionId: 'flex', database: 'quick3_no_007', dbType: 'postgresql' }),
    onContext(listener) { updateContext = listener; },
  };
  window.eval(core + '\nwindow.Subledger = Subledger;');
  window.eval(html.match(/<script>\n([\s\S]*?)<\/script>/)[1]);
  await new Promise(resolve => setTimeout(resolve, 0));
  const $ = id => doc.getElementById(id);
  assert.equal($('connection').value, 'flex');
  assert.equal($('database').value, 'quick3_no_007');
  assert.equal($('dialect').value, 'postgres');
  $('results').hidden = false;
  $('sql').value = 'Previous database SQL';
  updateContext({ connectionId: 'another-connection', database: 'quick3_no_008', dbType: 'mssql' });
  assert.equal($('connection').value, 'another-connection');
  assert.equal($('database').value, 'quick3_no_008');
  assert.equal($('dialect').value, 'mssql');
  assert.equal($('results').hidden, true);
  assert.equal($('sql').value, '');
  await window.happyDOM.close();
});
test('recovery plans round-trip and reject unsupported engines, invalid identifiers and unknown formats', () => {
  const plan = S.recoveryPlan({ dialect: 'postgres', database: 'quick3_no_007', schema: 'public', token: 'before_cleanup' });
  assert.equal(JSON.stringify(S.readRecoveryPlan(JSON.stringify(plan))), JSON.stringify(plan));
  for (const change of [{ dialect: 'mysql' }, { schema: '' }, { schema: 'public; DROP TABLE x' }, { database: '' }, { token: '../backup' }, { token: 'x'.repeat(33) }]) {
    assert.throws(() => S.recoveryPlan({ ...plan, ...change }));
  }
  assert.throws(() => S.readRecoveryPlan('{"format":"other","version":1}'), /format/);
  assert.throws(() => S.readRecoveryPlan(JSON.stringify({ ...plan, version: 2 })), /version/);
  assert.throws(() => S.snapshotSql(plan, 'drop'), /operation/);
});
test('snapshot SQL uses full database tables, atomic blocks, locks and escaped database guards', () => {
  const plan = { dialect: 'postgres', database: "test'\\\n$dbx_snapshot_0$", schema: 'public', token: 'safe' };
  const sql = S.snapshotSql(plan, 'create');
  assert.match(sql, /DO \$dbx_snapshot_1\$/);
  assert.match(sql, /CREATE TABLE "public"\."dbx_sl_safe" AS TABLE "public"\."subledger"/);
  assert.match(sql, /CREATE TABLE "public"\."dbx_sbh_safe" AS TABLE "public"\."subledgerbalancehistory"/);
  assert.match(sql, /IN SHARE MODE/);
  assert.match(sql, /row_security = off/);
  assert.doesNotMatch(sql, /WHERE clientuid|WHERE customeruid|WHERE supplieruid/);
  const restore = S.snapshotSql(plan, 'restore');
  assert.match(restore, /ACCESS EXCLUSIVE MODE/);
  assert.match(restore, /OVERRIDING SYSTEM VALUE/);
  assert.match(restore, /attgenerated = ''/);
  assert.match(restore, /EXCEPT ALL/);
  assert.doesNotMatch(restore, /DISABLE TRIGGER|TRUNCATE|DROP TABLE/);
  assert.ok(restore.indexOf('DELETE FROM "public"."subledgerbalancehistory"') < restore.indexOf('DELETE FROM "public"."subledger" t'));
});
test('snapshot UI prepares SQL without executing writes and saves/reloads the recovery plan', async () => {
  const { Window } = require('happy-dom');
  const window = new Window({ url: 'http://localhost/' });
  const doc = window.document;
  doc.write(html.replace(/<script[\s\S]*?<\/script>/g, ''));
  const saves = [], copies = [];
  let contextListener;
  window.dbxPlugin = {
    ready: Promise.resolve({ connectionId: 'flex', database: 'quick3_no_007', schema: 'public', dbType: 'postgres' }),
    onContext(listener) { contextListener = listener; },
    queryData() { throw new Error('Snapshot UI must not execute queries or writes.'); },
    saveFile: async (options, bytes) => { saves.push({ ...options, text: new TextDecoder().decode(bytes) }); return { path: '/tmp/saved' }; },
    request: async (method, params) => copies.push({ method, ...params }),
  };
  window.eval(core + '\nwindow.Subledger = Subledger;');
  window.eval(html.match(/<script>\n([\s\S]*?)<\/script>/)[1]);
  const tick = () => new Promise(resolve => setTimeout(resolve, 0));
  await tick();
  const $ = id => doc.getElementById(id);
  const token = $('snapshotToken').value;
  $('prepareSnapshot').click();
  assert.equal($('snapshotPreview').hidden, false);
  assert.match($('snapshotSql').value, /CREATE FULL-TABLE SNAPSHOT/);
  $('copySnapshotSql').click(); await tick();
  assert.equal(copies[0].method, 'host.copy');
  $('savePlan').click(); await tick();
  const plan = JSON.parse(saves[0].text);
  assert.equal(plan.token, token);
  assert.equal(plan.database, 'quick3_no_007');
  assert.doesNotMatch(saves[0].text, /password|rows|credentials/);
  $('prepareRestore').click();
  assert.match($('snapshotSql').value, /RESTORE BOTH FULL TABLES/);
  $('saveSnapshotSql').click(); await tick();
  assert.match(saves[1].fileName, /-restore\.sql$/);
  contextListener({ connectionId: 'flex', database: 'quick3_no_008', dbType: 'postgres' });
  assert.equal($('snapshotPreview').hidden, true);
  assert.notEqual($('snapshotToken').value, token);
  Object.defineProperty($('loadPlan'), 'files', { value: [{ size: saves[0].text.length, text: async () => saves[0].text }] });
  $('loadPlan').dispatchEvent(new window.Event('change')); await tick();
  assert.equal($('database').value, 'quick3_no_007');
  assert.equal($('schema').value, 'public');
  assert.equal($('snapshotToken').value, token);
  assert.equal($('snapshotPreview').hidden, true);
  $('prepareRestore').click();
  assert.match($('snapshotSql').value, /RESTORE BOTH FULL TABLES/);
  $('snapshotToken').dispatchEvent(new window.Event('input'));
  assert.equal($('snapshotPreview').hidden, true);
  await window.happyDOM.close();
});
