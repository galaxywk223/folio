// folio 命令行：连接正在运行的 Folio（没运行就在后台启动它），用 JSON 读写待办、日程、额度和订阅。
// 设计给人和本地智能体共用：输出都是 JSON，folio help 列出全部字段，出错时 stderr 打印 {"error": ...} 并以 1 退出。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { KIND_SPECS, kindSpec } from '../shared/fields'
import type { FieldSpec, KindSpec } from '../shared/fields'
import { addDays, localDate, occurrencesBetween, upcomingOccurrences } from '../shared/schedule'
import type { ScheduleEvent } from '../shared/schedule'

const VERSION = typeof __FOLIO_VERSION__ === 'string' ? __FOLIO_VERSION__ : 'dev'
declare const __FOLIO_VERSION__: string
const START_TIMEOUT_MS = 15_000

class CliError extends Error {
  constructor(message: string, readonly code = 'CLI_ERROR') { super(message) }
}

type Args = { positional: string[]; options: Record<string, string | true> }
type Entity = Record<string, unknown> & { id: string; deletedAt: string | null }
type State = {
  tasks: Entity[]; events: (Entity & ScheduleEvent)[]; quotas: Entity[]; subscriptions: Entity[]
  subscriptionCategories: { id: string; name: string }[]; quotaCategories: { id: string; name: string }[]
}

// ---------- 参数 ----------

export function parseArgs(argv: string[]): Args {
  const positional: string[] = []
  const options: Record<string, string | true> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') { positional.push(...argv.slice(index + 1)); break }
    if (!arg.startsWith('--') || arg === '-') { positional.push(arg); continue }
    const eq = arg.indexOf('=')
    const key = camel(eq > 0 ? arg.slice(2, eq) : arg.slice(2))
    if (eq > 0) { options[key] = arg.slice(eq + 1); continue }
    const next = argv[index + 1]
    if (next !== undefined && (!next.startsWith('--') || next === '-')) { options[key] = next; index += 1 }
    else options[key] = true
  }
  return { positional, options }
}
const camel = (value: string) => value.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())

function readJsonOption(value: string | true): Record<string, unknown> {
  const text = value === '-' ? fs.readFileSync(0, 'utf8') : value === true ? '' : value
  if (!text.trim()) throw new CliError('--json 需要一个 JSON 对象，或用 --json - 从标准输入读取。', 'BAD_JSON')
  let parsed: unknown
  try { parsed = JSON.parse(text.replace(/^﻿/, '')) } catch (error) { throw new CliError('JSON 解析失败：' + (error as Error).message, 'BAD_JSON') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new CliError('--json 需要一个 JSON 对象。', 'BAD_JSON')
  return parsed as Record<string, unknown>
}

function coerce(field: FieldSpec | undefined, value: string | true): unknown {
  if (value === true) return field?.type === 'boolean' || field?.type === 'boolean|null' ? true : ''
  if (!field) return value
  if (field.type === 'boolean') return value === 'true' || value === '1'
  if (field.type === 'boolean|null') return value === 'null' || value === '' ? null : value === 'true' || value === '1' ? true : value === 'false' || value === '0' ? false : value
  if (field.type === 'number|null') return value === 'null' || value === '' ? null : /^\d+$/.test(value) ? Number(value) : value
  return value.replace(/\\n/g, '\n')
}

/** 合并 --json 与 --字段 值；--字段 优先。 */
function bodyFrom(spec: KindSpec, options: Record<string, string | true>): Record<string, unknown> {
  const body: Record<string, unknown> = options.json !== undefined ? readJsonOption(options.json) : {}
  for (const [key, value] of Object.entries(options)) {
    if (key === 'json' || key === 'dataDir') continue
    const field = spec.fields.find(item => item.name === key)
    if (!field) throw new CliError(spec.label + '没有字段「' + key + '」。可用字段：' + spec.fields.map(item => item.name).join(', ') + '。运行 folio help ' + spec.kind + ' 查看说明。', 'UNKNOWN_FIELD')
    body[key] = coerce(field, value)
  }
  return body
}

// ---------- 连接 ----------

function dataRoot(options: Record<string, string | true>): string {
  if (typeof options.dataDir === 'string') return path.resolve(options.dataDir)
  if (process.env.FOLIO_DATA_DIR) return path.resolve(process.env.FOLIO_DATA_DIR)
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Folio')
}

function readService(root: string): { port: number; pid: number } | null {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, 'app', 'data', 'service.json'), 'utf8'))
    if (!Number.isInteger(value.port) || !Number.isInteger(value.pid)) return null
    process.kill(value.pid, 0)
    return value
  } catch { return null }
}

