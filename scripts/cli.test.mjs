import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const cache = path.resolve('node_modules/.cache');
fs.mkdirSync(cache, { recursive: true });
const scratch = fs.mkdtempSync(path.join(cache, 'folio-cli-test-'));
const serverBundle = path.join(scratch, 'server.mjs');
const cliBundle = path.join(scratch, 'folio.cjs');
await build({
  stdin: { contents: "export { startServer } from './src/server/server.mjs';", resolveDir: process.cwd(), sourcefile: 'cli-test-entry.mjs' },
  outfile: serverBundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
});
await build({ entryPoints: ['src/cli/folio.ts'], outfile: cliBundle, bundle: true, platform: 'node', format: 'cjs', define: { __FOLIO_VERSION__: '"test"' }, logLevel: 'silent' });
const { startServer } = await import(pathToFileURL(serverBundle).href);
const dataDir = path.join(scratch, crypto.randomUUID());
let running;
before(async () => { running = await startServer(dataDir, 0, { legacyAffairsDir: path.join(scratch, 'absent-legacy') }); });
after(async () => {
  if (running) {
    const closed = new Promise(resolve => running.server.once('close', resolve));
    running.close();
    await closed;
  }
  const resolved = path.resolve(scratch);
  assert.ok(resolved.startsWith(cache + path.sep));
  fs.rmSync(resolved, { recursive: true, force: true });
});

// 必须异步运行：服务端就在本进程里。
function folio(args, { input, dir = dataDir } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliBundle, ...args], { env: { ...process.env, FOLIO_DATA_DIR: dir, FOLIO_NO_AUTOSTART: '1' } });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr, json: () => JSON.parse(stdout), error: () => JSON.parse(stderr) }));
    child.stdin.end(input ?? '');
  });
}

test('help lists commands and fields', async () => {
  const overview = await folio(['help']);
  assert.equal(overview.code, 0);
  assert.match(overview.stdout, /folio add <类型>/);
  const fields = await folio(['help', 'event']);
  assert.match(fields.stdout, /reminderMinutes/);
  assert.match(fields.stdout, /repeatDays/);
  assert.match((await folio(['add', '日程', '--help'])).stdout, /startTime/, 'Chinese kind aliases and --help work');
});

test('add, list, get, update, search, delete, restore and log round-trip through the running app', async () => {
  const note = '第一行 "引号"\n第二行：带中文和换行';
  const added = await folio(['add', 'event', '--json', '-'], { input: JSON.stringify({ title: '家教：初一数学', date: '2026-11-06', startTime: '19:00', endTime: '21:00', repeat: 'weekly', repeatDays: [5], reminderMinutes: 90, note }) });
  assert.equal(added.code, 0, added.stderr);
  const event = added.json();
  assert.equal(event.note, note);
  assert.equal(event.reminderMinutes, 90);

  const listed = (await folio(['list', 'event', '--from', '2026-11-06', '--to', '2026-11-20'])).json();
  assert.deepEqual(listed.map(row => row.occurrence), ['2026-11-06', '2026-11-13', '2026-11-20']);
  assert.equal((await folio(['list', 'event', '--all'])).json().length, 1);

  const short = event.id.slice(0, 8);
  assert.equal((await folio(['get', 'event', short])).json().id, event.id);
  const updated = (await folio(['update', 'event', short, '--location', '铁城村4栋', '--reminder-minutes', 'null'])).json();
  assert.equal(updated.location, '铁城村4栋');
  assert.equal(updated.reminderMinutes, null);
  assert.deepEqual((await folio(['skip', short, '--date', '2026-11-13'])).json().skippedDates, ['2026-11-13']);

  const task = (await folio(['add', 'task', '--title', '提交推免材料', '--date-text', '2026-11-10 17:00前', '--body-markdown', '- [ ] 打印\\n- [ ] 签字'])).json();
  assert.equal(task.bodyMarkdown, '- [ ] 打印\n- [ ] 签字');
  const sub = (await folio(['add', 'subscription', '--service', 'ChatGPT', '--category', 'ai', '--auto-renew', 'false', '--expires-at', '2026-12-01'])).json();
  assert.equal(sub.category, 'ai');
  assert.equal(sub.autoRenew, false);
  assert.equal((await folio(['list', 'subscription', '--category', 'AI'])).json().length, 1);
  assert.deepEqual((await folio(['search', '推免'])).json().map(row => row.type), ['task']);

  const removed = await folio(['delete', 'task', task.id.slice(0, 8)]);
  assert.deepEqual(removed.json(), { deleted: true, type: 'task', id: task.id });
  assert.equal((await folio(['list', 'task'])).json().length, 0);
  assert.equal((await folio(['list', 'task', '--deleted'])).json().length, 1);
  assert.equal((await folio(['restore', 'task', task.id])).json().deletedAt, null);

  const log = (await folio(['log', '--limit', '3'])).json();
  assert.deepEqual(log.map(row => [row.action, row.kind, row.source]), [['restore', 'task', 'cli'], ['delete', 'task', 'cli'], ['create', 'subscription', 'cli']]);
  assert.deepEqual((await folio(['log', '--kind', 'event'])).json().map(row => row.action), ['skip', 'update', 'create']);
  assert.deepEqual((await folio(['categories', 'quota'])).json().map(row => row.name), ['AI', '网络', '其他']);
});

test('errors go to stderr as JSON with exit code 1', async () => {
  const cases = [
    [['add', 'event', '--title', 'No date'], /日期不能为空/],
    [['add', 'event', '--title', 'x', '--date', '2026-11-06', '--color', 'red'], /没有字段「color」/],
    [['add', 'nothing'], /需要类型/],
    [['bogus'], /未知命令/],
    [['get', 'task', 'missing-id'], /不存在/],
    [['add', 'task', '--json', '{bad'], /JSON 解析失败/],
  ];
  for (const [args, pattern] of cases) {
    const result = await folio(args);
    assert.equal(result.code, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.error().error, pattern);
  }
  const offline = await folio(['today'], { dir: path.join(scratch, 'not-running') });
  assert.equal(offline.code, 1);
  assert.equal(offline.error().code, 'NOT_RUNNING');
});


test('logo sets an image from a file path, accepts id prefixes and --remove', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  const file = path.join(scratch, 'logo.png');
  fs.writeFileSync(file, png);
  const sub = (await folio(['add', 'subscription', '--service', 'Logo CLI'])).json();
  const set = await folio(['logo', 'subscription', sub.id.slice(0, 8), file]);
  assert.equal(set.code, 0, set.stderr);
  assert.match(set.json().logo, /^[0-9a-f]{64}\.png$/);
  assert.equal((await folio(['get', 'subscription', sub.id])).json().logo, set.json().logo);
  assert.match((await folio(['help', 'task'])).stdout, /folio logo task/);
  const missing = await folio(['logo', 'subscription', sub.id, path.join(scratch, 'absent.png')]);
  assert.equal(missing.error().code, 'FILE_NOT_FOUND');
  assert.equal((await folio(['logo', 'subscription', sub.id])).error().code, 'MISSING_FILE');
  const removed = await folio(['logo', 'subscription', sub.id, '--remove']);
  assert.equal(removed.json().logo, '');
  const log = (await folio(['log', '--kind', 'subscription', '--limit', '1'])).json()[0];
  assert.deepEqual([log.action, log.source, log.after.logo], ['update', 'cli', '']);
});
