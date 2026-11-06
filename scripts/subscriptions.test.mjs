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
const { Store, startServer, matchesSubscriptionFilter, matchesServiceFilter } = await import(pathToFileURL(bundle).href);
const stores = new Set();
function root() { return path.join(scratch, crypto.randomUUID()); }
function open(directory = root()) {
  const store = new Store(directory);
  stores.add(store);
  return store;
}
function close(store) { store.close(); stores.delete(store); }
function rawRows(db, table) { return db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all().map(row => ({ ...row })); }
// 把额度表还原成 v7 之前的结构：固定 CHECK 分类、没有 quota_categories。
function downgradeQuotaTable(db) {
  const columns = 'id,kind,category,platform,account,entry_url,balance,recorded_at,note,created_at,updated_at,deleted_at,version';
  db.exec('DROP TABLE quota_categories; ALTER TABLE api_quotas RENAME TO api_quotas_v7;' +
    "CREATE TABLE api_quotas(id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind IN ('官方','中转')),category TEXT NOT NULL DEFAULT 'other' CHECK(category IN ('ai','network','other')),platform TEXT NOT NULL,account TEXT NOT NULL DEFAULT '',entry_url TEXT NOT NULL DEFAULT '',balance TEXT NOT NULL DEFAULT '',recorded_at TEXT NOT NULL DEFAULT '',note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,version INTEGER NOT NULL DEFAULT 1);" +
    'INSERT INTO api_quotas(' + columns + ') SELECT ' + columns + ' FROM api_quotas_v7; DROP TABLE api_quotas_v7;');
}
function withRawDb(dbPath, work) {
  const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
  try { return work(db); } finally { db.close(); }
}
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
  const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
  try {
    downgradeQuotaTable(db);
    if (version < 6) db.exec('DROP TABLE subscription_categories;');
    else db.exec('ALTER TABLE subscription_categories DROP COLUMN sort_order;');
    if (version === 1) db.exec('DROP TABLE subscriptions; DROP TABLE api_quotas;');
    else {
      if (version === 2) db.exec('ALTER TABLE subscriptions DROP COLUMN category; ALTER TABLE subscriptions DROP COLUMN auto_renew;');
      if (version < 4) db.exec('ALTER TABLE api_quotas DROP COLUMN category;');
      if (version < 5) db.exec('ALTER TABLE api_quotas DROP COLUMN account;');
    }
    db.prepare("UPDATE settings SET value=? WHERE key='schema_version'").run(String(version));
    return { directory, dbPath, task, quota, active, deleted, subscriptions: version === 1 ? [] : rawRows(db, 'subscriptions'), tasks: rawRows(db, 'tasks'), quotas: version === 1 ? [] : rawRows(db, 'api_quotas') };
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
  assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='schema_version'").get().value, '9');
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
  const quotas = rawRows(store.db, 'api_quotas');
  assert.deepEqual(quotas.map(({ category, account, ...row }) => row), fixture.quotas);
  assert.ok(quotas.every(row => row.category === 'ai' && row.account === ''));
  assert.ok(store.subscription(fixture.deleted.id, true).deletedAt);
  const snapshot = store.state();
  close(store);
  store = open(fixture.directory);
  assert.deepEqual(store.state(), snapshot);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  close(store);
});

test('version 3 migration adds quota categories as AI and keeps subscriptions unchanged', () => {
  const fixture = legacyFixture(3);
  let store = open(fixture.directory);
  assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='schema_version'").get().value, '9');
  assert.deepEqual(rawRows(store.db, 'subscriptions'), fixture.subscriptions);
  const quotas = rawRows(store.db, 'api_quotas');
  assert.deepEqual(quotas.map(({ category, account, ...row }) => row), fixture.quotas);
  assert.equal(store.quota(fixture.quota.id).category, 'ai');
  close(store);
  store = open(fixture.directory);
  assert.equal(store.quota(fixture.quota.id).category, 'ai');
  close(store);
});