async function healthy(port: number): Promise<boolean> {
  try { return (await fetch('http://127.0.0.1:' + port + '/api/health')).ok } catch { return false }
}

function launchFolio(): boolean {
  if (process.env.FOLIO_NO_AUTOSTART) return false
  // 安装后本文件在 <安装目录>/resources/bin/ 下。
  const exe = path.resolve(__dirname, '..', '..', 'Folio.exe')
  if (!fs.existsSync(exe)) return false
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  spawn(exe, ['--hidden'], { detached: true, stdio: 'ignore', env, windowsHide: false }).unref()
  return true
}

async function connect(root: string): Promise<string> {
  let service = readService(root)
  if (service && await healthy(service.port)) return 'http://127.0.0.1:' + service.port
  if (!launchFolio()) throw new CliError('Folio 没有在运行，请先打开 Folio（数据目录：' + root + '）。', 'NOT_RUNNING')
  const deadline = Date.now() + START_TIMEOUT_MS
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 300))
    service = readService(root)
    if (service && await healthy(service.port)) return 'http://127.0.0.1:' + service.port
  }
  throw new CliError('已尝试在后台启动 Folio，但 15 秒内没有就绪。请手动打开 Folio 后重试。', 'START_TIMEOUT')
}

class Client {
  constructor(private readonly base: string) {}
  async call<T>(method: string, route: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { 'X-Folio-App': '1', 'X-Folio-Source': 'cli' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const response = await fetch(this.base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string; code?: string }
      throw new CliError(data.error || '请求失败（HTTP ' + response.status + '）。', data.code || 'HTTP_' + response.status)
    }
    return response.status === 204 ? undefined as T : await response.json() as T
  }
  state() { return this.call<State>('GET', '/api/state') }
  async upload<T>(method: string, route: string, field: string, filename: string, bytes: Uint8Array<ArrayBuffer>): Promise<T> {
    const form = new FormData()
    form.append(field, new Blob([bytes]), filename)
    const response = await fetch(this.base + route, { method, headers: { 'X-Folio-App': '1', 'X-Folio-Source': 'cli' }, body: form })
    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string; code?: string }
      throw new CliError(data.error || '请求失败（HTTP ' + response.status + '）。', data.code || 'HTTP_' + response.status)
    }
    return await response.json() as T
  }
}

// folio logo <类型> <id> <图片路径>，或 --remove 移除。
async function setLogo(client: Client, spec: KindSpec, id: string, file: string | undefined, remove: boolean) {
  const record = findEntity(await client.state(), spec, id)
  const route = '/api/' + spec.route + '/' + encodeURIComponent(record.id) + '/logo'
  if (remove) return client.call('DELETE', route)
  if (!file) throw new CliError('需要图片路径：folio logo ' + spec.kind + ' <id> <图片路径>；移除用 --remove。', 'MISSING_FILE')
  const absolute = path.resolve(process.cwd(), file)
  let bytes: Uint8Array<ArrayBuffer>
  try { bytes = new Uint8Array(fs.readFileSync(absolute)) }
  catch { throw new CliError('读不到图片文件：' + absolute, 'FILE_NOT_FOUND') }
  return client.upload('PUT', route, 'logo', path.basename(absolute), bytes)
}

