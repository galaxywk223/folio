import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { build } from 'esbuild';
import { zipSync, strToU8, unzipSync, strFromU8 } from 'fflate';

const cache = path.resolve('node_modules/.cache');
fs.mkdirSync(cache, { recursive: true });
const scratch = fs.mkdtempSync(path.join(cache, 'folio-schedule-test-'));
const bundle = path.join(scratch, 'test-module.mjs');
await build({
  stdin: {
    contents: "export { Store } from './src/server/store.mjs'; export { startServer } from './src/server/server.mjs'; export * from './src/shared/schedule.ts';",
    resolveDir: process.cwd(), sourcefile: 'schedule-test-entry.mjs',
  },
  outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
});
const { Store, startServer, occurrencesBetween, upcomingOccurrences, occursOn, dueReminders, reminderAt, repeatLabel } = await import(pathToFileURL(bundle).href);
const stores = new Set();
const root = () => path.join(scratch, crypto.randomUUID());
function open(directory = root()) { const store = new Store(directory); stores.add(store); return store; }
function close(store) { store.close(); stores.delete(store); }
const schemaVersion = store => store.db.prepare("SELECT value FROM settings WHERE key='schema_version'").get().value;
after(() => {
  for (const store of stores) { try { store.close(); } catch {} }
  const resolved = path.resolve(scratch);
  assert.ok(resolved.startsWith(cache + path.sep));
  fs.rmSync(resolved, { recursive: true, force: true });
});
const base = { id: 'e', title: 'E', date: '2026-11-06', startTime: '', endTime: '', location: '', note: '', repeat: 'none', repeatDays: [], repeatUntil: '', skippedDates: [], reminderMinutes: null, deletedAt: null };
const ev = extra => ({ ...base, ...extra });
const dates = (events, from, to) => occurrencesBetween(events, from, to).map(item => item.date);

test('repeat rules expand occurrences in range', () => {
  // 2026-11-06 是周五。
  assert.deepEqual(dates([ev({})], '2026-11-01', '2026-11-30'), ['2026-11-06']);
  assert.deepEqual(dates([ev({ repeat: 'daily', repeatUntil: '2026-11-08' })], '2026-11-01', '2026-11-30'), ['2026-11-06', '2026-11-07', '2026-11-08']);
  assert.deepEqual(dates([ev({ repeat: 'weekly' })], '2026-11-01', '2026-11-20'), ['2026-11-06', '2026-11-13', '2026-11-20']);
  assert.deepEqual(dates([ev({ repeat: 'weekly', repeatDays: [5, 6] })], '2026-11-06', '2026-11-14'), ['2026-11-06', '2026-11-07', '2026-11-13', '2026-11-14']);
  assert.deepEqual(dates([ev({ repeat: 'weekly', repeatDays: [5, 6], skippedDates: ['2026-11-07'] })], '2026-11-06', '2026-11-14'), ['2026-11-06', '2026-11-13', '2026-11-14']);
  assert.deepEqual(dates([ev({ repeat: 'daily', deletedAt: '2026-11-06T00:00:00Z' })], '2026-11-06', '2026-11-10'), []);
  assert.equal(occursOn(ev({ repeat: 'weekly' }), '2026-11-05'), false, 'before the first date');
  assert.equal(repeatLabel(ev({ repeat: 'weekly', repeatDays: [0, 5] })), '每周五、周日');
});

test('upcoming occurrences list every future one-off event but only a window of repeats', () => {
  const from = '2026-11-12';
  const upcoming = events => upcomingOccurrences(events, from).map(item => item.event.id + '@' + item.date);
  assert.deepEqual(upcoming([ev({ id: 'exam', date: '2026-12-13' })]), ['exam@2026-12-13'], 'beyond the 14-day window');
  assert.deepEqual(upcoming([ev({ id: 'far', date: '2027-08-01' })]), ['far@2027-08-01'], 'even months away');
  assert.deepEqual(upcoming([ev({ id: 'past', date: '2026-11-11' })]), [], 'past one-off events are not upcoming');
  assert.deepEqual(upcoming([ev({ id: 'today', date: '2026-11-12' })]), ['today@2026-11-12']);
  assert.equal(upcomingOccurrences([ev({ repeat: 'daily', date: '2026-11-01' })], from).length, 14, 'daily repeats expand 14 days');
  assert.deepEqual(upcoming([ev({ id: 'w', repeat: 'weekly', date: '2026-12-04' })]), ['w@2026-12-04'], 'repeat starting later shows its first occurrence');
  assert.deepEqual(upcoming([ev({ id: 'ended', repeat: 'weekly', date: '2026-10-01', repeatUntil: '2026-10-31' })]), []);
  assert.deepEqual(upcoming([ev({ id: 'gone', date: '2026-12-13', deletedAt: '2026-11-12T00:00:00Z' })]), []);
  assert.deepEqual(upcoming([ev({ id: 'b', date: '2026-12-13', startTime: '10:00' }), ev({ id: 'a', date: '2026-11-13' })]), ['a@2026-11-13', 'b@2026-12-13'], 'sorted by date');
});