test('quota categories default to other, validate input and filter like subscriptions', () => {
  const store = open();
  const created = store.insertQuota({ kind: '中转', platform: 'Relay' });
  assert.equal(created.category, 'other');
  const updated = store.updateQuota(created.id, { category: 'network', version: created.version });
  assert.equal(updated.category, 'network');
  assert.equal(updated.kind, '中转');
  const kept = store.updateQuota(created.id, { balance: '5', version: updated.version });
  assert.equal(kept.category, 'network');
  for (const category of ['invalid', null]) {
    assert.throws(() => store.insertQuota({ platform: 'Bad', category }), /额度分类/);
    assert.throws(() => store.updateQuota(created.id, { category, version: kept.version }), /额度分类/);
  }
  store.insertQuota({ platform: 'Official AI', category: 'ai' });
  const trashed = store.insertQuota({ platform: 'Trash AI', category: 'ai' });
  store.deleteEntity('quota', trashed.id, { version: trashed.version });
  const quotas = store.state().quotas;
  const platforms = filter => quotas.filter(item => matchesServiceFilter(item, filter)).map(item => item.platform).sort();
  assert.deepEqual(platforms('all'), ['Official AI', 'Relay']);
  assert.deepEqual(platforms('ai'), ['Official AI']);
  assert.deepEqual(platforms('network'), ['Relay']);
  assert.deepEqual(platforms('other'), []);
  close(store);
});

const EMAIL_A = 'alice@example.test';
const EMAIL_B = 'bob@example.test';
function v4QuotaFixture(notes) {
  const store = open();
  const quotas = notes.map((note, index) => store.insertQuota({ platform: 'Quota ' + index, category: 'network', note }));
  const trashed = quotas.at(-1);
  store.deleteEntity('quota', trashed.id, { version: trashed.version });
  const { root: directory, dbPath } = store;
  close(store);
  const db = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
  try {
    downgradeQuotaTable(db);
    db.exec('DROP TABLE subscription_categories; ALTER TABLE api_quotas DROP COLUMN account;');
    db.prepare("UPDATE settings SET value='4' WHERE key='schema_version'").run();
    return { directory, dbPath, quotas, rows: rawRows(db, 'api_quotas') };
  } finally { db.close(); }
}
const accountNotes = [
  '账号：' + EMAIL_A,
  '首行备注\n账号: ' + EMAIL_B + '\n末行备注',
  '账号：' + EMAIL_A + '\n账号：' + EMAIL_B,
  '账号：不是邮箱',
  '账号：' + EMAIL_A + ' 主力',
  '普通备注，没有账号',
  '',
  '账号：' + EMAIL_B,
];
function assertAccountMigration(rows, originals) {
  const byId = new Map(rows.map(row => [row.id, row]));
  const expected = [
    [EMAIL_A, ''],
    [EMAIL_B, '首行备注\n末行备注'],
    ['', accountNotes[2]],
    ['', accountNotes[3]],
    ['', accountNotes[4]],
    ['', accountNotes[5]],
    ['', ''],
    [EMAIL_B, ''],
  ];
  originals.forEach((original, index) => {
    const row = byId.get(original.id);
    assert.equal(row.account, expected[index][0], 'account ' + index);
    assert.equal(row.note, expected[index][1], 'note ' + index);
    const { account, note, ...rest } = row;
    const { account: _a, note: _n, ...before } = original;
    assert.deepEqual(rest, before, 'other columns ' + index);
  });
}

test('version 4 migration moves exactly one standalone account line out of quota notes', () => {
  const fixture = v4QuotaFixture(accountNotes);
  const store = open(fixture.directory);
  assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='schema_version'").get().value, '9');
  assertAccountMigration(rawRows(store.db, 'api_quotas'), fixture.rows);
  assert.ok(store.quota(fixture.quotas.at(-1).id, true).deletedAt, 'trashed quota stays in recycle bin');
  close(store);
});

