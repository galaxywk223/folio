import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { parseTasks, parseNotes, getSteps, toggleStep, compareTasks } from '../shared/markdown.js';
import { subscriptionCategories, isSubscriptionCategory, autoRenewLabel } from '../shared/subscriptions.js';

export class AppError extends Error {
  constructor(message, status = 400, code = 'INVALID_REQUEST') {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const now = () => new Date().toISOString();
const stamp = () => now().replace(/[:.]/g, '-') + '-' + crypto.randomUUID().slice(0, 8);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const taskColumns = 'id,title,date_text AS dateText,body_markdown AS bodyMarkdown,status,sort_order AS sortOrder,completed_at AS completedAt,created_at AS createdAt,updated_at AS updatedAt,deleted_at AS deletedAt,version';
const noteColumns = 'id,title,body_markdown AS bodyMarkdown,created_at AS createdAt,updated_at AS updatedAt,deleted_at AS deletedAt,version';
const fileColumns = 'id,filename,storage_path AS storagePath,size,created_at AS createdAt,deleted_at AS deletedAt';
const quotaColumns = 'id,kind,platform,entry_url AS entryUrl,balance,recorded_at AS recordedAt,note,created_at AS createdAt,updated_at AS updatedAt,deleted_at AS deletedAt,version';
const legacySubColumns = 'id,service,account,plan,benefits,status,cost,expires_at AS expiresAt,entry_url AS entryUrl,note,created_at AS createdAt,updated_at AS updatedAt,deleted_at AS deletedAt,version';
const subColumns = legacySubColumns + ',category,auto_renew AS autoRenew';

const SERVICE_TABLES = `
CREATE TABLE IF NOT EXISTS api_quotas(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('官方','中转')),
  platform TEXT NOT NULL,
  entry_url TEXT NOT NULL DEFAULT '',
  balance TEXT NOT NULL DEFAULT '',
  recorded_at TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS subscriptions(
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other' CHECK(category IN ('ai','network','other')),
  auto_renew INTEGER CHECK(auto_renew IN (0,1)),
  account TEXT NOT NULL DEFAULT '',
  plan TEXT NOT NULL DEFAULT '',
  benefits TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '',
  cost TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL DEFAULT '',
  entry_url TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
);`;

function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\0') || /^[\\/]/.test(value) || value.includes(':') || value.split(/[\\/]/).some(part => part === '..' || part === '.')) {
    throw new AppError('备份包含不安全的文件路径。');
  }
  return value.replaceAll('\\', '/');
}
function inside(root, relative) {
  const result = path.resolve(root, safeRelative(relative));
  if (!result.startsWith(path.resolve(root) + path.sep)) throw new AppError('文件路径超出管理目录。');
  return result;
}
function removeScratch(root, target) {
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(root) + path.sep)) throw new Error('临时目录清理目标不在数据目录内。');
  fs.rmSync(resolved, { recursive: true, force: true });
}
function walkFiles(root, prefix = '') {
  if (!fs.existsSync(root)) return [];
  const result = [];
  for (const entry of fs.readdirSync(prefix ? inside(root, prefix) : root, { withFileTypes: true })) {
    const relative = prefix ? prefix + '/' + entry.name : entry.name;
    if (entry.isSymbolicLink()) throw new AppError('附件目录包含符号链接，无法安全备份。');
    if (entry.isDirectory()) result.push(...walkFiles(root, relative));
    else if (entry.isFile()) result.push({ relative, absolute: inside(root, relative) });
  }
  return result;
}
function stringValue(value, field, limit = 5_000_000) {
  if (typeof value !== 'string' || value.length > limit) throw new AppError(field + '格式不正确或内容过长。');
  return value;
}
function validDate(value) {
  stringValue(value, '日期', 80);
  if (!value) return value;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?前?$/);
  if (!match || (match[2] && (Number(match[2]) > 23 || Number(match[3]) > 59))) throw new AppError('日期应为 YYYY-MM-DD，可添加时间或“前”。');
  const parsed = new Date(match[1] + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== match[1]) throw new AppError('日期不存在。');
  return value;
}
function optionalIsoDate(value, field) {
  const text = stringValue(value ?? '', field, 40).trim();
  if (!text) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new AppError(field + '应为 YYYY-MM-DD。');
  const parsed = new Date(text + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) throw new AppError(field + '日期不存在。');
  return text;
}
function compareSubscriptions(a, b) {
  const aExp = a.expiresAt || '9999-12-31';
  const bExp = b.expiresAt || '9999-12-31';
  return aExp.localeCompare(bExp) || a.service.localeCompare(b.service) || a.account.localeCompare(b.account);
}
function subscriptionCategory(value) {
  if (!isSubscriptionCategory(value)) throw new AppError('订阅分类应为「AI」「网络」或「其他」。');
  return value;
}
function autoRenewValue(value) {
  if (value !== null && typeof value !== 'boolean') throw new AppError('自动续费状态应为开启、关闭或未记录。');
  return value === null ? null : Number(value);
}
function readSubscription(row) {
  return { ...row, autoRenew: row.autoRenew === null ? null : row.autoRenew === 1 };
}