test('occurrences sort all-day first, then by start time', () => {
  const list = occurrencesBetween([ev({ id: 'b', title: 'B', startTime: '19:00' }), ev({ id: 'a', title: 'A' }), ev({ id: 'c', title: 'C', startTime: '08:00' })], '2026-11-06', '2026-11-06');
  assert.deepEqual(list.map(item => item.event.id), ['a', 'c', 'b']);
});

test('reminder times handle lead minutes, midnight crossing and window boundaries', () => {
  const tutoring = ev({ startTime: '19:00', reminderMinutes: 90 });
  assert.equal(reminderAt(tutoring, '2026-11-06').getHours(), 17);
  assert.equal(reminderAt(tutoring, '2026-11-06').getMinutes(), 30);
  const early = ev({ date: '2026-11-07', startTime: '00:30', reminderMinutes: 60 });
  const at = reminderAt(early, '2026-11-07');
  assert.equal(at.getDate(), 6);
  assert.equal(at.getHours(), 23);
  assert.equal(dueReminders([early], new Date(2026, 10, 6, 23, 0), new Date(2026, 10, 6, 23, 30)).length, 1, 'previous-day reminder is found');
  const local = (h, m) => new Date(2026, 10, 6, h, m);
  assert.equal(dueReminders([tutoring], local(17, 0), local(17, 30)).length, 1, 'end is inclusive');
  assert.equal(dueReminders([tutoring], local(17, 30), local(18, 0)).length, 0, 'start is exclusive');
  assert.equal(dueReminders([ev({ startTime: '19:00' })], local(0, 0), local(23, 59)).length, 0, 'no reminder configured');
});

test('events validate input, default fields and keep omitted values on update', () => {
  const store = open();
  assert.equal(schemaVersion(store), '10');
  const created = store.insertEvent({ title: ' 家教 ', date: '2026-11-06', startTime: '9:05', endTime: '21:00', repeat: 'weekly', repeatDays: '5,6', reminderMinutes: '90' });
  assert.equal(created.title, '家教');
  assert.equal(created.startTime, '09:05');
  assert.deepEqual(created.repeatDays, [5, 6]);
  assert.equal(created.reminderMinutes, 90);
  for (const [input, pattern] of [
    [{ title: '', date: '2026-11-06' }, /标题不能为空/],
    [{ title: 'x' }, /日期不能为空/],
    [{ title: 'x', date: '2026-02-30' }, /日期不存在/],
    [{ title: 'x', date: '2026-11-06', endTime: '10:00' }, /先填写开始时间/],
    [{ title: 'x', date: '2026-11-06', startTime: '10:00', endTime: '09:00' }, /晚于开始时间/],
    [{ title: 'x', date: '2026-11-06', reminderMinutes: 30 }, /需要先填写开始时间/],
    [{ title: 'x', date: '2026-11-06', startTime: '10:00', reminderMinutes: 45 }, /提醒应为/],
    [{ title: 'x', date: '2026-11-06', repeat: 'weekly', repeatDays: [7] }, /重复星期/],
    [{ title: 'x', date: '2026-11-06', repeat: 'monthly' }, /重复应为/],
    [{ title: 'x', date: '2026-11-06', repeat: 'daily', repeatUntil: '2026-11-01' }, /不能早于日期/],
  ]) assert.throws(() => store.insertEvent(input), pattern);
  const updated = store.updateEvent(created.id, { location: '铁城村4栋' });
  assert.equal(updated.location, '铁城村4栋');
  assert.equal(updated.startTime, '09:05');
  assert.deepEqual(updated.repeatDays, [5, 6]);
  assert.equal(updated.version, created.version + 1);
  assert.throws(() => store.updateEvent(created.id, { title: 'stale', version: created.version }), /其他窗口更新/);
  const once = store.updateEvent(created.id, { repeat: 'none' });
  assert.deepEqual(once.repeatDays, []);
  close(store);
});