test('quota account can be created, edited, kept when omitted, cleared, and survives recycling over HTTP', async () => {
  const running = await startServer(root(), 0, { legacyAffairsDir: path.join(scratch, 'absent-legacy-accounts') });
  async function request(route, method = 'GET', body, expected = 200) {
    const response = await fetch('http://127.0.0.1:' + running.port + route, {
      method, headers: { 'Content-Type': 'application/json', 'X-Folio-App': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, expected);
    return response.status === 204 ? undefined : response.json();
  }
  try {
    let record = await request('/api/quotas', 'POST', { platform: 'Account quota', account: '  ' + EMAIL_A + '  ' }, 201);
    assert.equal(record.account, EMAIL_A);
    assert.equal((await request('/api/quotas', 'POST', { platform: 'No account' }, 201)).account, '');
    const route = '/api/quotas/' + record.id;
    record = await request(route, 'PATCH', { account: EMAIL_B, version: record.version });
    assert.equal(record.account, EMAIL_B);
    record = await request(route, 'PATCH', { balance: '10', version: record.version });
    assert.equal(record.account, EMAIL_B);
    await request(route, 'PATCH', { account: 42, version: record.version }, 400);
    record = await request(route, 'PATCH', { account: EMAIL_A, version: record.version });
    await request(route, 'DELETE', { version: record.version }, 204);
    assert.equal((await request('/api/state')).quotas.find(row => row.id === record.id).account, EMAIL_A);
    await request('/api/trash/quota/' + record.id + '/restore', 'POST', {}, 204);
    record = (await request('/api/state')).quotas.find(row => row.id === record.id);
    assert.equal(record.deletedAt, null);
    assert.equal(record.account, EMAIL_A);
    record = await request(route, 'PATCH', { account: '', version: record.version });
    assert.equal(record.account, '');
  } finally {
    const closed = new Promise(resolve => running.server.once('close', resolve));
    running.close();
    await closed;
  }
});

test('version 4 backups migrate quota accounts on restore with the same rules', async () => {
  const fixture = v4QuotaFixture(accountNotes);
  const target = open();
  await target.restoreBackup(backupBytes(fixture.dbPath, 4));
  assert.equal(target.db.prepare("SELECT value FROM settings WHERE key='schema_version'").get().value, '9');
  assertAccountMigration(rawRows(target.db, 'api_quotas'), fixture.rows);
  close(target);
});

test('malformed version 5 quota tables without account are rejected', async () => {
  const target = open();
  target.insertQuota({ platform: 'Kept', account: EMAIL_A });
  const snapshot = target.state();
  const malformed = open();
  const malformedPath = malformed.dbPath;
  malformed.db.exec('ALTER TABLE api_quotas DROP COLUMN account');
  malformed.db.prepare("UPDATE settings SET value='5' WHERE key='schema_version'").run();
  close(malformed);
  await assert.rejects(target.restoreBackup(backupBytes(malformedPath, 5)), /备份恢复失败/);
  assert.deepEqual(target.state(), snapshot);
  close(target);
});

test('version 1 migration preserves tasks and creates empty service tables', () => {
  const fixture = legacyFixture(1);
  const store = open(fixture.directory);
  assert.deepEqual(rawRows(store.db, 'tasks'), fixture.tasks);
  assert.deepEqual(store.state().subscriptions, []);
  assert.deepEqual(store.state().quotas, []);
  assert.equal(store.db.prepare("SELECT value FROM settings WHERE key='schema_version'").get().value, '9');
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

test('current version backups retain service fields, tasks and attachments; corrupt backups leave data unchanged', async () => {
  const source = open();
  source.insertSubscription({ service: 'Network', category: 'network', autoRenew: false });
  source.insertSubscription({ service: 'AI', category: 'ai', autoRenew: true });
  source.insertSubscription({ service: 'Other', autoRenew: null });
  source.insertQuota({ platform: 'Network quota', category: 'network', account: EMAIL_A });
  const custom = source.saveQuotaCategory({ name: 'Cloud credits' });
  source.insertQuota({ platform: 'Custom quota', category: custom.id });
  const task = source.insertTask({ title: 'Attachment owner' });
  const file = source.insertFile('proof.txt', Buffer.from('retained attachment'), 'task', task.id);
  const backup = await source.createBackup();
  const bytes = new Uint8Array(fs.readFileSync(source.backupPath(backup.id)));
  const entries = unzipSync(bytes);
  assert.equal(JSON.parse(strFromU8(entries['manifest.json'])).schemaVersion, 9);
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

test('legacy version 1–6 backups restore and migrate without changing original fields', async () => {
  const target = open();
  for (const version of [6, 5, 4, 3, 2, 1]) {
    const fixture = legacyFixture(version);
    await target.restoreBackup(backupBytes(fixture.dbPath, version));
    assert.equal(target.db.prepare("SELECT value FROM settings WHERE key='schema_version'").get().value, '9');
    assert.deepEqual(rawRows(target.db, 'tasks'), fixture.tasks);
    if (version >= 3) {
      assert.deepEqual(rawRows(target.db, 'subscriptions'), fixture.subscriptions);
      assert.ok(target.state().quotas.every(row => row.category === (version === 3 ? 'ai' : 'other') && row.account === ''));
      assert.deepEqual(target.state().quotaCategories.map(row => row.name), ['AI', '网络', '其他']);
    } else if (version === 2) {
      const migrated = rawRows(target.db, 'subscriptions');
      assert.deepEqual(migrated.map(({ category, auto_renew, ...row }) => row), fixture.subscriptions);
      assert.ok(migrated.every(row => row.category === 'ai' && row.auto_renew === null));
    } else assert.deepEqual(target.state().subscriptions, []);
  }
  close(target);
});

test('malformed version 4 quota tables are rejected before replacing the current database', async () => {
  const target = open();
  target.insertQuota({ platform: 'Preserved quota', category: 'network' });
  const snapshot = target.state();
  const malformed = open();
  const malformedPath = malformed.dbPath;
  close(malformed);
  withRawDb(malformedPath, db => {
    downgradeQuotaTable(db);
    db.exec('ALTER TABLE api_quotas DROP COLUMN account; ALTER TABLE api_quotas DROP COLUMN category;');
    db.prepare("UPDATE settings SET value='4' WHERE key='schema_version'").run();
  });
  await assert.rejects(target.restoreBackup(backupBytes(malformedPath, 4)), /备份恢复失败/);
  assert.deepEqual(target.state(), snapshot);
  close(target);
});

test('malformed version 3 service tables are rejected before replacing the current database', async () => {
  const target = open();
  target.insertSubscription({ service: 'Preserved', category: 'network', autoRenew: false });
  const snapshot = target.state();
  const malformed = open();
  const malformedPath = malformed.dbPath;
  close(malformed);
  withRawDb(malformedPath, db => {
    downgradeQuotaTable(db);
    db.exec('ALTER TABLE subscriptions DROP COLUMN auto_renew; ALTER TABLE api_quotas DROP COLUMN account; ALTER TABLE api_quotas DROP COLUMN category;');
    db.prepare("UPDATE settings SET value='3' WHERE key='schema_version'").run();
  });
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
  store.insertQuota({ kind: '中转', platform: 'Relay quota', category: 'network', account: EMAIL_A, balance: '9' });
  const result = store.exportMarkdown();
  const markdown = fs.readFileSync(path.join(store.root, result.directory, '服务与订阅.md'), 'utf8');
  assert.match(markdown, /\| 分类 \| 服务 \| 账号 \| 套餐 \| 权益 \| 状态 \| 费用 \| 到期 \| 续费 \| 备注 \|/);
  assert.match(markdown, /\| 网络 \| Network \|[^\r\n]*\| 关闭 \|/);
  assert.match(markdown, /\| AI \| AI \|[^\r\n]*\| 开启 \|/);
  assert.match(markdown, /\| 其他 \| Other \|[^\r\n]*\| 未记录 \|/);
  assert.match(markdown, /## 额度\r?\n/);
  assert.match(markdown, /\| 分类 \| 类型 \| 平台 \| 账号 \| 入口 \| 余额 \| 记录 \| 备注 \|/);
  assert.match(markdown, /\| 网络 \| 中转 \| Relay quota \| alice@example\.test \|/);
  assert.ok(!markdown.includes('API 额度'));
  assert.ok(!markdown.includes('Hidden trash'));
  assert.ok(!markdown.includes('AI 订阅'));
  close(store);
});

test('subscription categories persist across rename, deletion and backup restoration', async () => {
  const store = open();
  assert.deepEqual(store.state().subscriptionCategories.map(row => row.name), ['AI', '云服务', '网络', '办公', '社交', '其他']);
  const category = store.saveSubscriptionCategory({ name: '  Projects  ' });
  assert.equal(category.name, 'Projects');
  assert.throws(() => store.saveSubscriptionCategory({ name: 'pROJECTS' }), /已存在/);
  assert.throws(() => store.saveSubscriptionCategory({ name: '  ' }), /不能为空/);
  assert.throws(() => store.saveSubscriptionCategory({ name: 'Default' }, 'other', false), /不能重命名/);
  assert.throws(() => store.deleteSubscriptionCategory('other', { count: 0 }), /不能删除/);
  const active = store.insertSubscription({ service: 'Active', category: category.id, account: 'test@example.test' });
  const trashed = store.insertSubscription({ service: 'Trashed', category: category.id });
  store.deleteEntity('subscription', trashed.id, { version: trashed.version });
  assert.throws(() => store.insertQuota({ platform: 'Invalid quota', category: category.id }), /额度分类/);
  assert.ok(matchesSubscriptionFilter(active, category.id));
  store.saveSubscriptionCategory({ name: 'Work | Tools' }, category.id, false);
  assert.equal(store.subscription(active.id).category, category.id);
  const exported = store.exportMarkdown();
  const markdown = fs.readFileSync(path.join(store.root, exported.directory, '服务与订阅.md'), 'utf8');
  assert.ok(markdown.includes('Work \\| Tools'));
  const saved = await store.createBackup();
  const target = open();
  await target.restoreBackup(fs.readFileSync(store.backupPath(saved.id)));
  assert.deepEqual(target.state().subscriptionCategories, store.state().subscriptionCategories);
  assert.throws(() => target.deleteSubscriptionCategory(category.id, { count: 1 }), /数量已变化/);
  target.deleteSubscriptionCategory(category.id, { count: 2 });
  assert.equal(target.subscription(active.id).category, 'other');
  assert.equal(target.subscription(active.id).account, active.account);
  assert.equal(target.subscription(active.id).version, active.version + 1);
  assert.ok(target.subscription(trashed.id, true).deletedAt);
  target.restoreEntity('subscription', trashed.id);
  assert.equal(target.subscription(trashed.id).category, 'other');
  assert.ok(!target.state().subscriptionCategories.some(row => row.id === category.id));
});

test('quota categories are managed separately and persist across rename, deletion and backup restoration', async () => {
  const store = open();
  assert.deepEqual(store.state().quotaCategories.map(row => row.name), ['AI', '网络', '其他']);
  const category = store.saveQuotaCategory({ name: '  Cloud  ' });
  assert.equal(category.name, 'Cloud');
  assert.throws(() => store.saveQuotaCategory({ name: 'cLOUD' }), /已存在/);
  assert.throws(() => store.saveQuotaCategory({ name: '  ' }), /不能为空/);
  assert.throws(() => store.saveQuotaCategory({ name: 'Default' }, 'other', false), /不能重命名/);
  assert.throws(() => store.deleteQuotaCategory('other', { count: 0 }), /不能删除/);
  assert.throws(() => store.saveQuotaCategory({ name: 'x' }, 'development', false), /额度分类不存在/);
  // 两套分类互不通用，订阅分类名可以和额度分类重名。
  assert.throws(() => store.insertSubscription({ service: 'Wrong scope', category: category.id }), /订阅分类/);
  store.saveSubscriptionCategory({ name: 'Cloud' });
  assert.deepEqual(store.state().subscriptionCategories.map(row => row.name).at(-2), 'Cloud');
  const active = store.insertQuota({ platform: 'Active', category: category.id, account: EMAIL_A });
  const trashed = store.insertQuota({ platform: 'Trashed', category: category.id });
  store.deleteEntity('quota', trashed.id, { version: trashed.version });
  assert.ok(matchesServiceFilter(active, category.id));
  store.saveQuotaCategory({ name: 'Cloud | Credits' }, category.id, false);
  assert.equal(store.quota(active.id).category, category.id);
  const exported = store.exportMarkdown();
  const markdown = fs.readFileSync(path.join(store.root, exported.directory, '服务与订阅.md'), 'utf8');
  assert.match(markdown, /\| Cloud \\\| Credits \| 官方 \| Active \| alice@example\.test \|/);
  const saved = await store.createBackup();
  const target = open();
  await target.restoreBackup(fs.readFileSync(store.backupPath(saved.id)));
  assert.deepEqual(target.state().quotaCategories, store.state().quotaCategories);
  assert.deepEqual(target.state().subscriptionCategories, store.state().subscriptionCategories);
  assert.throws(() => target.deleteQuotaCategory(category.id, { count: 1 }), /额度数量已变化/);
  target.deleteQuotaCategory(category.id, { count: 2 });
  assert.equal(target.quota(active.id).category, 'other');
  assert.equal(target.quota(active.id).account, EMAIL_A);
  assert.equal(target.quota(active.id).version, active.version + 1);
  assert.ok(target.quota(trashed.id, true).deletedAt);
  target.restoreEntity('quota', trashed.id);
  assert.equal(target.quota(trashed.id).category, 'other');
  assert.ok(!target.state().quotaCategories.some(row => row.id === category.id));
  assert.ok(target.state().subscriptionCategories.some(row => row.name === 'Cloud'));
  close(store);
  close(target);
});

test('version 6 databases migrate quota categories and accounts unchanged', () => {
  const store = open();
  const network = store.insertQuota({ kind: '中转', platform: 'Network', category: 'network', account: EMAIL_A, note: 'kept' });
  const ai = store.insertQuota({ platform: 'AI', category: 'ai' });
  store.deleteEntity('quota', ai.id, { version: ai.version });
  const { root: directory, dbPath } = store;
  close(store);
  const before = withRawDb(dbPath, db => {
    downgradeQuotaTable(db);
    db.exec('ALTER TABLE subscription_categories DROP COLUMN sort_order;');
    db.prepare("UPDATE settings SET value='6' WHERE key='schema_version'").run();
    return rawRows(db, 'api_quotas');
  });
  const migrated = open(directory);
  assert.equal(migrated.db.prepare("SELECT value FROM settings WHERE key='schema_version'").get().value, '9');
  assert.deepEqual(rawRows(migrated.db, 'api_quotas'), before);
  assert.deepEqual(migrated.state().quotaCategories.map(row => row.id), ['ai', 'network', 'other']);
  assert.equal(migrated.quota(network.id).account, EMAIL_A);
  assert.ok(migrated.quota(ai.id, true).deletedAt);
  assert.equal(migrated.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  close(migrated);
});

test('current version backups with unknown quota categories are rejected', async () => {
  const target = open();
  target.insertQuota({ platform: 'Kept', category: 'network' });
  const snapshot = target.state();
  const malformed = open();
  malformed.insertQuota({ platform: 'Bad' });
  const malformedPath = malformed.dbPath;
  close(malformed);
  withRawDb(malformedPath, db => db.exec("UPDATE api_quotas SET category='missing'"));
  await assert.rejects(target.restoreBackup(backupBytes(malformedPath, 9)), /额度字段校验失败/);
  const noOther = open();
  const noOtherPath = noOther.dbPath;
  close(noOther);
  withRawDb(noOtherPath, db => db.exec("DELETE FROM quota_categories WHERE id='other'"));
  await assert.rejects(target.restoreBackup(backupBytes(noOtherPath, 9)), /额度分类校验失败/);
  assert.deepEqual(target.state(), snapshot);
  close(target);
});

test('quota category HTTP routes create, rename and delete categories', async () => {
  const running = await startServer(root(), 0, { legacyAffairsDir: path.join(scratch, 'absent-legacy-quota-categories') });
  async function request(route, method = 'GET', body, expected = 200) {
    const response = await fetch('http://127.0.0.1:' + running.port + route, {
      method, headers: { 'Content-Type': 'application/json', 'X-Folio-App': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(response.status, expected);
    return response.status === 204 ? undefined : response.json();
  }
  try {
    const category = await request('/api/quota-categories', 'POST', { name: 'Credits' }, 201);
    await request('/api/quota-categories', 'POST', { name: 'credits' }, 409);
    const renamed = await request('/api/quota-categories/' + category.id, 'PATCH', { name: 'Prepaid' });
    assert.equal(renamed.name, 'Prepaid');
    const order = ['ai', 'network', category.id, 'other'];
    const moved = [category.id, 'ai', 'network', 'other'];
    const result = await request('/api/quota-categories/order', 'PATCH', { ids: moved, expectedIds: order });
    assert.deepEqual(result.map(row => row.id), moved);
    await request('/api/quota-categories/order', 'PATCH', { ids: order, expectedIds: order }, 409);
    for (const ids of [order.slice(1), ['ai', 'ai', category.id, 'other'],
      ['ai', 'development', category.id, 'other'], ['ai', 'network', 'other', category.id]]) {
      await request('/api/quota-categories/order', 'PATCH', { ids }, 400);
    }
    const subscriptions = ['office', 'ai', 'network', 'development', 'social', 'other'];
    const sorted = await request('/api/subscription-categories/order', 'PATCH', { ids: subscriptions });
    assert.deepEqual(sorted.map(row => row.id), subscriptions);
    await request('/api/quota-categories/order', 'PATCH', { ids: order, expectedIds: moved });
    const quota = await request('/api/quotas', 'POST', { platform: 'Prepaid quota', category: category.id }, 201);
    assert.equal(quota.category, category.id);
    await request('/api/quota-categories/' + category.id, 'DELETE', { count: 0 }, 409);
    await request('/api/quota-categories/' + category.id, 'DELETE', { count: 1 }, 204);
    const state = await request('/api/state');
    assert.equal(state.quotas.find(row => row.id === quota.id).category, 'other');
    assert.ok(!state.quotaCategories.some(row => row.id === category.id));
    assert.deepEqual(state.subscriptionCategories.map(row => row.id), subscriptions);
    assert.deepEqual(state.quotaCategories.map(row => row.id), ['ai', 'network', 'other']);
  } finally {
    const closed = new Promise(resolve => running.server.once('close', resolve));
    running.close();
    await closed;
  }
});

test('v7 restore preserves category membership and names, and v8 retains ordering after restart and restore', async () => {
  const source = open();
  const custom = source.saveQuotaCategory({ name: 'Prepaid' });
  const quota = source.insertQuota({ platform: 'Test', category: custom.id, account: EMAIL_A });
  const subscription = source.insertSubscription({ service: 'Cloud', category: 'development' });
  source.saveSubscriptionCategory({ name: 'Custom cloud' }, 'development', false);
  const { dbPath } = source;
  close(source);
  withRawDb(dbPath, db => db.exec(
    'ALTER TABLE quota_categories DROP COLUMN sort_order; ALTER TABLE subscription_categories DROP COLUMN sort_order;' +
    "UPDATE settings SET value='7' WHERE key='schema_version';"));
  const target = open();
  await target.restoreBackup(backupBytes(dbPath, 7));
  const idOrder = store => store.quotaCategories().map(row => row.id);
  assert.deepEqual(idOrder(target), ['ai', 'network', custom.id, 'other']);
  assert.equal(target.subscriptionCategories().find(row => row.id === 'development').name, 'Custom cloud');
  assert.deepEqual(target.quota(quota.id), quota);
  assert.deepEqual(target.subscription(subscription.id), subscription);
  const order = [custom.id, 'network', 'ai', 'other'];
  target.reorderCategories('quota', { ids: order });
  const added = target.saveQuotaCategory({ name: 'New' });
  assert.deepEqual(idOrder(target), [custom.id, 'network', 'ai', added.id, 'other']);
  target.deleteQuotaCategory(added.id, { count: 0 });
  const directory = target.root;
  close(target);
  const restarted = open(directory);
  assert.deepEqual(idOrder(restarted), order);
  const saved = await restarted.createBackup();
  const restored = open();
  await restored.restoreBackup(fs.readFileSync(restarted.backupPath(saved.id)));
  assert.deepEqual(restored.state(), restarted.state());
});
