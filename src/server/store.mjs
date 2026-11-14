import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { parseTasks, parseNotes, getSteps, toggleStep, compareTasks } from '../shared/markdown.js';
import { isServiceCategory, autoRenewLabel } from '../shared/subscriptions.js';
import { REPEATS, REMINDER_OPTIONS, occursOn, repeatLabel, reminderLabel, timeRange } from '../shared/schedule.js';

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
const legacyQuotaColumns = 'id,kind,platform,entry_url AS entryUrl,balance,recorded_at AS recordedAt,note,created_at AS createdAt,updated_at AS updatedAt,deleted_at AS deletedAt,version';
const v4QuotaColumns = legacyQuotaColumns + ',category';
const quotaColumns = v4QuotaColumns + ',account';
const SCHEMA_VERSION = 10;
const SCHEMA_VERSIONS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
const quotaColumnsBySchema = { '2': legacyQuotaColumns, '3': legacyQuotaColumns, '4': v4QuotaColumns, '5': quotaColumns, '6': quotaColumns, '7': quotaColumns, '8': quotaColumns, '9': quotaColumns, '10': quotaColumns + ',logo' };
const legacySubColumns = 'id,service,account,plan,benefits,status,cost,expires_at AS expiresAt,entry_url AS entryUrl,note,created_at AS createdAt,updated_at AS updatedAt,deleted_at AS deletedAt,version';
const subColumns = legacySubColumns + ',category,auto_renew AS autoRenew';
const eventColumns = 'id,title,date,start_time AS startTime,end_time AS endTime,location,note,repeat_rule AS repeat,repeat_days AS repeatDays,repeat_until AS repeatUntil,skipped_dates AS skippedDates,reminder_minutes AS reminderMinutes,created_at AS createdAt,updated_at AS updatedAt,deleted_at AS deletedAt,version';
const EVENT_TABLE = `CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL DEFAULT '',
  end_time TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  repeat_rule TEXT NOT NULL DEFAULT 'none' CHECK(repeat_rule IN ('none','daily','weekly')),
  repeat_days TEXT NOT NULL DEFAULT '',
  repeat_until TEXT NOT NULL DEFAULT '',
  skipped_dates TEXT NOT NULL DEFAULT '',
  reminder_minutes INTEGER CHECK(reminder_minutes IS NULL OR reminder_minutes IN (0,10,30,60,90,120)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
);`;
// 改动记录：每次新建、修改、删除、恢复都留一条，来源区分应用内和命令行。
const ACTIVITY_TABLE = `CREATE TABLE IF NOT EXISTS activity_log(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  source TEXT NOT NULL,
  action TEXT NOT NULL,
  kind TEXT NOT NULL,
  item_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  before_json TEXT,
  after_json TEXT
);`;
const ACTIVITY_LIMIT = 2000;
const activityColumns = 'id,at,source,action,kind,item_id AS itemId,title,before_json AS beforeJson,after_json AS afterJson';
const ENTITY_TABLES = { task: 'tasks', note: 'notes', attachment: 'attachments', quota: 'api_quotas', subscription: 'subscriptions', event: 'events' };
// 第 10 版起，待办、日程、额度、订阅都可以设置 logo；列里存「图标」目录下的文件名（内容哈希 + 扩展名）。
const LOGO_KINDS = { task: 'tasks', event: 'events', quota: 'api_quotas', subscription: 'subscriptions' };
const LOGO_MAX_BYTES = 1024 * 1024;
const LOGO_FILE = /^[0-9a-f]{64}\.(png|jpg|webp|svg|ico)$/;
const LOGO_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon' };
const withLogo = columns => columns + ',logo';
// 按文件头判断图片格式，不看扩展名。
function logoFormat(bytes) {
  const starts = (...values) => values.every((value, index) => bytes[index] === value);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png';
  if (starts(0xff, 0xd8, 0xff)) return 'jpg';
  if (bytes.length > 12 && starts(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'webp';
  if (starts(0x00, 0x00, 0x01, 0x00)) return 'ico';
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4096)).replace(/^\uFEFF/, '').trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!DOCTYPE svg[^>]*>\s*)?<svg[\s>]/i.test(head)) return 'svg';
  return null;
}
const ENTITY_LABELS = { task: '事项', note: '记录', attachment: '附件', quota: '额度记录', subscription: '订阅', event: '日程' };

const DEFAULT_SUBSCRIPTION_CATEGORIES = [
  ['ai', 'AI'], ['development', '云服务'], ['network', '网络'],
  ['office', '办公'], ['social', '社交'], ['other', '其他'],
];
const DEFAULT_QUOTA_CATEGORIES = [['ai', 'AI'], ['network', '网络'], ['other', '其他']];
const CATEGORY_POSITION = 'sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order >= 0)';
const CATEGORY_TABLE = 'CREATE TABLE subscription_categories(id TEXT PRIMARY KEY, name TEXT NOT NULL, ' + CATEGORY_POSITION + ');';
const QUOTA_CATEGORY_TABLE = 'CREATE TABLE quota_categories(id TEXT PRIMARY KEY, name TEXT NOT NULL, ' + CATEGORY_POSITION + ');';
// 订阅与额度各有一套可管理的分类。
const CATEGORY_SCOPES = {
  subscription: { table: 'subscription_categories', items: 'subscriptions', label: '订阅', defaults: DEFAULT_SUBSCRIPTION_CATEGORIES },
  quota: { table: 'quota_categories', items: 'api_quotas', label: '额度', defaults: DEFAULT_QUOTA_CATEGORIES },
};
const SUBSCRIPTION_TABLE = `
CREATE TABLE IF NOT EXISTS subscriptions(
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other' REFERENCES subscription_categories(id),
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
const QUOTA_TABLE = `CREATE TABLE IF NOT EXISTS api_quotas(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('官方','中转')),
  category TEXT NOT NULL DEFAULT 'other' REFERENCES quota_categories(id),
  platform TEXT NOT NULL,
  account TEXT NOT NULL DEFAULT '',
  entry_url TEXT NOT NULL DEFAULT '',
  balance TEXT NOT NULL DEFAULT '',
  recorded_at TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
