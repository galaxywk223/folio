import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';

const cache = path.resolve('node_modules/.cache');
fs.mkdirSync(cache, { recursive: true });
const scratch = fs.mkdtempSync(path.join(cache, 'folio-subscriptions-test-'));
const bundle = path.join(scratch, 'test-module.mjs');
await build({
  stdin: {
    contents: "export { Store } from './src/server/store.mjs'; export { startServer } from './src/server/server.mjs'; export * from './src/shared/subscriptions.ts';",
    resolveDir: process.cwd(),
    sourcefile: 'subscriptions-test-entry.mjs',
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
});
const { Store, startServer, matchesSubscriptionFilter } = await import(pathToFileURL(bundle).href);
const stores = new Set();
function root() { return path.join(scratch, crypto.randomUUID()); }
function open(directory = root()) {
  const store = new Store(directory);
  stores.add(store);
  return store;
}
function close(store) { store.close(); stores.delete(store); }
function rawRows(db, table) { return db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all().map(row => ({ ...row })); }
function legacyFixture(version) {
  const store = open();
  const task = store.insertTask({ title: 'Legacy task', bodyMarkdown: '- [ ] Retained step' });
  const quota = store.insertQuota({ kind: '官方', platform: 'Legacy quota', balance: '12 credits' });
  const active = store.insertSubscription({ service: 'Legacy AI', account: 'fixture@example.test', expiresAt: '2027-01-01' });
  const deleted = store.insertSubscription({ service: 'Legacy deleted AI' });
  store.deleteEntity('subscription', deleted.id, { version: deleted.version });
  const directory = store.root;
  const dbPath = store.dbPath;
  close(store);
  const db = new DatabaseSync(dbPath);
  try {
    if (version === 1) db.exec('DROP TABLE subscriptions; DROP TABLE api_quotas;');
    else db.exec('ALTER TABLE subscriptions DROP COLUMN category; ALTER TABLE subscriptions DROP COLUMN auto_renew;');
    db.prepare("UPDATE settings SET value=? WHERE key='schema_version'").run(String(version));
    return { directory, dbPath, task, quota, active, deleted, subscriptions: version === 2 ? rawRows(db, 'subscriptions') : [], tasks: rawRows(db, 'tasks'), quotas: version === 2 ? rawRows(db, 'api_quotas') : [] };
  } finally { db.close(); }
}
function backupBytes(dbPath, version) {
  const data = new Uint8Array(fs.readFileSync(dbPath));
  const manifest = {
    format: version === 1 ? 'daily-affairs-backup' : 'folio-backup', schemaVersion: version,
    files: { 'data.sqlite': crypto.createHash('sha256').update(data).digest('hex') },
  };
  return zipSync({ 'data.sqlite': data, 'manifest.json': strToU8(JSON.stringify(manifest)) });
}
after(() => {
  for (const store of stores) { try { store.close(); } catch {} }
  const resolved = path.resolve(scratch);
  assert.ok(resolved.startsWith(cache + path.sep));
  fs.rmSync(resolved, { recursive: true, force: true });
});

test('new databases stay empty across startup and new subscriptions default to other/unrecorded', () => {
  let store = open();
  const directory = store.root;
  assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='schema_version'").get().value, '3');
  assert.deepEqual(store.state().subscriptions, []);
  assert.deepEqual(store.state().quotas, []);
  close(store);
  store = open(directory);
  assert.deepEqual(store.state().subscriptions, []);
  assert.deepEqual(store.state().quotas, []);
  const record = store.insertSubscription({ service: 'Manual service' });
  assert.equal(record.category, 'other');
  assert.equal(record.autoRenew, null);
  close(store);
  store = open(directory);
  assert.deepEqual(store.subscription(record.id), record);
  close(store);
});

test('version 2 migration preserves existing rows including recycle-bin metadata', () => {
  const fixture = legacyFixture(2);
  let store = open(fixture.directory);
  const migrated = rawRows(store.db, 'subscriptions');
  assert.deepEqual(migrated.map(({ category, auto_renew, ...row }) => row), fixture.subscriptions);
  assert.ok(migrated.every(row => row.category === 'ai' && row.auto_renew === null));
  assert.deepEqual(rawRows(store.db, 'tasks'), fixture.tasks);
  assert.deepEqual(rawRows(store.db, 'api_quotas'), fixture.quotas);
  assert.ok(store.subscription(fixture.deleted.id, true).deletedAt);
  const snapshot = store.state();
  close(store);
  store = open(fixture.directory);
  assert.deepEqual(store.state(), snapshot);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  close(store);
});

test('version 1 migration preserves tasks and creates empty service tables', () => {
  const fixture = legacyFixture(1);
  const store = open(fixture.directory);
  assert.deepEqual(rawRows(store.db, 'tasks'), fixture.tasks);
  assert.deepEqual(store.state().subscriptions, []);
  assert.deepEqual(store.state().quotas, []);
  assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='schema_version'").get().value, '3');
  close(store);
});

test('HTTP subscription fields preserve false, allow clearing, validate inputs, and survive recycling', async () => {
  const running = await startServer(root(), 0, { legacyAffairsDir: path.join(scratch, 'absent-legacy') });
  async function request(route, method = 'GET', body, expected = 200) {
    const response = await fetch('http://127.0.0.1:' + running.port + route, {
      method, headers: { 'Content-Type': 'application/json', 'X-Folio-App': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, expected);
    return response.status === 204 ? undefined : response.json();
  }
  try {
    let record = await request('/api/subscriptions', 'POST', { service: 'Network fixture', category: 'network', autoRenew: false, expiresAt: '2027-02-01' }, 201);
    const route = '/api/subscriptions/' + record.id;
    assert.equal(record.autoRenew, false);
    record = await request(route, 'PATCH', { plan: 'Ultra', version: record.version });
    assert.equal(record.category, 'network');
    assert.equal(record.autoRenew, false);
    record = await request(route, 'PATCH', { autoRenew: true, version: record.version });
    assert.equal(record.autoRenew, true);
    record = await request(route, 'PATCH', { autoRenew: null, category: 'ai', version: record.version });
    assert.equal(record.autoRenew, null);
    assert.equal(record.category, 'ai');
    const beforeInvalid = await request('/api/state');
    for (const fields of [{ category: 'invalid' }, { category: null }, { autoRenew: 0 }, { autoRenew: 'false' }]) {
      await request(route, 'PATCH', { ...fields, version: record.version }, 400);
      await request('/api/subscriptions', 'POST', { service: 'Invalid fixture', ...fields }, 400);
    }
    await request(route, 'PATCH', { category: 'network', version: record.version - 1 }, 409);
    assert.deepEqual(await request('/api/state'), beforeInvalid);
    record = await request(route, 'PATCH', { category: 'network', autoRenew: false, version: record.version });
    await request(route, 'DELETE', { version: record.version }, 204);
    const recycled = (await request('/api/state')).subscriptions.find(row => row.id === record.id);
    assert.ok(recycled.deletedAt);
    assert.equal(recycled.autoRenew, false);
    assert.equal(recycled.category, 'network');
    await request('/api/trash/subscription/' + record.id + '/restore', 'POST', {}, 204);
    const restored = (await request('/api/state')).subscriptions.find(row => row.id === record.id);
    assert.equal(restored.deletedAt, null);
    assert.equal(restored.autoRenew, false);
    assert.equal(restored.category, 'network');
  } finally {
    const closed = new Promise(resolve => running.server.once('close', resolve));
    running.close();
    await closed;
  }
});

test('all/AI/network/other filters exclude trash and preserve expiry order', () => {
  const store = open();
  store.insertSubscription({ service: 'Later AI', category: 'ai', expiresAt: '2027-03-01' });
  store.insertSubscription({ service: 'Network', category: 'network', expiresAt: '2027-02-01', autoRenew: false });
  store.insertSubscription({ service: 'Other' });
  const deleted = store.insertSubscription({ service: 'Trash', category: 'network', expiresAt: '2027-01-01' });
  store.deleteEntity('subscription', deleted.id, { version: deleted.version });
  const subscriptions = store.state().subscriptions;
  const services = filter => subscriptions.filter(item => matchesSubscriptionFilter(item, filter)).map(item => item.service);
  assert.deepEqual(services('all'), ['Network', 'Later AI', 'Other']);
  assert.deepEqual(services('ai'), ['Later AI']);
  assert.deepEqual(services('network'), ['Network']);
  assert.deepEqual(services('other'), ['Other']);
  close(store);
});

test('version 3 backups retain new fields, tasks and attachments; corrupt backups leave data unchanged', async () => {
  const source = open();
  source.insertSubscription({ service: 'Network', category: 'network', autoRenew: false });
  source.insertSubscription({ service: 'AI', category: 'ai', autoRenew: true });
  source.insertSubscription({ service: 'Other', autoRenew: null });
  const task = source.insertTask({ title: 'Attachment owner' });
  const file = source.insertFile('proof.txt', Buffer.from('retained attachment'), 'task', task.id);
  const backup = await source.createBackup();
  const bytes = new Uint8Array(fs.readFileSync(source.backupPath(backup.id)));
  const entries = unzipSync(bytes);
  assert.equal(JSON.parse(strFromU8(entries['manifest.json'])).schemaVersion, 3);
  const target = open();
  await target.restoreBackup(bytes);
  assert.deepEqual(target.state(), source.state());
  assert.equal(fs.readFileSync(target.filePath(file.id).absolute, 'utf8'), 'retained attachment');
  const snapshot = target.state();
  entries['data.sqlite'][0] ^= 1;
  await assert.rejects(target.restoreBackup(zipSync(entries)), /校验失败/);
  assert.deepEqual(target.state(), snapshot);
  close(source);
  close(target);
});

test('legacy version 1 and 2 backups restore and migrate without changing original fields', async () => {
  const target = open();
  for (const version of [2, 1]) {
    const fixture = legacyFixture(version);
    await target.restoreBackup(backupBytes(fixture.dbPath, version));
    assert.equal(target.db.prepare("SELECT value FROM settings WHERE key='schema_version'").get().value, '3');
    assert.deepEqual(rawRows(target.db, 'tasks'), fixture.tasks);
    if (version === 2) {
      const migrated = rawRows(target.db, 'subscriptions');
      assert.deepEqual(migrated.map(({ category, auto_renew, ...row }) => row), fixture.subscriptions);
      assert.ok(migrated.every(row => row.category === 'ai' && row.auto_renew === null));
    } else assert.deepEqual(target.state().subscriptions, []);
  }
  close(target);
});

test('malformed version 3 service tables are rejected before replacing the current database', async () => {
  const target = open();
  target.insertSubscription({ service: 'Preserved', category: 'network', autoRenew: false });
  const snapshot = target.state();
  const malformed = open();
  const malformedPath = malformed.dbPath;
  malformed.db.exec('ALTER TABLE subscriptions DROP COLUMN auto_renew');
  close(malformed);
  await assert.rejects(target.restoreBackup(backupBytes(malformedPath, 3)), /备份恢复失败/);
  assert.deepEqual(target.state(), snapshot);
  close(target);
});

test('Markdown export includes categories and all renewal states while excluding trash', () => {
  const store = open();
  store.insertSubscription({ service: 'Network', category: 'network', autoRenew: false });
  store.insertSubscription({ service: 'AI', category: 'ai', autoRenew: true });
  store.insertSubscription({ service: 'Other' });
  const deleted = store.insertSubscription({ service: 'Hidden trash' });
  store.deleteEntity('subscription', deleted.id, { version: deleted.version });
  const result = store.exportMarkdown();
  const markdown = fs.readFileSync(path.join(store.root, result.directory, '服务与订阅.md'), 'utf8');
  assert.match(markdown, /\| 分类 \| 服务 \| 账号 \| 套餐 \| 权益 \| 状态 \| 费用 \| 到期 \| 续费 \| 备注 \|/);
  assert.match(markdown, /\| 网络 \| Network \|[^\r\n]*\| 关闭 \|/);
  assert.match(markdown, /\| AI \| AI \|[^\r\n]*\| 开启 \|/);
  assert.match(markdown, /\| 其他 \| Other \|[^\r\n]*\| 未记录 \|/);
  assert.ok(!markdown.includes('Hidden trash'));
  assert.ok(!markdown.includes('AI 订阅'));
  close(store);
});