// ---------- 命令 ----------

function requireSpec(name: string | undefined): KindSpec {
  const spec = name ? kindSpec(name) : undefined
  if (!spec) throw new CliError('需要类型：' + KIND_SPECS.map(item => item.kind + '（' + item.label + '）').join('、') + '。', 'UNKNOWN_KIND')
  return spec
}
function requireId(id: string | undefined): string {
  if (!id) throw new CliError('需要 id。可以写完整 id，也可以写唯一前缀（至少 6 位）；用 folio list 查看。', 'MISSING_ID')
  return id
}
const listOf = (state: State, spec: KindSpec): Entity[] => state[spec.route as 'tasks' | 'events' | 'quotas' | 'subscriptions']

function findEntity(state: State, spec: KindSpec, id: string): Entity {
  const rows = listOf(state, spec)
  const exact = rows.find(row => row.id === id)
  if (exact) return exact
  const matches = id.length >= 6 ? rows.filter(row => row.id.startsWith(id)) : []
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) throw new CliError('id 前缀匹配到多条：' + matches.map(row => row.id).join('、'), 'AMBIGUOUS_ID')
  throw new CliError(spec.label + '不存在：' + id, 'NOT_FOUND')
}

function categoryFilter(state: State, spec: KindSpec, value: string): string {
  const categories = spec.kind === 'quota' ? state.quotaCategories : state.subscriptionCategories
  const match = categories.find(row => row.id === value || row.name.toLowerCase() === value.toLowerCase())
  if (!match) throw new CliError('分类不存在：' + value + '。可用分类：' + categories.map(row => row.name).join('、'), 'UNKNOWN_CATEGORY')
  return match.id
}

const dateOption = (value: string | true | undefined, fallback: string) => {
  if (value === undefined || value === true) return fallback
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new CliError('日期应为 YYYY-MM-DD：' + value, 'BAD_DATE')
  return value
}

function list(state: State, spec: KindSpec, options: Record<string, string | true>): unknown {
  const deleted = options.deleted === true
  let rows = listOf(state, spec).filter(row => deleted ? !!row.deletedAt : !row.deletedAt)
  if (spec.kind === 'task' && typeof options.status === 'string') rows = rows.filter(row => row.status === options.status)
  if ((spec.kind === 'quota' || spec.kind === 'subscription') && typeof options.category === 'string') {
    const id = categoryFilter(state, spec, options.category)
    rows = rows.filter(row => row.category === id)
  }
  if (spec.kind === 'event' && !deleted && options.all !== true) {
    const events = rows as (Entity & ScheduleEvent)[]
    if (options.from === undefined && options.to === undefined) {
      return upcomingOccurrences(events, localDate()).map(({ event, date }) => ({ occurrence: date, ...event }))
    }
    const from = dateOption(options.from, localDate())
    const to = dateOption(options.to, addDays(from, 13))
    if (to < from) throw new CliError('--to 不能早于 --from。', 'BAD_DATE')
    return occurrencesBetween(events, from, to).map(({ event, date }) => ({ occurrence: date, ...event }))
  }
  return rows
}

function today(state: State) {
  const date = localDate()
  const soon = addDays(date, 7)
  return {
    date,
    events: occurrencesBetween(state.events, date, date).map(({ event }) => event),
    tasks: state.tasks.filter(task => !task.deletedAt && task.status === 'pending' && typeof task.dateText === 'string' && task.dateText && task.dateText.slice(0, 10) <= date),
    subscriptions: state.subscriptions.filter(item => !item.deletedAt && typeof item.expiresAt === 'string' && item.expiresAt >= date && item.expiresAt <= soon),
  }
}

function search(state: State, keyword: string) {
  const needle = keyword.toLowerCase()
  return KIND_SPECS.flatMap(spec => listOf(state, spec)
    .filter(row => !row.deletedAt && Object.values(row).some(value => typeof value === 'string' && value.toLowerCase().includes(needle)))
    .map(row => ({ type: spec.kind, ...row })))
}