test('skipping one occurrence, deleting and restoring events', () => {
  const store = open();
  const weekly = store.insertEvent({ title: 'Weekly', date: '2026-11-06', repeat: 'weekly' });
  assert.throws(() => store.skipEventOccurrence(weekly.id, { date: '2026-11-07' }), /这天没有这个日程/);
  const skipped = store.skipEventOccurrence(weekly.id, { date: '2026-11-13' });
  assert.deepEqual(skipped.skippedDates, ['2026-11-13']);
  assert.deepEqual(dates(store.state().events, '2026-11-06', '2026-11-20'), ['2026-11-06', '2026-11-20']);
  const single = store.insertEvent({ title: 'Once', date: '2026-11-06' });
  assert.throws(() => store.skipEventOccurrence(single.id, { date: '2026-11-06' }), /只有重复日程/);
  store.deleteEntity('event', single.id, { version: single.version });
  assert.throws(() => store.event(single.id), /已移入回收站/);
  store.restoreEntity('event', single.id);
  assert.equal(store.event(single.id).deletedAt, null);
  close(store);
});

test('AI-friendly writes: optional version, category names, short ids and activity log', () => {
  const store = open();
  const sub = store.as('cli', () => store.insertSubscription({ service: 'Cloud', category: '云服务' }));
  assert.equal(sub.category, 'development');
  assert.throws(() => store.insertSubscription({ service: 'X', category: '不存在' }), /可用分类：AI、云服务/);
  const quota = store.insertQuota({ platform: 'Q', category: 'ai' });
  const short = quota.id.slice(0, 8);
  assert.equal(store.updateQuota(short, { balance: '5' }).balance, '5', 'unique prefix and no version');
  assert.throws(() => store.updateQuota(short, { balance: '6', version: 1 }), /其他窗口更新/, 'a wrong version still conflicts');
  assert.throws(() => store.quota(quota.id.slice(0, 5)), /不存在/, 'prefixes shorter than 6 are not resolved');
  const task = store.as('cli', () => store.insertTask({ title: 'T' }));
  store.as('cli', () => store.updateTask(task.id, { title: 'T2' }));
  store.as('cli', () => store.deleteEntity('task', task.id));
  store.restoreEntity('task', task.id);
  const log = store.activity({ limit: 10 });
  assert.deepEqual(log.slice(0, 4).map(row => [row.action, row.kind, row.source]), [
    ['restore', 'task', 'app'], ['delete', 'task', 'cli'], ['update', 'task', 'cli'], ['create', 'task', 'cli'],
  ]);
  assert.equal(log[2].before.title, 'T');
  assert.equal(log[2].after.title, 'T2');
  assert.equal(log.at(-1).source, 'cli', 'first write is the subscription created from the command line');
  assert.deepEqual(store.activity({ kind: 'quota' }).map(row => row.action), ['update', 'create']);
  assert.throws(() => store.activity({ kind: 'bogus' }), /类型应为/);
  const before = store.revision();
  store.insertTask({ title: 'Another' });
  assert.notEqual(store.revision(), before);
  close(store);
});

test('ambiguous short ids are rejected with candidates', () => {
  const store = open();
  const a = store.insertTask({ title: 'A' });
  const b = store.insertTask({ title: 'B' });
  store.db.prepare('UPDATE tasks SET id=? WHERE id=?').run('abcdef-1', a.id);
  store.db.prepare('UPDATE tasks SET id=? WHERE id=?').run('abcdef-2', b.id);
  assert.throws(() => store.task('abcdef'), /匹配到多条事项/);
  assert.equal(store.task('abcdef-2').title, 'B');
  close(store);
});

test('version 8 databases upgrade to 10 with data intact and empty event tables', () => {
  const store = open();
  const task = store.insertTask({ title: 'Kept' });
  const { root: directory, dbPath } = store;
  close(store);
  const db = new DatabaseSync(dbPath);
  db.exec("DROP TABLE events; DROP TABLE activity_log; UPDATE settings SET value='8' WHERE key='schema_version';");
  db.close();
  const upgraded = open(directory);
  assert.equal(schemaVersion(upgraded), '10');
  assert.deepEqual(upgraded.state().events, []);
  assert.equal(upgraded.task(task.id).title, 'Kept');
  assert.deepEqual(upgraded.activity(), []);
  close(upgraded);
});

function backupBytes(dbPath, version) {
  const data = new Uint8Array(fs.readFileSync(dbPath));
  const manifest = { format: 'folio-backup', schemaVersion: version, files: { 'data.sqlite': crypto.createHash('sha256').update(data).digest('hex') } };
  return zipSync({ 'data.sqlite': data, 'manifest.json': strToU8(JSON.stringify(manifest)) });
}