export class Store {
  constructor(root) {
    this.root = path.resolve(root);
    this.dataDir = path.join(this.root, 'app', 'data');
    this.attachmentDir = path.join(this.root, '附件');
    this.backupDir = path.join(this.root, '备份');
    this.exportDir = path.join(this.root, '导出');
    this.dbPath = path.join(this.dataDir, 'folio.sqlite');
    for (const directory of [this.dataDir, this.attachmentDir]) fs.mkdirSync(directory, { recursive: true });
    this.migrateLegacyDbName();
    const existing = fs.existsSync(this.dbPath);
    this.openDatabase();
    if (existing) this.ensureSchema();
    else {
      this.db.exec(
        'CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);' +
        'CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,date_text TEXT NOT NULL,body_markdown TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN (\'pending\',\'completed\')),sort_order INTEGER NOT NULL,completed_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,version INTEGER NOT NULL DEFAULT 1);' +
        'CREATE TABLE notes(id TEXT PRIMARY KEY,title TEXT NOT NULL,body_markdown TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,version INTEGER NOT NULL DEFAULT 1);' +
        'CREATE TABLE attachments(id TEXT PRIMARY KEY,filename TEXT NOT NULL,storage_path TEXT UNIQUE NOT NULL,size INTEGER NOT NULL,created_at TEXT NOT NULL,deleted_at TEXT);' +
        'CREATE TABLE attachment_links(attachment_id TEXT NOT NULL REFERENCES attachments(id),owner_type TEXT NOT NULL CHECK(owner_type IN (\'task\',\'note\')),owner_id TEXT NOT NULL,PRIMARY KEY(attachment_id,owner_type,owner_id));' +
        SERVICE_TABLES +
        "INSERT INTO settings VALUES('schema_version','3');"
      );
    }
    if (!this.db.prepare("SELECT value FROM settings WHERE key='migration_complete'").get()) this.bootstrapSources();
  }
  migrateLegacyDbName() {
    const legacy = path.join(this.dataDir, 'daily-affairs.sqlite');
    if (!fs.existsSync(this.dbPath) && fs.existsSync(legacy)) fs.renameSync(legacy, this.dbPath);
  }
  ensureSchema() {
    const version = this.db.prepare("SELECT value FROM settings WHERE key='schema_version'").get();
    if (version?.value === '3') return;
    if (!['1', '2'].includes(version?.value)) throw new Error('数据库版本不受支持，原数据已保留。');
    this.transaction(() => {
      if (version.value === '1') this.db.exec(SERVICE_TABLES);
      else {
        this.db.exec("ALTER TABLE subscriptions ADD COLUMN category TEXT NOT NULL DEFAULT 'other' CHECK(category IN ('ai','network','other'));" +
          'ALTER TABLE subscriptions ADD COLUMN auto_renew INTEGER CHECK(auto_renew IN (0,1));' +
          "UPDATE subscriptions SET category='ai';");
      }
      this.db.prepare("UPDATE settings SET value='3' WHERE key='schema_version'").run();
    });
  }
  openDatabase() {
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;');
    const integrity = this.db.prepare('PRAGMA integrity_check').get();
    if (integrity.integrity_check !== 'ok') throw new Error('数据库完整性检查失败，原数据已保留。');
  }
  close() { this.db.close(); }
  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  bootstrapSources() {
    const taskPath = path.join(this.root, '待办.md');
    const notePath = path.join(this.root, '随手记.md');
    if (fs.existsSync(taskPath) && fs.existsSync(notePath)) this.importSources(taskPath, notePath);
    else this.db.prepare('INSERT INTO settings VALUES(?,?)').run('migration_complete', now());
  }
  importSources(taskPath, notePath) {
    const taskBytes = fs.readFileSync(taskPath);
    const noteBytes = fs.readFileSync(notePath);
    const tasks = parseTasks(taskBytes.toString('utf8'));
    const notes = parseNotes(noteBytes.toString('utf8'));
    if (!/^## 待处理\r?$/m.test(taskBytes.toString('utf8'))) throw new Error('待办文件结构无法识别，迁移已停止。');
    const files = walkFiles(this.attachmentDir);
    const snapshot = path.join(this.dataDir, '迁移快照', stamp());
    fs.mkdirSync(snapshot, { recursive: true });
    fs.writeFileSync(path.join(snapshot, '待办.md'), taskBytes, { flag: 'wx' });
    fs.writeFileSync(path.join(snapshot, '随手记.md'), noteBytes, { flag: 'wx' });
    const metadata = { tasks: tasks.length, steps: tasks.reduce((sum, task) => sum + getSteps(task.bodyMarkdown).length, 0), notes: notes.length, attachments: files.length, sourceHashes: { '待办.md': hash(taskBytes), '随手记.md': hash(noteBytes) } };
    fs.writeFileSync(path.join(snapshot, 'manifest.json'), JSON.stringify(metadata, null, 2), { flag: 'wx' });
    this.transaction(() => {
      tasks.forEach(task => this.insertTask(task));
      notes.forEach(note => this.insertNote(note));
      for (const file of files) {
        this.db.prepare('INSERT INTO attachments(id,filename,storage_path,size,created_at) VALUES(?,?,?,?,?)').run(crypto.randomUUID(), path.basename(file.relative), file.relative, fs.statSync(file.absolute).size, now());
      }
      this.db.prepare('INSERT INTO settings VALUES(?,?)').run('migration_complete', now());
      this.db.prepare('INSERT INTO settings VALUES(?,?)').run('migration_metadata', JSON.stringify(metadata));
    });
  }
  task(id, includeDeleted = false) {
    const task = this.db.prepare('SELECT ' + taskColumns + ' FROM tasks WHERE id=?' + (includeDeleted ? '' : ' AND deleted_at IS NULL')).get(id);
    if (!task) throw new AppError('事项不存在或已移入回收站。', 404, 'NOT_FOUND');
    return task;
  }
  note(id, includeDeleted = false) {
    const note = this.db.prepare('SELECT ' + noteColumns + ' FROM notes WHERE id=?' + (includeDeleted ? '' : ' AND deleted_at IS NULL')).get(id);
    if (!note) throw new AppError('记录不存在或已移入回收站。', 404, 'NOT_FOUND');
    return note;
  }
  file(id, includeDeleted = false) {
    const file = this.db.prepare('SELECT ' + fileColumns + ' FROM attachments WHERE id=?' + (includeDeleted ? '' : ' AND deleted_at IS NULL')).get(id);
    if (!file) throw new AppError('附件不存在或已移入回收站。', 404, 'NOT_FOUND');
    return file;
  }
  quota(id, includeDeleted = false) {
    const row = this.db.prepare('SELECT ' + quotaColumns + ' FROM api_quotas WHERE id=?' + (includeDeleted ? '' : ' AND deleted_at IS NULL')).get(id);
    if (!row) throw new AppError('额度记录不存在或已移入回收站。', 404, 'NOT_FOUND');
    return row;
  }
  subscription(id, includeDeleted = false) {
    const row = this.db.prepare('SELECT ' + subColumns + ' FROM subscriptions WHERE id=?' + (includeDeleted ? '' : ' AND deleted_at IS NULL')).get(id);
    if (!row) throw new AppError('订阅不存在或已移入回收站。', 404, 'NOT_FOUND');
    return readSubscription(row);
  }
  state() {
    return {
      tasks: this.db.prepare('SELECT ' + taskColumns + ' FROM tasks').all().sort(compareTasks),
      notes: this.db.prepare('SELECT ' + noteColumns + ' FROM notes ORDER BY updated_at DESC').all(),
      attachments: this.db.prepare('SELECT ' + fileColumns + ' FROM attachments ORDER BY created_at DESC').all(),
      links: this.db.prepare('SELECT attachment_id AS attachmentId,owner_type AS ownerType,owner_id AS ownerId FROM attachment_links').all(),
      quotas: this.db.prepare('SELECT ' + quotaColumns + ' FROM api_quotas ORDER BY platform COLLATE NOCASE').all(),
      subscriptions: this.db.prepare('SELECT ' + subColumns + ' FROM subscriptions').all().map(readSubscription).sort(compareSubscriptions),
      migration: (() => {
        const row = this.db.prepare("SELECT value FROM settings WHERE key='migration_metadata'").get();
        return row ? JSON.parse(row.value) : null;
      })(),
    };
  }
  checkVersion(record, version) {
    if (version !== record.version) throw new AppError('内容已在其他窗口更新。当前草稿仍保留，请重新载入后核对修改。', 409, 'VERSION_CONFLICT');
  }
  insertTask(input) {
    const title = stringValue(input.title, '标题', 500).trim();
    if (!title) throw new AppError('事项标题不能为空。');
    const dateText = validDate(input.dateText || '');
    const body = stringValue(input.bodyMarkdown ?? '', '正文');
    const id = crypto.randomUUID();
    const timestamp = now();
    const order = input.sortOrder ?? this.db.prepare('SELECT COALESCE(MAX(sort_order),-1)+1 AS next FROM tasks').get().next;
    const status = input.status === 'completed' ? 'completed' : 'pending';
    this.db.prepare('INSERT INTO tasks(id,title,date_text,body_markdown,status,sort_order,completed_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, title, dateText, body, status, order, status === 'completed' ? timestamp : null, timestamp, timestamp);
    return this.task(id);
  }
  updateTask(id, input) {
    const current = this.task(id);
    this.checkVersion(current, input.version);
    const title = stringValue(input.title ?? current.title, '标题', 500).trim();
    if (!title) throw new AppError('事项标题不能为空。');
    const dateText = validDate(input.dateText ?? current.dateText);
    const body = stringValue(input.bodyMarkdown ?? current.bodyMarkdown, '正文');
    const status = input.status ?? current.status;
    if (!['pending', 'completed'].includes(status)) throw new AppError('事项状态无效。');
    if (status === 'completed' && current.status !== 'completed' && getSteps(body).some(step => !step.checked) && input.confirmIncomplete !== true) {
      throw new AppError('事项仍有未完成步骤，需要确认后归档。', 409, 'INCOMPLETE_STEPS');
    }
    const completedAt = status === 'completed' ? current.completedAt || now() : null;
    this.db.prepare('UPDATE tasks SET title=?,date_text=?,body_markdown=?,status=?,completed_at=?,updated_at=?,version=version+1 WHERE id=?')
      .run(title, dateText, body, status, completedAt, now(), id);
    return this.task(id);
  }
  toggleTaskStep(id, input) {
    const current = this.task(id);
    this.checkVersion(current, input.version);
    if (!Number.isInteger(input.index) || typeof input.checked !== 'boolean') throw new AppError('检查步骤参数无效。');
    let body;
    try { body = toggleStep(current.bodyMarkdown, input.index, input.checked); }
    catch (error) { throw new AppError(error.message); }
    return this.updateTask(id, { version: input.version, bodyMarkdown: body });
  }
  insertNote(input) {
    const title = stringValue(input.title ?? '', '标题', 500).trim() || '无标题';
    const body = stringValue(input.bodyMarkdown ?? '', '正文');
    const id = crypto.randomUUID();
    const timestamp = now();
    this.db.prepare('INSERT INTO notes(id,title,body_markdown,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, title, body, timestamp, timestamp);
    return this.note(id);
  }
  updateNote(id, input) {
    const current = this.note(id);
    this.checkVersion(current, input.version);
    const title = stringValue(input.title ?? current.title, '标题', 500).trim() || '无标题';
    const body = stringValue(input.bodyMarkdown ?? current.bodyMarkdown, '正文');
    this.db.prepare('UPDATE notes SET title=?,body_markdown=?,updated_at=?,version=version+1 WHERE id=?').run(title, body, now(), id);
    return this.note(id);
  }
  insertQuota(input) {
    const kind = stringValue(input.kind ?? '官方', '类型', 20).trim();
    if (!['官方', '中转'].includes(kind)) throw new AppError('额度类型应为「官方」或「中转」。');
    const platform = stringValue(input.platform ?? '', '平台', 200).trim();
    if (!platform) throw new AppError('平台名称不能为空。');
    const entryUrl = stringValue(input.entryUrl ?? '', '入口', 2000).trim();
    const balance = stringValue(input.balance ?? '', '余额', 200).trim();
    const recordedAt = optionalIsoDate(input.recordedAt, '记录日期');
    const note = stringValue(input.note ?? '', '备注', 5000);
    const id = crypto.randomUUID();
    const timestamp = now();
    this.db.prepare('INSERT INTO api_quotas(id,kind,platform,entry_url,balance,recorded_at,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, kind, platform, entryUrl, balance, recordedAt, note, timestamp, timestamp);
    return this.quota(id);
  }
  updateQuota(id, input) {
    const current = this.quota(id);
    this.checkVersion(current, input.version);
    const kind = stringValue(input.kind ?? current.kind, '类型', 20).trim();
    if (!['官方', '中转'].includes(kind)) throw new AppError('额度类型应为「官方」或「中转」。');
    const platform = stringValue(input.platform ?? current.platform, '平台', 200).trim();
    if (!platform) throw new AppError('平台名称不能为空。');
    const entryUrl = stringValue(input.entryUrl ?? current.entryUrl, '入口', 2000).trim();
    const balance = stringValue(input.balance ?? current.balance, '余额', 200).trim();
    const recordedAt = optionalIsoDate(input.recordedAt ?? current.recordedAt, '记录日期');
    const note = stringValue(input.note ?? current.note, '备注', 5000);
    this.db.prepare('UPDATE api_quotas SET kind=?,platform=?,entry_url=?,balance=?,recorded_at=?,note=?,updated_at=?,version=version+1 WHERE id=?')
      .run(kind, platform, entryUrl, balance, recordedAt, note, now(), id);
    return this.quota(id);
  }
  insertSubscription(input) {
    const service = stringValue(input.service ?? '', '服务', 200).trim();
    if (!service) throw new AppError('服务名称不能为空。');
    const category = subscriptionCategory(input.category === undefined ? 'other' : input.category);
    const autoRenew = autoRenewValue(input.autoRenew === undefined ? null : input.autoRenew);
    const account = stringValue(input.account ?? '', '账号', 300).trim();
    const plan = stringValue(input.plan ?? '', '套餐', 300).trim();
    const benefits = stringValue(input.benefits ?? '', '权益', 2000).trim();
    const status = stringValue(input.status ?? '', '状态', 200).trim();
    const cost = stringValue(input.cost ?? '', '费用', 200).trim();
    const expiresAt = optionalIsoDate(input.expiresAt, '到期日');
    const entryUrl = stringValue(input.entryUrl ?? '', '入口', 2000).trim();
    const note = stringValue(input.note ?? '', '备注', 5000);
    const id = crypto.randomUUID();
    const timestamp = now();
    this.db.prepare('INSERT INTO subscriptions(id,service,category,auto_renew,account,plan,benefits,status,cost,expires_at,entry_url,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, service, category, autoRenew, account, plan, benefits, status, cost, expiresAt, entryUrl, note, timestamp, timestamp);
    return this.subscription(id);
  }
  updateSubscription(id, input) {
    const current = this.subscription(id);
    this.checkVersion(current, input.version);
    const category = subscriptionCategory(input.category === undefined ? current.category : input.category);
    const autoRenew = autoRenewValue(input.autoRenew === undefined ? current.autoRenew : input.autoRenew);
    const service = stringValue(input.service ?? current.service, '服务', 200).trim();
    if (!service) throw new AppError('服务名称不能为空。');
    const account = stringValue(input.account ?? current.account, '账号', 300).trim();
    const plan = stringValue(input.plan ?? current.plan, '套餐', 300).trim();
    const benefits = stringValue(input.benefits ?? current.benefits, '权益', 2000).trim();
    const status = stringValue(input.status ?? current.status, '状态', 200).trim();
    const cost = stringValue(input.cost ?? current.cost, '费用', 200).trim();
    const expiresAt = optionalIsoDate(input.expiresAt ?? current.expiresAt, '到期日');
    const entryUrl = stringValue(input.entryUrl ?? current.entryUrl, '入口', 2000).trim();
    const note = stringValue(input.note ?? current.note, '备注', 5000);
    this.db.prepare('UPDATE subscriptions SET service=?,category=?,auto_renew=?,account=?,plan=?,benefits=?,status=?,cost=?,expires_at=?,entry_url=?,note=?,updated_at=?,version=version+1 WHERE id=?')
      .run(service, category, autoRenew, account, plan, benefits, status, cost, expiresAt, entryUrl, note, now(), id);
    return this.subscription(id);
  }
  deleteEntity(type, id, input = {}) {
    const table = { task: 'tasks', note: 'notes', attachment: 'attachments', quota: 'api_quotas', subscription: 'subscriptions' }[type];
    if (!table) throw new AppError('对象类型无效。');
    const current = type === 'task' ? this.task(id)
      : type === 'note' ? this.note(id)
      : type === 'attachment' ? this.file(id)
      : type === 'quota' ? this.quota(id)
      : this.subscription(id);
    if (type !== 'attachment') this.checkVersion(current, input.version);
    const hasVersion = type !== 'attachment';
    this.db.prepare('UPDATE ' + table + ' SET deleted_at=?' + (hasVersion ? ',version=version+1,updated_at=?' : '') + ' WHERE id=?')
      .run(...(hasVersion ? [now(), now(), id] : [now(), id]));
  }
  restoreEntity(type, id) {
    const table = { task: 'tasks', note: 'notes', attachment: 'attachments', quota: 'api_quotas', subscription: 'subscriptions' }[type];
    if (!table) throw new AppError('对象类型无效。');
    const current = type === 'task' ? this.task(id, true)
      : type === 'note' ? this.note(id, true)
      : type === 'attachment' ? this.file(id, true)
      : type === 'quota' ? this.quota(id, true)
      : this.subscription(id, true);
    if (!current.deletedAt) throw new AppError('对象未在回收站中。');
    const hasVersion = type !== 'attachment';
    this.db.prepare('UPDATE ' + table + ' SET deleted_at=NULL' + (hasVersion ? ',version=version+1,updated_at=?' : '') + ' WHERE id=?')
      .run(...(hasVersion ? [now(), id] : [id]));
  }
  insertFile(filename, bytes, ownerType, ownerId) {
    const cleanName = path.basename(filename.replaceAll('\\', '/')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || '附件';
    if (ownerType || ownerId) this.validateOwner(ownerType, ownerId);
    const id = crypto.randomUUID();
    const relative = id + '/' + cleanName;
    const destination = inside(this.attachmentDir, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes, { flag: 'wx' });
    this.transaction(() => {
      this.db.prepare('INSERT INTO attachments(id,filename,storage_path,size,created_at) VALUES(?,?,?,?,?)').run(id, cleanName, relative, bytes.length, now());
      if (ownerType && ownerId) this.db.prepare('INSERT INTO attachment_links VALUES(?,?,?)').run(id, ownerType, ownerId);
    });
    return this.file(id);
  }
  validateOwner(type, id) {
    if (type === 'task') return this.task(id);
    if (type === 'note') return this.note(id);
    throw new AppError('附件关联类型无效。');
  }
  setLink(id, input, remove = false) {
    this.file(id);
    this.validateOwner(input.ownerType, input.ownerId);
    this.db.prepare(remove ? 'DELETE FROM attachment_links WHERE attachment_id=? AND owner_type=? AND owner_id=?' : 'INSERT OR IGNORE INTO attachment_links VALUES(?,?,?)')
      .run(id, input.ownerType, input.ownerId);
  }
  filePath(id) {
    const file = this.file(id);
    return { file, absolute: inside(this.attachmentDir, file.storagePath) };
  }
  async createBackup(label = '手动备份') {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const id = stamp();
    const scratch = path.join(this.dataDir, 'backup-' + id + '.sqlite');
    try {
      await backup(this.db, scratch);
      const entries = { 'data.sqlite': new Uint8Array(fs.readFileSync(scratch)) };
      for (const file of walkFiles(this.attachmentDir)) entries['attachments/' + file.relative] = new Uint8Array(fs.readFileSync(file.absolute));
      const manifest = { format: 'folio-backup', schemaVersion: 3, createdAt: now(), label, files: Object.fromEntries(Object.entries(entries).map(([name, bytes]) => [name, hash(bytes)])) };
      entries['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
      const filename = id + '.zip';
      const destination = path.join(this.backupDir, filename);
      fs.writeFileSync(destination, zipSync(entries, { level: 6 }), { flag: 'wx' });
      return { id: filename, filename, createdAt: manifest.createdAt, size: fs.statSync(destination).size, label };
    } finally { if (fs.existsSync(scratch)) fs.unlinkSync(scratch); }
  }
  listBackups() {
    if (!fs.existsSync(this.backupDir)) return [];
    return fs.readdirSync(this.backupDir).filter(name => /^[\w-]+\.zip$/.test(name)).sort().reverse().map(filename => {
      const stat = fs.statSync(path.join(this.backupDir, filename));
      return { id: filename, filename, createdAt: stat.mtime.toISOString(), size: stat.size };
    });
  }
  backupPath(id) {
    if (!/^[\w-]+\.zip$/.test(id)) throw new AppError('备份文件名无效。');
    const filename = inside(this.backupDir, id);
    if (!fs.existsSync(filename)) throw new AppError('备份不存在。', 404);
    return filename;
  }
  async restoreBackup(bytes) {
    if (this.restoring) throw new AppError('正在恢复另一份备份，请稍后重试。', 503, 'RESTORE_IN_PROGRESS');
    this.restoring = true;
    try { return await this.restoreValidatedBackup(bytes); }
    finally { this.restoring = false; }
  }
  async restoreValidatedBackup(bytes) {
    let entries, manifest;
    try { entries = unzipSync(bytes); manifest = JSON.parse(strFromU8(entries['manifest.json'])); }
    catch { throw new AppError('文件不是有效的完整备份。'); }
    const okFormat = (manifest.format === 'folio-backup' && [2, 3].includes(manifest.schemaVersion))
      || (manifest.format === 'daily-affairs-backup' && manifest.schemaVersion === 1);
    if (!okFormat || !manifest.files || !entries['data.sqlite']) throw new AppError('备份版本或结构不受支持。');
    for (const [name, checksum] of Object.entries(manifest.files)) {
      safeRelative(name);
      if (name !== 'data.sqlite' && !name.startsWith('attachments/')) throw new AppError('备份包含不支持的内容。');
      if (!entries[name] || hash(entries[name]) !== checksum) throw new AppError('备份校验失败，当前数据未改变。');
    }
    if (Object.keys(entries).some(name => name !== 'manifest.json' && !(name in manifest.files))) throw new AppError('备份包含未校验文件。');
    const scratch = path.join(this.dataDir, 'restore-' + crypto.randomUUID());
    fs.mkdirSync(scratch, { recursive: true });
    const candidatePath = path.join(scratch, 'candidate.sqlite');
    const candidateAttachments = path.join(scratch, 'attachments');
    fs.mkdirSync(candidateAttachments);
    let validationDb;
    try {
      fs.writeFileSync(candidatePath, entries['data.sqlite']);
      validationDb = new DatabaseSync(candidatePath, { readOnly: true });
      if (validationDb.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new AppError('备份数据库校验失败。');
      const schema = validationDb.prepare("SELECT value FROM settings WHERE key='schema_version'").get()?.value;
      if (!['1', '2', '3'].includes(schema) || Number(schema) !== manifest.schemaVersion) throw new AppError('备份数据库校验失败。');
      validationDb.prepare('SELECT ' + taskColumns + ' FROM tasks').all();
      validationDb.prepare('SELECT ' + noteColumns + ' FROM notes').all();
      validationDb.prepare('SELECT * FROM attachment_links').all();
      if (schema !== '1') {
        validationDb.prepare('SELECT ' + quotaColumns + ' FROM api_quotas').all();
        const subscriptions = validationDb.prepare('SELECT ' + (schema === '3' ? subColumns : legacySubColumns) + ' FROM subscriptions').all();
        if (schema === '3' && subscriptions.some(row => !isSubscriptionCategory(row.category) || ![null, 0, 1].includes(row.autoRenew))) {
          throw new AppError('备份订阅字段校验失败。');
        }
      }
      for (const file of validationDb.prepare('SELECT ' + fileColumns + ' FROM attachments').all()) {
        const relative = safeRelative(file.storagePath);
        if (!entries['attachments/' + relative] || entries['attachments/' + relative].length !== file.size) throw new AppError('备份缺少附件文件。');
      }
      validationDb.close();
      validationDb = null;
      for (const name of Object.keys(manifest.files).filter(name => name.startsWith('attachments/'))) {
        const destination = inside(candidateAttachments, name.slice('attachments/'.length));
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, entries[name], { flag: 'wx' });
      }
      const previousBackup = await this.createBackup('恢复前自动备份');
      this.db.close();
      const previousDb = path.join(scratch, 'previous.sqlite');
      const previousAttachments = path.join(scratch, 'previous-attachments');
      let dbMoved = false, filesMoved = false;
      try {
        fs.renameSync(this.dbPath, previousDb); dbMoved = true;
        fs.renameSync(this.attachmentDir, previousAttachments); filesMoved = true;
        fs.renameSync(candidatePath, this.dbPath);
        fs.renameSync(candidateAttachments, this.attachmentDir);
        this.openDatabase();
        this.ensureSchema();
      } catch (error) {
        try { this.db.close(); } catch {}
        if (dbMoved) {
          if (fs.existsSync(this.dbPath)) fs.renameSync(this.dbPath, path.join(scratch, 'failed.sqlite'));
          fs.renameSync(previousDb, this.dbPath);
        }
        if (filesMoved) {
          if (fs.existsSync(this.attachmentDir)) fs.renameSync(this.attachmentDir, path.join(scratch, 'failed-attachments'));
          fs.renameSync(previousAttachments, this.attachmentDir);
        }
        this.openDatabase();
        throw error;
      }
      return { previousBackup };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('备份恢复失败，当前数据已保留：' + error.message);
    } finally {
      if (validationDb) validationDb.close();
      removeScratch(this.dataDir, scratch);
    }
  }
  exportMarkdown() {
    const state = this.state();
    const files = state.attachments.filter(file => !file.deletedAt);
    const linkedSection = (type, id) => {
      const linked = files.filter(file => state.links.some(link => link.attachmentId === file.id && link.ownerType === type && link.ownerId === id));
      return linked.length ? '\n\n**附件**\n\n' + linked.map(file => '- [' + file.filename.replace(/[\[\]]/g, '_') + '](附件/' + file.storagePath.split('/').map(encodeURIComponent).join('/') + ')').join('\n') : '';
    };
    const taskBlock = task => '### ' + (task.dateText ? task.dateText + ' ' : '') + task.title + '\n\n' + task.bodyMarkdown + linkedSection('task', task.id);
    const pending = state.tasks.filter(task => !task.deletedAt && task.status === 'pending').map(taskBlock).join('\n\n');
    const completed = state.tasks.filter(task => !task.deletedAt && task.status === 'completed').map(taskBlock).join('\n\n');
    const notes = state.notes.filter(note => !note.deletedAt).map(note => '### ' + note.title + '\n\n' + note.bodyMarkdown + linkedSection('note', note.id)).join('\n\n');
    const quotas = state.quotas.filter(item => !item.deletedAt).map(item => `| ${item.kind} | ${item.platform} | ${item.entryUrl || '—'} | ${item.balance || '—'} | ${item.recordedAt || '—'} | ${item.note || '—'} |`).join('\n');
    const subscriptions = state.subscriptions.filter(item => !item.deletedAt).map(item => `| ${subscriptionCategories[item.category]} | ${item.service} | ${item.account || '—'} | ${item.plan || '—'} | ${item.benefits || '—'} | ${item.status || '—'} | ${item.cost || '—'} | ${item.expiresAt || '—'} | ${autoRenewLabel(item.autoRenew)} | ${item.note || '—'} |`).join('\n');
    const id = stamp();
    const directory = path.join(this.exportDir, id);
    fs.mkdirSync(directory, { recursive: true });
    const entries = {
      '待办.md': strToU8(('# 待办\n\n## 待处理\n\n' + pending + '\n\n## 已完成\n\n' + completed + '\n').replace(/\r?\n/g, '\r\n')),
      '随手记.md': strToU8(('# 随手记\n\n## 随手记录\n\n' + notes + '\n').replace(/\r?\n/g, '\r\n')),
      '服务与订阅.md': strToU8(('# 服务与订阅记录\n\n## API 额度\n\n| 类型 | 平台 | 入口 | 余额 | 记录 | 备注 |\n|---|---|---|---|---|---|\n' + (quotas || '| — | — | — | — | — | — |') + '\n\n## 订阅\n\n| 分类 | 服务 | 账号 | 套餐 | 权益 | 状态 | 费用 | 到期 | 续费 | 备注 |\n|---|---|---|---|---|---|---|---|---|---|\n' + (subscriptions || '| — | — | — | — | — | — | — | — | — | — |') + '\n').replace(/\r?\n/g, '\r\n')),
    };
    for (const file of files) entries['附件/' + file.storagePath] = new Uint8Array(fs.readFileSync(inside(this.attachmentDir, file.storagePath)));
    for (const [relative, bytes] of Object.entries(entries)) {
      const destination = inside(directory, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, bytes, { flag: 'wx' });
    }
    fs.writeFileSync(path.join(directory, 'Folio导出.zip'), zipSync(entries, { level: 6 }), { flag: 'wx' });
    return { id, directory: '导出/' + id, downloadUrl: '/api/exports/' + id + '/' + encodeURIComponent('Folio导出.zip') };
  }
  exportPath(id, filename) {
    if (!/^[\w-]+$/.test(id) || !['待办.md', '随手记.md', '服务与订阅.md', 'Folio导出.zip', '日常事务导出.zip'].includes(filename)) throw new AppError('导出文件路径无效。');
    const target = inside(this.exportDir, id + '/' + filename);
    if (!fs.existsSync(target)) throw new AppError('导出文件不存在。', 404);
    return target;
  }
}