`;
const SERVICE_TABLES = CATEGORY_TABLE + QUOTA_CATEGORY_TABLE + SUBSCRIPTION_TABLE + QUOTA_TABLE;

// 备份中的分类表：id、名称合法且不重复，并且包含「其他」。
function validCategories(rows, ordered) {
  const ids = new Set(rows.map(row => row.id));
  const valid = !rows.some(row => typeof row.id !== 'string' || !row.id || row.id === 'all' ||
      typeof row.name !== 'string' || !row.name || row.name.length > 80 || row.name !== row.name.trim()) &&
    new Set(rows.map(row => row.name.toLowerCase())).size === rows.length &&
    ids.size === rows.length && rows.some(row => row.id === 'other' && row.name === '其他');
  if (!valid) return null;
  if (ordered) {
    const positions = new Set();
    for (const row of rows) {
      if (!Number.isSafeInteger(row.sort_order) || (row.id === 'other' ? row.sort_order !== 0 : row.sort_order < 1) ||
        positions.has(row.sort_order)) return null;
      positions.add(row.sort_order);
    }
  }
  return ids;
}
const markdownCell = value => value.replaceAll('|', '\\|').replace(/\r?\n/g, ' ');

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
function autoRenewValue(value) {
  if (value !== null && typeof value !== 'boolean') throw new AppError('自动续费状态应为开启、关闭或未记录。');
  return value === null ? null : Number(value);
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// 备注里恰好有一条独立的「账号：邮箱」/「账号: 邮箱」行时，把邮箱拆出来；其余情况保留原文。
export function extractQuotaAccount(note) {
  const newline = note.includes('\r\n') ? '\r\n' : '\n';
  const lines = note.split(/\r?\n/);
  const candidates = lines.map((line, index) => ({ line, index })).filter(({ line }) => /^\s*账号\s*[：:]/.test(line));
  if (candidates.length !== 1) return null;
  const match = /^\s*账号\s*[：:]\s*(\S+)\s*$/.exec(candidates[0].line);
  if (!match || !EMAIL.test(match[1])) return null;
  const rest = lines.filter((_, index) => index !== candidates[0].index);
  while (rest.length && !rest[0].trim()) rest.shift();
  while (rest.length && !rest[rest.length - 1].trim()) rest.pop();
  return { account: match[1], note: rest.join(newline) };
}
function readSubscription(row) {
  return { ...row, autoRenew: row.autoRenew === null ? null : row.autoRenew === 1 };
}
const splitList = text => text ? text.split(',') : [];
function readEvent(row) {
  return { ...row, repeatDays: splitList(row.repeatDays).map(Number), skippedDates: splitList(row.skippedDates) };
}
function optionalTime(value, field) {
  const text = stringValue(value ?? '', field, 10).trim();
  if (!text) return '';
  const match = text.match(/^(\d{1,2})[:：](\d{2})$/);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new AppError(field + '应为 HH:MM，例如 19:00。');
  return match[1].padStart(2, '0') + ':' + match[2];
}
function requiredDate(value, field) {
  const text = optionalIsoDate(value, field);
  if (!text) throw new AppError(field + '不能为空，格式为 YYYY-MM-DD。');
  return text;
}
// 星期可以写成 [5,6]、"5,6"；0 表示周日。
function weekdayList(value) {
  const parts = Array.isArray(value) ? value : stringValue(value ?? '', '重复星期', 40).split(/[,，\s]+/).filter(Boolean);
  const days = parts.map(part => typeof part === 'number' ? part : /^\d$/.test(String(part)) ? Number(part) : NaN);
  if (days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw new AppError('重复星期应为 0–6 的数字列表（0 是周日），例如 [5,6]。');
  return [...new Set(days)].sort((a, b) => a - b);
}
function dateList(value) {
  const parts = Array.isArray(value) ? value : stringValue(value ?? '', '跳过日期', 20_000).split(/[,，\s]+/).filter(Boolean);
  return [...new Set(parts.map(part => requiredDate(part, '跳过日期')))].sort();
}
function reminderValue(value) {
  if (value === null || value === '' || value === undefined) return null;
  const minutes = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value;
  if (!REMINDER_OPTIONS.includes(minutes)) throw new AppError('提醒应为 null（不提醒）或提前分钟数：' + REMINDER_OPTIONS.join('、') + '。');
  return minutes;
}
// 合并输入与当前值并校验；省略的字段保留原值。
function eventFields(input, current) {
  const pick = key => input[key] === undefined ? current[key] : input[key];
  const title = stringValue(pick('title') ?? '', '标题', 200).trim();
  if (!title) throw new AppError('日程标题不能为空。');
  const date = requiredDate(pick('date'), '日期');
  const startTime = optionalTime(pick('startTime'), '开始时间');
  const endTime = optionalTime(pick('endTime'), '结束时间');
  if (endTime && !startTime) throw new AppError('填写结束时间前需要先填写开始时间。');
  if (endTime && endTime <= startTime) throw new AppError('结束时间应晚于开始时间。');
  const repeat = pick('repeat') ?? 'none';
  if (!REPEATS.includes(repeat)) throw new AppError('重复应为 none（不重复）、daily（每天）或 weekly（每周）。');
  const repeatDays = repeat === 'weekly' ? weekdayList(pick('repeatDays') ?? []) : [];
  const repeatUntil = repeat === 'none' ? '' : optionalIsoDate(pick('repeatUntil') ?? '', '重复截止');
  if (repeatUntil && repeatUntil < date) throw new AppError('重复截止不能早于日期。');
  // 不重复的日程只能跳过它自己那天；改了日期，原来的跳过自然失效。
  const skippedDates = dateList(pick('skippedDates') ?? []).filter(day => repeat !== 'none' || day === date);
  const reminderMinutes = reminderValue(pick('reminderMinutes'));
  if (reminderMinutes !== null && !startTime) throw new AppError('设置提醒需要先填写开始时间。');
  return {
    title, date, startTime, endTime, repeat, repeatDays, repeatUntil, skippedDates, reminderMinutes,
    location: stringValue(pick('location') ?? '', '地点', 300).trim(),
    note: stringValue(pick('note') ?? '', '备注', 5000),
  };
}
const emptyEvent = { title: '', date: '', startTime: '', endTime: '', location: '', note: '', repeat: 'none', repeatDays: [], repeatUntil: '', skippedDates: [], reminderMinutes: null };
const sourceValue = value => typeof value === 'string' && /^[a-z][\w-]{0,30}$/i.test(value) ? value.toLowerCase() : 'app';
function titleOf(kind, record) {
  if (!record) return '';
  return kind === 'quota' ? record.platform : kind === 'subscription' ? record.service : kind === 'attachment' ? record.filename : record.title;
}
function compareEvents(a, b) {
  return a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime) || a.title.localeCompare(b.title);
}

const WRITE_METHODS = ['insertTask', 'updateTask', 'toggleTaskStep', 'insertNote', 'updateNote', 'insertQuota', 'updateQuota',
  'insertSubscription', 'updateSubscription', 'insertEvent', 'updateEvent', 'skipEventOccurrence', 'unskipEventOccurrence', 'deleteEntity', 'restoreEntity'];

export class Store {
  constructor(root) {
    this.root = path.resolve(root);
    this.dataDir = path.join(this.root, 'app', 'data');
    this.attachmentDir = path.join(this.root, '附件');
    this.logoDir = path.join(this.root, '图标');
    this.backupDir = path.join(this.root, '备份');
    this.exportDir = path.join(this.root, '导出');
    this.dbPath = path.join(this.dataDir, 'folio.sqlite');
    this.source = 'app';
    this.logging = true;
    this.openCount = 0;
    for (const directory of [this.dataDir, this.attachmentDir, this.logoDir]) fs.mkdirSync(directory, { recursive: true });
    this.migrateLegacyDbName();
    const existing = fs.existsSync(this.dbPath);
    this.openDatabase();
    if (existing) this.ensureSchema();
    else this.transaction(() => {
      this.db.exec(
        'CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);' +
        'CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,date_text TEXT NOT NULL,body_markdown TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN (\'pending\',\'completed\')),sort_order INTEGER NOT NULL,completed_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,version INTEGER NOT NULL DEFAULT 1);' +
        'CREATE TABLE notes(id TEXT PRIMARY KEY,title TEXT NOT NULL,body_markdown TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,version INTEGER NOT NULL DEFAULT 1);' +
        'CREATE TABLE attachments(id TEXT PRIMARY KEY,filename TEXT NOT NULL,storage_path TEXT UNIQUE NOT NULL,size INTEGER NOT NULL,created_at TEXT NOT NULL,deleted_at TEXT);' +
        'CREATE TABLE attachment_links(attachment_id TEXT NOT NULL REFERENCES attachments(id),owner_type TEXT NOT NULL CHECK(owner_type IN (\'task\',\'note\')),owner_id TEXT NOT NULL,PRIMARY KEY(attachment_id,owner_type,owner_id));' +
        SERVICE_TABLES + EVENT_TABLE + ACTIVITY_TABLE +
        "INSERT INTO settings VALUES('schema_version','" + SCHEMA_VERSION + "');"
      );
      this.addLogoColumns();
      this.seedCategories('subscription');
      this.seedCategories('quota');
    });
    if (!this.db.prepare("SELECT value FROM settings WHERE key='migration_complete'").get()) this.bootstrapSources();
  }
  migrateLegacyDbName() {
    const legacy = path.join(this.dataDir, 'daily-affairs.sqlite');
    if (!fs.existsSync(this.dbPath) && fs.existsSync(legacy)) fs.renameSync(legacy, this.dbPath);
  }
  ensureSchema() {
    const version = this.db.prepare("SELECT value FROM settings WHERE key='schema_version'").get();
    if (version?.value === String(SCHEMA_VERSION)) return;
    if (!SCHEMA_VERSIONS.slice(0, -1).includes(version?.value)) throw new Error('数据库版本不受支持，原数据已保留。');
    this.transaction(() => {
      // v1 没有服务表，直接按最新结构建表；v2–v6 逐级补列，已有记录归为 AI，账号从备注迁出，分类改为可管理。
      // v8 及更早都没有日程和改动记录，最后统一建表。
      if (['8', '9'].includes(version.value)) {
        // v8 只需要新增日程和改动记录；v9 只需要新增 logo 列。
      } else if (version.value === '1') {
        this.db.exec(SERVICE_TABLES);
        this.seedCategories('subscription');
        this.seedCategories('quota');
      } else if (version.value === '7') {
        this.migrateCategoryOrder('subscription');
        this.migrateCategoryOrder('quota');
      } else if (version.value === '6') {
        this.migrateCategoryOrder('subscription');
        this.rebuildQuotaTable();
      } else {
        if (version.value === '2') {
          this.db.exec("ALTER TABLE subscriptions ADD COLUMN category TEXT NOT NULL DEFAULT 'other' CHECK(category IN ('ai','network','other'));" +
            'ALTER TABLE subscriptions ADD COLUMN auto_renew INTEGER CHECK(auto_renew IN (0,1));' +
            "UPDATE subscriptions SET category='ai';");
        }
        if (['2', '3'].includes(version.value)) {
          this.db.exec("ALTER TABLE api_quotas ADD COLUMN category TEXT NOT NULL DEFAULT 'other' CHECK(category IN ('ai','network','other'));" +
            "UPDATE api_quotas SET category='ai';");
        }
        if (version.value !== '5') {
          this.db.exec("ALTER TABLE api_quotas ADD COLUMN account TEXT NOT NULL DEFAULT '';");
          this.migrateQuotaAccounts();
        }
        this.db.exec(CATEGORY_TABLE);
        this.seedCategories('subscription');
        const columns = subColumns.replace(/ AS [a-zA-Z]+/g, '');
        this.db.exec('ALTER TABLE subscriptions RENAME TO subscriptions_legacy;' + SUBSCRIPTION_TABLE +
          'INSERT INTO subscriptions(' + columns + ') SELECT ' + columns + ' FROM subscriptions_legacy;' +
          'DROP TABLE subscriptions_legacy;');
        this.rebuildQuotaTable();
      }
      this.db.exec(EVENT_TABLE + ACTIVITY_TABLE);
      this.addLogoColumns();
      this.db.prepare("UPDATE settings SET value=? WHERE key='schema_version'").run(String(SCHEMA_VERSION));
    });
  }
  // v10：四种条目都加 logo 列，旧数据为空，界面显示首字母头像。
  addLogoColumns() {
    for (const table of Object.values(LOGO_KINDS)) {
      if (this.db.prepare('PRAGMA table_info(' + table + ')').all().some(column => column.name === 'logo')) continue;
      this.db.exec('ALTER TABLE ' + table + " ADD COLUMN logo TEXT NOT NULL DEFAULT ''");
    }
  }
  // v6 及更早：额度分类从固定的 CHECK 约束改为引用 quota_categories，保留原有 id。
  rebuildQuotaTable() {
    this.db.exec(QUOTA_CATEGORY_TABLE);
    this.seedCategories('quota');
    const columns = quotaColumns.replace(/ AS [a-zA-Z]+/g, '');
    this.db.exec('ALTER TABLE api_quotas RENAME TO api_quotas_legacy;' + QUOTA_TABLE +
      'INSERT INTO api_quotas(' + columns + ') SELECT ' + columns + ' FROM api_quotas_legacy;' +
      'DROP TABLE api_quotas_legacy;');
  }
  seedCategories(scope) {
    const { table, defaults } = CATEGORY_SCOPES[scope];
    const insert = this.db.prepare('INSERT INTO ' + table + '(id,name,sort_order) VALUES(?,?,?)');
    defaults.forEach(([id, name], index) => insert.run(id, name, id === 'other' ? 0 : index + 1));
  }
  migrateCategoryOrder(scope) {
    const { table } = CATEGORY_SCOPES[scope];
    this.db.exec('ALTER TABLE ' + table + ' ADD COLUMN ' + CATEGORY_POSITION);
    this.writeCategoryOrder(scope, this.categories(scope).map(row => row.id));
  }
  categories(scope) {
    return this.db.prepare('SELECT id,name FROM ' + CATEGORY_SCOPES[scope].table + " ORDER BY id='other',sort_order,rowid").all();
  }
  writeCategoryOrder(scope, ids) {
    const update = this.db.prepare('UPDATE ' + CATEGORY_SCOPES[scope].table + ' SET sort_order=? WHERE id=?');
    ids.forEach((id, index) => update.run(id === 'other' ? 0 : index + 1, id));
  }
  reorderCategories(scope, input) {
    return this.transaction(() => {
      const ids = input?.ids;
      const current = this.categories(scope).map(row => row.id);
      if (!Array.isArray(ids) || ids.length !== current.length || ids.at(-1) !== 'other' ||
        new Set(ids).size !== current.length || current.some(id => !ids.includes(id))) {
        throw new AppError('分类顺序无效或分类已变化，请刷新后重试。');
      }
      const expected = input.expectedIds;
      if (expected !== undefined && (!Array.isArray(expected) || expected.length !== current.length ||
        current.some((id, index) => id !== expected[index]))) {
        throw new AppError('分类顺序已变化，请刷新后重试。', 409, 'CATEGORY_ORDER_CHANGED');
      }
      this.writeCategoryOrder(scope, ids);
      return this.categories(scope);
    });
  }
  // 分类可以写 id，也可以写分类名（不区分大小写），方便命令行和智能体直接写「AI」「云服务」。
  categoryId(scope, id) {
    const { table, label } = CATEGORY_SCOPES[scope];
    if (typeof id === 'string') {
      if (this.db.prepare('SELECT id FROM ' + table + ' WHERE id=?').get(id)) return id;
      const byName = this.categories(scope).find(row => row.name.toLowerCase() === id.trim().toLowerCase());
      if (byName) return byName.id;
    }
    throw new AppError(label + '分类不存在。可用分类：' + this.categories(scope).map(row => row.name).join('、') + '。');
  }
  saveCategory(scope, input, id = crypto.randomUUID(), creating = true) {
    const { table } = CATEGORY_SCOPES[scope];
    const name = stringValue(input.name, '分类名称', 80).trim();
    if (!name) throw new AppError('分类名称不能为空。');
    return this.transaction(() => {
      if (!creating) {
        this.categoryId(scope, id);
        if (id === 'other') throw new AppError('不能重命名「其他」。');
      }
      if (this.categories(scope).some(row => row.id !== id && row.name.toLowerCase() === name.toLowerCase())) {
        throw new AppError('分类名称已存在。', 409, 'CATEGORY_EXISTS');
      }
      if (creating) this.db.prepare('INSERT INTO ' + table + '(id,name,sort_order) SELECT ?,?,COALESCE(MAX(sort_order),0)+1 FROM ' + table).run(id, name);
      else this.db.prepare('UPDATE ' + table + ' SET name=? WHERE id=?').run(name, id);
      return { id, name };
    });
  }
  deleteCategory(scope, id, input) {
    const { table, items, label } = CATEGORY_SCOPES[scope];
    this.transaction(() => {
      this.categoryId(scope, id);
      if (id === 'other') throw new AppError('不能删除「其他」。');
      const count = this.db.prepare('SELECT count(*) AS total FROM ' + items + ' WHERE category=?').get(id).total;
      if (input?.count !== count) throw new AppError('受影响的' + label + '数量已变化，请重新确认。', 409, 'CATEGORY_COUNT_CHANGED');
      this.db.prepare('UPDATE ' + items + " SET category='other',version=version+1,updated_at=? WHERE category=?").run(now(), id);
      this.db.prepare('DELETE FROM ' + table + ' WHERE id=?').run(id);
    });
  }
  subscriptionCategories() { return this.categories('subscription'); }
  subscriptionCategory(id) { return this.categoryId('subscription', id); }
  saveSubscriptionCategory(input, id, creating) { return this.saveCategory('subscription', input, id, creating); }
  deleteSubscriptionCategory(id, input) { return this.deleteCategory('subscription', id, input); }
  quotaCategories() { return this.categories('quota'); }
  saveQuotaCategory(input, id, creating) { return this.saveCategory('quota', input, id, creating); }
  deleteQuotaCategory(id, input) { return this.deleteCategory('quota', id, input); }
  migrateQuotaAccounts() {
    const update = this.db.prepare('UPDATE api_quotas SET account=?,note=? WHERE id=?');
    for (const row of this.db.prepare('SELECT id,note FROM api_quotas').all()) {
      const extracted = extractQuotaAccount(row.note);
      if (extracted) update.run(extracted.account, extracted.note, row.id);
    }
  }
  openDatabase() {
    this.db = new DatabaseSync(this.dbPath);
    this.openCount += 1;
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;');
    const integrity = this.db.prepare('PRAGMA integrity_check').get();
    if (integrity.integrity_check !== 'ok') throw new Error('数据库完整性检查失败，原数据已保留。');
  }
  close() { this.db.close(); }
  transaction(work) {
    if (this.inTransaction) return work();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try { const result = work(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
    finally { this.inTransaction = false; }
  }
  // 以指定来源执行一次写入（server 按请求头传入），用于改动记录。
  as(source, work) {
    const previous = this.source;
    this.source = sourceValue(source);
    try { return work(); } finally { this.source = previous; }
  }
  // 每次写入都会改变；重新打开数据库（恢复备份）时也会改变。渲染端据此发现外部改动。
  revision() {
    return this.openCount + '-' + this.db.prepare('SELECT total_changes() AS total').get().total;
  }
  record(action, kind, before, after) {
    if (!this.logging) return;
    const item = after || before;
    this.db.prepare('INSERT INTO activity_log(at,source,action,kind,item_id,title,before_json,after_json) VALUES(?,?,?,?,?,?,?,?)')
      .run(now(), this.source, action, kind, item.id, titleOf(kind, item), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null);
    this.db.prepare('DELETE FROM activity_log WHERE id <= (SELECT MAX(id) FROM activity_log) - ?').run(ACTIVITY_LIMIT);
  }
  activity(input = {}) {
    const limit = Math.min(Math.max(Number.parseInt(input.limit ?? 50, 10) || 50, 1), ACTIVITY_LIMIT);
    const kind = typeof input.kind === 'string' && input.kind ? input.kind : null;
    if (kind && !ENTITY_TABLES[kind]) throw new AppError('类型应为 task、event、quota 或 subscription。');
    const rows = this.db.prepare('SELECT ' + activityColumns + ' FROM activity_log' + (kind ? ' WHERE kind=?' : '') + ' ORDER BY id DESC LIMIT ?')
      .all(...(kind ? [kind, limit] : [limit]));
    return rows.map(({ beforeJson, afterJson, ...row }) => ({ ...row, before: beforeJson ? JSON.parse(beforeJson) : null, after: afterJson ? JSON.parse(afterJson) : null }));
  }
  // 路由里的 id 可以写完整 id，也可以写唯一前缀（至少 6 位）。
  resolveId(kind, id) {
    const table = ENTITY_TABLES[kind];
    if (typeof id !== 'string' || !id) return id;
    if (this.db.prepare('SELECT id FROM ' + table + ' WHERE id=?').get(id)) return id;
    if (id.length < 6 || !/^[\w-]+$/.test(id)) return id;
    const matches = this.db.prepare('SELECT id FROM ' + table + ' WHERE substr(id,1,?)=? LIMIT 6').all(id.length, id);
    if (matches.length > 1) throw new AppError('id 前缀「' + id + '」匹配到多条' + ENTITY_LABELS[kind] + '，请写完整 id：' + matches.map(row => row.id).join('、'), 409, 'AMBIGUOUS_ID');
    return matches[0]?.id ?? id;
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
      this.logging = false;
      try { tasks.forEach(task => this.insertTask(task)); } finally { this.logging = true; }
      notes.forEach(note => this.insertNote(note));
      for (const file of files) {
        this.db.prepare('INSERT INTO attachments(id,filename,storage_path,size,created_at) VALUES(?,?,?,?,?)').run(crypto.randomUUID(), path.basename(file.relative), file.relative, fs.statSync(file.absolute).size, now());
      }
      this.db.prepare('INSERT INTO settings VALUES(?,?)').run('migration_complete', now());
      this.db.prepare('INSERT INTO settings VALUES(?,?)').run('migration_metadata', JSON.stringify(metadata));
    });
  }
  task(id, includeDeleted = false) {
    id = this.resolveId('task', id);
    const task = this.db.prepare('SELECT ' + withLogo(taskColumns) + ' FROM tasks WHERE id=?' + (includeDeleted ? '' : ' AND deleted_at IS NULL')).get(id);
    if (!task) throw new AppError('事项不存在或已移入回收站。', 404, 'NOT_FOUND');
    return task;
  }
  note(id, includeDeleted = false) {
    id = this.resolveId('note', id);
    const note = this.db.prepare('SELECT ' + noteColumns + ' FROM notes WHERE id=?' + (includeDeleted ? '' : ' AND deleted_at IS NULL')).get(id);
    if (!note) throw new AppError('记录不存在或已移入回收站。', 404, 'NOT_FOUND');
    return note;
  }
  file(id, includeDeleted = false) {
    id = this.resolveId('attachment', id);
    const file = this.db.prepare('SELECT ' + fileColumns + ' FROM attachments WHERE id=?' + (includeDeleted ? '' : ' AND deleted_at IS NULL')).get(id);
    if (!file) throw new AppError('附件不存在或已移入回收站。', 404, 'NOT_FOUND');
    return file;
  }
  quota(id, includeDeleted = false) {
    id = this.resolveId('quota', id);
    const row = this.db.prepare('SELECT ' + withLogo(quotaColumns) + ' FROM api_quotas WHERE id=?' + (includeDeleted ? '' : ' AND deleted_at IS NULL')).get(id);
    if (!row) throw new AppError('额度记录不存在或已移入回收站。', 404, 'NOT_FOUND');
    return row;
  }
  subscription(id, includeDeleted = false) {
    id = this.resolveId('subscription', id);
    const row = this.db.prepare('SELECT ' + withLogo(subColumns) + ' FROM subscriptions WHERE id=?' + (includeDeleted ? '' : ' AND deleted_at IS NULL')).get(id);
    if (!row) throw new AppError('订阅不存在或已移入回收站。', 404, 'NOT_FOUND');
    return readSubscription(row);
  }
  event(id, includeDeleted = false) {
    id = this.resolveId('event', id);
    const row = this.db.prepare('SELECT ' + withLogo(eventColumns) + ' FROM events WHERE id=?' + (includeDeleted ? '' : ' AND deleted_at IS NULL')).get(id);
    if (!row) throw new AppError('日程不存在或已移入回收站。', 404, 'NOT_FOUND');
    return readEvent(row);
  }
  state() {
    return {
      tasks: this.db.prepare('SELECT ' + withLogo(taskColumns) + ' FROM tasks').all().sort(compareTasks),
      notes: this.db.prepare('SELECT ' + noteColumns + ' FROM notes ORDER BY updated_at DESC').all(),
      attachments: this.db.prepare('SELECT ' + fileColumns + ' FROM attachments ORDER BY created_at DESC').all(),
      links: this.db.prepare('SELECT attachment_id AS attachmentId,owner_type AS ownerType,owner_id AS ownerId FROM attachment_links').all(),
      quotas: this.db.prepare('SELECT ' + withLogo(quotaColumns) + ' FROM api_quotas ORDER BY platform COLLATE NOCASE').all(),
      quotaCategories: this.quotaCategories(),
      subscriptionCategories: this.subscriptionCategories(),
      subscriptions: this.db.prepare('SELECT ' + withLogo(subColumns) + ' FROM subscriptions').all().map(readSubscription).sort(compareSubscriptions),
      events: this.db.prepare('SELECT ' + withLogo(eventColumns) + ' FROM events').all().map(readEvent).sort(compareEvents),
      migration: (() => {
        const row = this.db.prepare("SELECT value FROM settings WHERE key='migration_metadata'").get();
        return row ? JSON.parse(row.value) : null;
      })(),
    };
  }
  // 不带 version 时直接写入（命令行、智能体）；带了就必须和当前一致，界面靠它防止覆盖。
  checkVersion(record, version) {
    if (version === undefined || version === null) return;
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
    const record = this.task(id);
    this.record('create', 'task', null, record);
    return record;
  }
  updateTask(id, input) {
    const current = this.task(id);
    id = current.id;
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
    const record = this.task(id);
    this.record('update', 'task', current, record);
    return record;
  }
  toggleTaskStep(id, input) {
    const current = this.task(id);
    id = current.id;
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
    const record = this.note(id);
    this.record('create', 'note', null, record);
    return record;
  }
  updateNote(id, input) {
    const current = this.note(id);
    id = current.id;
    this.checkVersion(current, input.version);
    const title = stringValue(input.title ?? current.title, '标题', 500).trim() || '无标题';
    const body = stringValue(input.bodyMarkdown ?? current.bodyMarkdown, '正文');
    this.db.prepare('UPDATE notes SET title=?,body_markdown=?,updated_at=?,version=version+1 WHERE id=?').run(title, body, now(), id);
    const record = this.note(id);
    this.record('update', 'note', current, record);
    return record;
  }
  insertQuota(input) {
    const kind = stringValue(input.kind ?? '官方', '类型', 20).trim();
    if (!['官方', '中转'].includes(kind)) throw new AppError('额度类型应为「官方」或「中转」。');
    const category = this.categoryId('quota', input.category === undefined ? 'other' : input.category);
    const platform = stringValue(input.platform ?? '', '平台', 200).trim();
    if (!platform) throw new AppError('平台名称不能为空。');
    const account = stringValue(input.account ?? '', '账号', 200).trim();
    const entryUrl = stringValue(input.entryUrl ?? '', '入口', 2000).trim();
    const balance = stringValue(input.balance ?? '', '余额', 200).trim();
    const recordedAt = optionalIsoDate(input.recordedAt, '记录日期');
    const note = stringValue(input.note ?? '', '备注', 5000);
    const id = crypto.randomUUID();
    const timestamp = now();
    this.db.prepare('INSERT INTO api_quotas(id,kind,category,platform,account,entry_url,balance,recorded_at,note,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, kind, category, platform, account, entryUrl, balance, recordedAt, note, timestamp, timestamp);
    const record = this.quota(id);
    this.record('create', 'quota', null, record);
    return record;
  }
  updateQuota(id, input) {
    const current = this.quota(id);
    id = current.id;
    this.checkVersion(current, input.version);
    const kind = stringValue(input.kind ?? current.kind, '类型', 20).trim();
    if (!['官方', '中转'].includes(kind)) throw new AppError('额度类型应为「官方」或「中转」。');
    const category = this.categoryId('quota', input.category === undefined ? current.category : input.category);
    const platform = stringValue(input.platform ?? current.platform, '平台', 200).trim();
    if (!platform) throw new AppError('平台名称不能为空。');
    // 省略 account 时保留原值；显式传空字符串时清空。
    const account = stringValue(input.account ?? current.account, '账号', 200).trim();
    const entryUrl = stringValue(input.entryUrl ?? current.entryUrl, '入口', 2000).trim();
    const balance = stringValue(input.balance ?? current.balance, '余额', 200).trim();
    const recordedAt = optionalIsoDate(input.recordedAt ?? current.recordedAt, '记录日期');
    const note = stringValue(input.note ?? current.note, '备注', 5000);
    this.db.prepare('UPDATE api_quotas SET kind=?,category=?,platform=?,account=?,entry_url=?,balance=?,recorded_at=?,note=?,updated_at=?,version=version+1 WHERE id=?')
      .run(kind, category, platform, account, entryUrl, balance, recordedAt, note, now(), id);
    const record = this.quota(id);
    this.record('update', 'quota', current, record);
    return record;
  }
  insertSubscription(input) {
    const service = stringValue(input.service ?? '', '服务', 200).trim();
    if (!service) throw new AppError('服务名称不能为空。');
    const category = this.subscriptionCategory(input.category === undefined ? 'other' : input.category);
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
    const record = this.subscription(id);
    this.record('create', 'subscription', null, record);
    return record;
  }
  updateSubscription(id, input) {
    const current = this.subscription(id);
    id = current.id;
    this.checkVersion(current, input.version);
    const category = this.subscriptionCategory(input.category === undefined ? current.category : input.category);
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
    const record = this.subscription(id);
    this.record('update', 'subscription', current, record);
    return record;
  }
  insertEvent(input) {
    const fields = eventFields(input ?? {}, emptyEvent);
    const id = crypto.randomUUID();
    const timestamp = now();
    this.db.prepare('INSERT INTO events(id,title,date,start_time,end_time,location,note,repeat_rule,repeat_days,repeat_until,skipped_dates,reminder_minutes,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, fields.title, fields.date, fields.startTime, fields.endTime, fields.location, fields.note, fields.repeat, fields.repeatDays.join(','), fields.repeatUntil, fields.skippedDates.join(','), fields.reminderMinutes, timestamp, timestamp);
    const record = this.event(id);
    this.record('create', 'event', null, record);
    return record;
  }
  updateEvent(id, input, action = 'update') {
    const current = this.event(id);
    id = current.id;
    this.checkVersion(current, input?.version);
    const fields = eventFields(input ?? {}, current);
    this.db.prepare('UPDATE events SET title=?,date=?,start_time=?,end_time=?,location=?,note=?,repeat_rule=?,repeat_days=?,repeat_until=?,skipped_dates=?,reminder_minutes=?,updated_at=?,version=version+1 WHERE id=?')
      .run(fields.title, fields.date, fields.startTime, fields.endTime, fields.location, fields.note, fields.repeat, fields.repeatDays.join(','), fields.repeatUntil, fields.skippedDates.join(','), fields.reminderMinutes, now(), id);
    const record = this.event(id);
    this.record(action, 'event', current, record);
    return record;
  }
  // 跳过某一次（例如这周家教取消、今天不去健身）。重复日程其余日子不变；不重复的日程只能跳过它自己那天。
  skipEventOccurrence(id, input) {
    const current = this.event(id);
    this.checkVersion(current, input?.version);
    const date = requiredDate(input?.date, '跳过日期');
    if (current.skippedDates.includes(date)) return current;
    if (!occursOn(current, date)) throw new AppError(date + ' 这天没有这个日程。');
    return this.updateEvent(current.id, { skippedDates: [...current.skippedDates, date] }, 'skip');
  }
  // 恢复被跳过的某一次。
  unskipEventOccurrence(id, input) {
    const current = this.event(id);
    this.checkVersion(current, input?.version);
    const date = requiredDate(input?.date, '恢复日期');
    if (!current.skippedDates.includes(date)) throw new AppError(date + ' 这一次没有被跳过。');
    return this.updateEvent(current.id, { skippedDates: current.skippedDates.filter(day => day !== date) }, 'unskip');
  }
  deleteEntity(type, id, input = {}) {
    const table = ENTITY_TABLES[type];
    if (!table) throw new AppError('对象类型无效。');
    const current = this.entity(type, id);
    id = current.id;
    if (type !== 'attachment') this.checkVersion(current, input?.version);
    const hasVersion = type !== 'attachment';
    this.db.prepare('UPDATE ' + table + ' SET deleted_at=?' + (hasVersion ? ',version=version+1,updated_at=?' : '') + ' WHERE id=?')
      .run(...(hasVersion ? [now(), now(), id] : [now(), id]));
    if (type !== 'attachment') this.record('delete', type, current, null);
  }
  entity(type, id, includeDeleted = false) {
    if (!ENTITY_TABLES[type]) throw new AppError('对象类型无效。');
    return type === 'attachment' ? this.file(id, includeDeleted) : this[type](id, includeDeleted);
  }
  restoreEntity(type, id) {
    const table = ENTITY_TABLES[type];
    if (!table) throw new AppError('对象类型无效。');
    const current = this.entity(type, id, true);
    id = current.id;
    if (!current.deletedAt) throw new AppError('对象未在回收站中。');
    const hasVersion = type !== 'attachment';
    this.db.prepare('UPDATE ' + table + ' SET deleted_at=NULL' + (hasVersion ? ',version=version+1,updated_at=?' : '') + ' WHERE id=?')
      .run(...(hasVersion ? [now(), id] : [id]));
    if (type !== 'attachment') this.record('restore', type, null, this.entity(type, id));
  }
  // 设置或移除 logo。同一张图给多个条目用时只存一份；没人再用的图会删除。
  setLogo(kind, id, bytes, input = {}) {
    const table = LOGO_KINDS[kind];
    if (!table) throw new AppError('只有待办、日程、额度、订阅可以设置 logo。');
    const current = this.entity(kind, id);
    id = current.id;
    this.checkVersion(current, input.version === undefined || input.version === '' ? undefined : Number(input.version));
    let logo = '';
    if (bytes) {
      if (!bytes.length) throw new AppError('图片文件是空的。');
      if (bytes.length > LOGO_MAX_BYTES) throw new AppError('图片不能超过 1 MB。');
      const format = logoFormat(bytes);
      if (!format) throw new AppError('只支持 PNG、JPG、WebP、SVG 或 ICO 图片。');
      logo = hash(bytes) + '.' + format;
      const destination = path.join(this.logoDir, logo);
      if (!fs.existsSync(destination)) fs.writeFileSync(destination, bytes);
    }
    if (logo === current.logo) return current;
    this.transaction(() => {
      this.db.prepare('UPDATE ' + table + ' SET logo=?,updated_at=?,version=version+1 WHERE id=?').run(logo, now(), id);
      this.record('update', kind, current, this.entity(kind, id));
    });
    this.collectLogo(current.logo);
    return this.entity(kind, id);
  }
  collectLogo(file) {
    if (!file || !LOGO_FILE.test(file)) return;
    const used = Object.values(LOGO_KINDS).some(table => this.db.prepare('SELECT 1 FROM ' + table + ' WHERE logo=? LIMIT 1').get(file));
    if (!used) fs.rmSync(path.join(this.logoDir, file), { force: true });
  }
  logoPath(file) {
    if (typeof file !== 'string' || !LOGO_FILE.test(file)) throw new AppError('图标文件名无效。');
    const absolute = path.join(this.logoDir, file);
    if (!fs.existsSync(absolute)) throw new AppError('图标不存在。', 404, 'NOT_FOUND');
    return { absolute, type: LOGO_TYPES[file.split('.').pop()] };
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
      for (const name of fs.existsSync(this.logoDir) ? fs.readdirSync(this.logoDir) : []) {
        if (LOGO_FILE.test(name)) entries['logos/' + name] = new Uint8Array(fs.readFileSync(path.join(this.logoDir, name)));
      }
      const manifest = { format: 'folio-backup', schemaVersion: SCHEMA_VERSION, createdAt: now(), label, files: Object.fromEntries(Object.entries(entries).map(([name, bytes]) => [name, hash(bytes)])) };
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
    const okFormat = (manifest.format === 'folio-backup' && SCHEMA_VERSIONS.slice(1).map(Number).includes(manifest.schemaVersion))
      || (manifest.format === 'daily-affairs-backup' && manifest.schemaVersion === 1);
    if (!okFormat || !manifest.files || !entries['data.sqlite']) throw new AppError('备份版本或结构不受支持。');
    for (const [name, checksum] of Object.entries(manifest.files)) {
      safeRelative(name);
      if (name !== 'data.sqlite' && !name.startsWith('attachments/') && !(name.startsWith('logos/') && LOGO_FILE.test(name.slice('logos/'.length)))) throw new AppError('备份包含不支持的内容。');
      if (!entries[name] || hash(entries[name]) !== checksum) throw new AppError('备份校验失败，当前数据未改变。');
    }
    if (Object.keys(entries).some(name => name !== 'manifest.json' && !(name in manifest.files))) throw new AppError('备份包含未校验文件。');
    const scratch = path.join(this.dataDir, 'restore-' + crypto.randomUUID());
    fs.mkdirSync(scratch, { recursive: true });
    const candidatePath = path.join(scratch, 'candidate.sqlite');
    const candidateAttachments = path.join(scratch, 'attachments');
    const candidateLogos = path.join(scratch, 'logos');
    fs.mkdirSync(candidateAttachments);
    fs.mkdirSync(candidateLogos);
    let validationDb;
    try {
      fs.writeFileSync(candidatePath, entries['data.sqlite']);
      validationDb = new DatabaseSync(candidatePath, { readOnly: true });
      if (validationDb.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new AppError('备份数据库校验失败。');
      const schema = validationDb.prepare("SELECT value FROM settings WHERE key='schema_version'").get()?.value;
      if (!SCHEMA_VERSIONS.includes(schema) || Number(schema) !== manifest.schemaVersion) throw new AppError('备份数据库校验失败。');
      validationDb.prepare('SELECT ' + taskColumns + ' FROM tasks').all();
      if (schema === '10') {
        // 每个引用的 logo 都要在备份里。
        for (const table of Object.values(LOGO_KINDS)) {
          for (const { logo } of validationDb.prepare('SELECT logo FROM ' + table).all()) {
            if (typeof logo !== 'string' || (logo && (!LOGO_FILE.test(logo) || !entries['logos/' + logo]))) throw new AppError('备份缺少图标文件。');
          }
        }
      }
      validationDb.prepare('SELECT ' + noteColumns + ' FROM notes').all();
      validationDb.prepare('SELECT * FROM attachment_links').all();
      if (schema !== '1') {
        const quotas = validationDb.prepare('SELECT ' + quotaColumnsBySchema[schema] + ' FROM api_quotas').all();
        const ordered = ['8', '9', '10'].includes(schema);
        const categoryColumns = ordered ? 'id,name,sort_order' : 'id,name';
        const managedQuotas = ['7', '8', '9', '10'].includes(schema);
        const quotaCategoryIds = managedQuotas ? validCategories(validationDb.prepare('SELECT ' + categoryColumns + ' FROM quota_categories').all(), ordered) : null;
        if (managedQuotas && !quotaCategoryIds) throw new AppError('备份额度分类校验失败。');
        if (['4', '5', '6', '7', '8', '9', '10'].includes(schema) && quotas.some(row => !(managedQuotas ? quotaCategoryIds.has(row.category) : isServiceCategory(row.category)))) throw new AppError('备份额度字段校验失败。');
        if (['5', '6', '7', '8', '9', '10'].includes(schema) && quotas.some(row => typeof row.account !== 'string')) throw new AppError('备份额度字段校验失败。');
        const subscriptions = validationDb.prepare('SELECT ' + (schema === '2' ? legacySubColumns : subColumns) + ' FROM subscriptions').all();
        const managed = ['6', '7', '8', '9', '10'].includes(schema);
        const categoryIds = managed ? validCategories(validationDb.prepare('SELECT ' + categoryColumns + ' FROM subscription_categories').all(), ordered) : null;
        if (managed && !categoryIds) throw new AppError('备份订阅分类校验失败。');
        if (schema !== '2' && subscriptions.some(row =>
          !(managed ? categoryIds.has(row.category) : isServiceCategory(row.category)) || ![null, 0, 1].includes(row.autoRenew))) {
          throw new AppError('备份订阅字段校验失败。');
        }
      }
      if (['9', '10'].includes(schema)) {
        const events = validationDb.prepare('SELECT ' + eventColumns + ' FROM events').all();
        if (events.some(row => typeof row.title !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !REPEATS.includes(row.repeat) ||
          !(row.reminderMinutes === null || REMINDER_OPTIONS.includes(row.reminderMinutes)))) throw new AppError('备份日程字段校验失败。');
        validationDb.prepare('SELECT ' + activityColumns + ' FROM activity_log').all();
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
      for (const name of Object.keys(manifest.files).filter(name => name.startsWith('logos/'))) {
        fs.writeFileSync(path.join(candidateLogos, name.slice('logos/'.length)), entries[name], { flag: 'wx' });
      }
      const previousBackup = await this.createBackup('恢复前自动备份');
      this.db.close();
      const previousDb = path.join(scratch, 'previous.sqlite');
      const previousAttachments = path.join(scratch, 'previous-attachments');
      const previousLogos = path.join(scratch, 'previous-logos');
      let dbMoved = false, filesMoved = false, logosMoved = false;
      try {
        fs.renameSync(this.dbPath, previousDb); dbMoved = true;
        fs.renameSync(this.attachmentDir, previousAttachments); filesMoved = true;
        fs.mkdirSync(this.logoDir, { recursive: true });
        fs.renameSync(this.logoDir, previousLogos); logosMoved = true;
        fs.renameSync(candidatePath, this.dbPath);
        fs.renameSync(candidateAttachments, this.attachmentDir);
        fs.renameSync(candidateLogos, this.logoDir);
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
        if (logosMoved) {
          if (fs.existsSync(this.logoDir)) fs.renameSync(this.logoDir, path.join(scratch, 'failed-logos'));
          fs.renameSync(previousLogos, this.logoDir);
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
    const quotaCategoryNames = new Map(state.quotaCategories.map(({ id, name }) => [id, name]));
    const quotas = state.quotas.filter(item => !item.deletedAt).map(item => `| ${markdownCell(quotaCategoryNames.get(item.category))} | ${item.kind} | ${item.platform} | ${item.account || '—'} | ${item.entryUrl || '—'} | ${item.balance || '—'} | ${item.recordedAt || '—'} | ${item.note || '—'} |`).join('\n');
    const categoryNames = new Map(state.subscriptionCategories.map(({ id, name }) => [id, name]));
    const subscriptions = state.subscriptions.filter(item => !item.deletedAt).map(item => `| ${markdownCell(categoryNames.get(item.category))} | ${item.service} | ${item.account || '—'} | ${item.plan || '—'} | ${item.benefits || '—'} | ${item.status || '—'} | ${item.cost || '—'} | ${item.expiresAt || '—'} | ${autoRenewLabel(item.autoRenew)} | ${item.note || '—'} |`).join('\n');
    const events = state.events.filter(item => !item.deletedAt).map(item => `| ${item.date} | ${timeRange(item)} | ${markdownCell(item.title)} | ${markdownCell(item.location) || '—'} | ${repeatLabel(item)} | ${reminderLabel(item.reminderMinutes)} | ${markdownCell(item.note) || '—'} |`).join('\n');
    const id = stamp();
    const directory = path.join(this.exportDir, id);
    fs.mkdirSync(directory, { recursive: true });
    const entries = {
      '待办.md': strToU8(('# 待办\n\n## 待处理\n\n' + pending + '\n\n## 已完成\n\n' + completed + '\n').replace(/\r?\n/g, '\r\n')),
      '随手记.md': strToU8(('# 随手记\n\n## 随手记录\n\n' + notes + '\n').replace(/\r?\n/g, '\r\n')),
      '日程.md': strToU8(('# 日程\n\n| 日期 | 时间 | 标题 | 地点 | 重复 | 提醒 | 备注 |\n|---|---|---|---|---|---|---|\n' + (events || '| — | — | — | — | — | — | — |') + '\n').replace(/\r?\n/g, '\r\n')),
      '服务与订阅.md': strToU8(('# 服务与订阅记录\n\n## 额度\n\n| 分类 | 类型 | 平台 | 账号 | 入口 | 余额 | 记录 | 备注 |\n|---|---|---|---|---|---|---|---|\n' + (quotas || '| — | — | — | — | — | — | — | — |') + '\n\n## 订阅\n\n| 分类 | 服务 | 账号 | 套餐 | 权益 | 状态 | 费用 | 到期 | 续费 | 备注 |\n|---|---|---|---|---|---|---|---|---|---|\n' + (subscriptions || '| — | — | — | — | — | — | — | — | — | — |') + '\n').replace(/\r?\n/g, '\r\n')),
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
    if (!/^[\w-]+$/.test(id) || !['待办.md', '随手记.md', '日程.md', '服务与订阅.md', 'Folio导出.zip', '日常事务导出.zip'].includes(filename)) throw new AppError('导出文件路径无效。');
    const target = inside(this.exportDir, id + '/' + filename);
    if (!fs.existsSync(target)) throw new AppError('导出文件不存在。', 404);
    return target;
  }
}
for (const name of WRITE_METHODS) {
  const write = Store.prototype[name];
  Store.prototype[name] = function (...args) { return this.transaction(() => write.apply(this, args)); };
}