export function helpText(name?: string): string {
  if (name) {
    const spec = requireSpec(name)
    const lines = [spec.kind + '（' + spec.label + '）：' + spec.summary, '', '字段（写入时用 --字段 值，或 --json \'{"字段": 值}\'）：']
    for (const field of spec.fields) {
      lines.push('  ' + field.name + (field.required ? '（必填）' : '') + ' — ' + field.label + '。' + (field.values ? '可选值：' + field.values.join(' / ') + '。' : '') + (field.note ? field.note + '。' : '') + (field.example ? '例：' + JSON.stringify(field.example) : ''))
    }
    lines.push('', 'logo：不能用 --字段 写，用 folio logo ' + spec.kind + ' <id> <图片路径> 设置，--remove 移除。支持 PNG、JPG、WebP、SVG、ICO，最大 1 MB；没设置时显示首字母。')
    return lines.join('\n')
  }
  return [
    'folio ' + VERSION + ' — 读写本机 Folio 里的待办、日程、额度和订阅。除 help 外，输出都是 JSON。',
    '',
    '类型：' + KIND_SPECS.map(spec => spec.kind + '（' + spec.label + '）').join('、'),
    '',
    '命令：',
    '  folio help [类型]                         查看命令，或某个类型的全部字段',
    '  folio today                               今天的日程、到期待办、7 天内到期的订阅',
    '  folio list <类型> [选项]                   列表。--deleted 只看回收站；task 可加 --status pending|completed；',
    '                                            quota/subscription 可加 --category 分类名；event 默认列出今天起的全部日程，',
    '                                            重复日程只展开 14 天；可用 --from/--to YYYY-MM-DD 指定范围，--all 列出日程本身（不展开）',
    '  folio get <类型> <id>                      查看一条',
    '  folio search <关键词>                      在所有类型里搜索',
    '  folio add <类型> --字段 值 …               新建；也可以 --json \'{…}\'，或 --json - 从标准输入读 JSON',
    '  folio update <类型> <id> --字段 值 …       只修改给出的字段（同样支持 --json）',
    '  folio delete <类型> <id>                   移入回收站',
    '  folio restore <类型> <id>                  从回收站恢复',
    '  folio skip <日程id> --date YYYY-MM-DD      跳过某一次（重复、不重复的日程都行），不再提醒',
    '  folio unskip <日程id> --date YYYY-MM-DD    恢复跳过的那一次',
    '  folio categories <quota|subscription>      分类列表（写入时 category 可以直接写分类名）',
    '  folio logo <类型> <id> <图片路径>           设置 logo（PNG/JPG/WebP/SVG/ICO，≤1 MB）；--remove 移除，恢复首字母',
    '  folio log [--limit 20] [--kind 类型]       改动记录',
    '',
    '说明：',
    '  · id 可以写唯一前缀（至少 6 位）。字段名也可以写成 kebab 形式，如 --start-time。',
    '  · 多行或含引号的内容建议用 --json -，把 JSON 从标准输入传进来，避免命令行转义问题。',
    '  · 写入记为「命令行」来源，可以在 Folio 的「改动记录」里查看和核对。',
    '  · Folio 没在运行时会自动在后台启动（只进托盘）。',
    '',
    '例：',
    '  folio add event --title "家教：初一数学" --date 2026-11-07 --start-time 19:00 --end-time 21:00 --location 铁城村4栋 --repeat weekly --repeat-days 5 --reminder-minutes 90',
    '  folio add task --title "提交推免材料" --date-text "2026-11-10 17:00前"',
    '  folio list event --from 2026-11-01 --to 2026-11-30',
    '  folio logo subscription 2699d9a8 ./logos/claude.png',
  ].join('\n')
}