test('backups keep events and the activity log; version 8 backups restore with no events', async () => {
  const source = open();
  const event = source.insertEvent({ title: 'Backed up', date: '2026-11-06', startTime: '19:00', reminderMinutes: 30, repeat: 'weekly', repeatDays: [5] });
  const saved = await source.createBackup();
  const target = open();
  target.insertEvent({ title: 'Replaced', date: '2026-11-06' });
  await target.restoreBackup(fs.readFileSync(source.backupPath(saved.id)));
  assert.deepEqual(target.state().events, source.state().events);
  assert.equal(target.event(event.id).reminderMinutes, 30);
  assert.ok(target.activity().some(row => row.itemId === event.id && row.action === 'create'));

  const legacy = open();
  legacy.insertTask({ title: 'From v8' });
  const legacyPath = legacy.dbPath;
  close(legacy);
  const db = new DatabaseSync(legacyPath);
  db.exec("DROP TABLE events; DROP TABLE activity_log; UPDATE settings SET value='8' WHERE key='schema_version';");
  db.close();
  await target.restoreBackup(backupBytes(legacyPath, 8));
  assert.equal(schemaVersion(target), '10');
  assert.deepEqual(target.state().events, []);
  assert.equal(target.state().tasks[0].title, 'From v8');
  const after = target.insertEvent({ title: 'New after restore', date: '2026-11-07' });
  assert.equal(after.title, 'New after restore');

  const bad = open();
  bad.insertEvent({ title: 'Bad', date: '2026-11-06' });
  const badPath = bad.dbPath;
  close(bad);
  const raw = new DatabaseSync(badPath);
  raw.exec('PRAGMA ignore_check_constraints=ON');
  raw.exec("UPDATE events SET repeat_rule='monthly'");
  raw.close();
  const snapshot = target.state();
  await assert.rejects(target.restoreBackup(backupBytes(badPath, 10)), /备份日程字段校验失败/);
  assert.deepEqual(target.state(), snapshot);
  close(target);
});

test('Markdown export includes the schedule', () => {
  const store = open();
  store.insertEvent({ title: '家教 | 数学', date: '2026-11-06', startTime: '19:00', endTime: '21:00', location: '铁城村4栋', repeat: 'weekly', reminderMinutes: 90 });
  const result = store.exportMarkdown();
  const entries = unzipSync(fs.readFileSync(path.join(store.root, result.directory, 'Folio导出.zip')));
  const text = strFromU8(entries['日程.md']);
  assert.match(text, /\| 2026-11-06 \| 19:00–21:00 \| 家教 \\\| 数学 \| 铁城村4栋 \| 每周五 \| 提前 1\.5 小时 \| — \|/);
  assert.ok(store.exportPath(result.id, '日程.md'));
  close(store);
});

test('HTTP: events routes, source header, revision and activity', async () => {
  const running = await startServer(root(), 0, { legacyAffairsDir: path.join(scratch, 'absent-legacy') });
  const call = async (route, method = 'GET', body, headers = {}) => {
    const response = await fetch('http://127.0.0.1:' + running.port + route, {
      method, headers: { 'Content-Type': 'application/json', 'X-Folio-App': '1', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: response.status === 204 ? undefined : await response.json() };
  };
  try {
    const { revision: first } = (await call('/api/revision')).body;
    const created = await call('/api/events', 'POST', { title: 'HTTP', date: '2026-11-06', repeat: 'daily' }, { 'X-Folio-Source': 'cli' });
    assert.equal(created.status, 201);
    assert.notEqual((await call('/api/revision')).body.revision, first);
    const id = created.body.id;
    assert.equal((await call('/api/events/' + id.slice(0, 8), 'PATCH', { location: 'Lab' })).body.location, 'Lab');
    assert.deepEqual((await call('/api/events/' + id + '/skip', 'POST', { date: '2026-11-07' })).body.skippedDates, ['2026-11-07']);
    assert.equal((await call('/api/events/' + id, 'PATCH', { title: '' })).status, 400);
    assert.equal((await call('/api/events/' + id, 'DELETE')).status, 204);
    assert.equal((await call('/api/trash/event/' + id + '/restore', 'POST')).status, 204);
    const log = (await call('/api/activity?limit=10')).body;
    assert.deepEqual(log.map(row => [row.action, row.source]), [['restore', 'app'], ['delete', 'app'], ['skip', 'app'], ['update', 'app'], ['create', 'cli']]);
  } finally {
    const closed = new Promise(resolve => running.server.once('close', resolve));
    running.close();
    await closed;
  }
});