export async function run(argv: string[]): Promise<unknown> {
  const { positional, options } = parseArgs(argv)
  const [command = 'help', ...rest] = positional
  if (command === 'help' || options.help === true) return { text: helpText(command === 'help' ? rest[0] : positional[1] ? positional[1] : undefined) }
  if (command === 'version' || command === '--version') return { version: VERSION }
  const client = new Client(await connect(dataRoot(options)))
  switch (command) {
    case 'today': return today(await client.state())
    case 'list': { const spec = requireSpec(rest[0]); return list(await client.state(), spec, options) }
    case 'get': { const spec = requireSpec(rest[0]); return findEntity(await client.state(), spec, requireId(rest[1])) }
    case 'search': {
      const keyword = rest.join(' ').trim()
      if (!keyword) throw new CliError('需要关键词：folio search <关键词>。', 'MISSING_KEYWORD')
      return search(await client.state(), keyword)
    }
    case 'add': case 'create': case 'new': {
      const spec = requireSpec(rest[0])
      return client.call('POST', '/api/' + spec.route, bodyFrom(spec, options))
    }
    case 'update': case 'edit': case 'set': {
      const spec = requireSpec(rest[0])
      const id = requireId(rest[1])
      const body = bodyFrom(spec, options)
      if (!Object.keys(body).length) throw new CliError('没有要修改的字段。运行 folio help ' + spec.kind + ' 查看字段。', 'NOTHING_TO_UPDATE')
      return client.call('PATCH', '/api/' + spec.route + '/' + encodeURIComponent(id), body)
    }
    case 'delete': case 'remove': case 'rm': {
      const spec = requireSpec(rest[0])
      const record = findEntity(await client.state(), spec, requireId(rest[1]))
      await client.call('DELETE', '/api/' + spec.route + '/' + encodeURIComponent(record.id))
      return { deleted: true, type: spec.kind, id: record.id }
    }
    case 'restore': {
      const spec = requireSpec(rest[0])
      const id = requireId(rest[1])
      await client.call('POST', '/api/trash/' + spec.kind + '/' + encodeURIComponent(id) + '/restore')
      return findEntity(await client.state(), spec, id)
    }
    case 'skip': case 'unskip': {
      const id = requireId(rest[0])
      if (typeof options.date !== 'string') throw new CliError('需要 --date YYYY-MM-DD。', 'BAD_DATE')
      return client.call('POST', '/api/events/' + encodeURIComponent(id) + '/' + command, { date: options.date })
    }
    case 'categories': {
      const spec = requireSpec(rest[0] ?? 'subscription')
      if (spec.kind !== 'quota' && spec.kind !== 'subscription') throw new CliError('只有 quota 和 subscription 有分类。', 'UNKNOWN_KIND')
      const state = await client.state()
      return spec.kind === 'quota' ? state.quotaCategories : state.subscriptionCategories
    }
    case 'logo': {
      const spec = requireSpec(rest[0])
      return setLogo(client, spec, requireId(rest[1]), rest[2], options.remove === true)
    }
    case 'log': case 'activity': {
      const params = new URLSearchParams({ limit: typeof options.limit === 'string' ? options.limit : '20' })
      if (typeof options.kind === 'string') params.set('kind', requireSpec(options.kind).kind)
      return client.call('GET', '/api/activity?' + params)
    }
    default:
      throw new CliError('未知命令：' + command + '。运行 folio help 查看全部命令。', 'UNKNOWN_COMMAND')
  }
}

async function main() {
  try {
    const result = await run(process.argv.slice(2))
    if (result && typeof result === 'object' && 'text' in result && Object.keys(result).length === 1) process.stdout.write((result as { text: string }).text + '\n')
    else process.stdout.write(JSON.stringify(result ?? null, null, 2) + '\n')
  } catch (error) {
    const known = error instanceof CliError
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(JSON.stringify({ error: message, code: known ? error.code : 'UNEXPECTED' }, null, 2) + '\n')
    process.exitCode = 1
  }
}

if (require.main === module) void main()
