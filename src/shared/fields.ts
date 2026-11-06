// 各类型的字段说明。folio help 直接打印这里的内容，命令行也用它把参数转换成正确的类型。

export type FieldType = 'string' | 'text' | 'date' | 'datetime' | 'time' | 'enum' | 'category' | 'boolean|null' | 'number|null' | 'weekdays' | 'dates' | 'boolean'

export type FieldSpec = {
  name: string
  type: FieldType
  label: string
  required?: boolean
  values?: readonly string[]
  note?: string
  example?: string
}

export type KindSpec = {
  kind: 'task' | 'event' | 'quota' | 'subscription'
  label: string
  route: string
  aliases: readonly string[]
  summary: string
  fields: readonly FieldSpec[]
}

export const KIND_SPECS: readonly KindSpec[] = [
  {
    kind: 'task', label: '待办', route: 'tasks', aliases: ['tasks', 'todo', '待办', '事项'],
    summary: '要做完的事。可以带日期或截止时间，正文支持 Markdown，「- [ ] 步骤」会变成可勾选的步骤。',
    fields: [
      { name: 'title', type: 'string', label: '标题', required: true, example: '提交推免材料' },
      { name: 'dateText', type: 'datetime', label: '日期', note: 'YYYY-MM-DD，可加时间 HH:MM，末尾可加「前」表示截止。留空=未定日期', example: '2026-11-10 17:00前' },
      { name: 'bodyMarkdown', type: 'text', label: '正文', note: 'Markdown；「- [ ] 文字」是可勾选步骤', example: '- [ ] 打印成绩单\n- [ ] 找导师签字' },
      { name: 'status', type: 'enum', label: '状态', values: ['pending', 'completed'], note: 'pending=待办，completed=已完成' },
      { name: 'confirmIncomplete', type: 'boolean', label: '确认未完成步骤', note: '把还有未勾步骤的事项标为完成时传 true' },
    ],
  },
  {
    kind: 'event', label: '日程', route: 'events', aliases: ['events', 'schedule', '日程', '安排'],
    summary: '有日期的安排，可以带时间段、地点、重复和提醒（Windows 通知）。没有开始时间就是全天日程。',
    fields: [
      { name: 'title', type: 'string', label: '标题', required: true, example: '家教：初一数学' },
      { name: 'date', type: 'date', label: '日期', required: true, note: 'YYYY-MM-DD；重复日程填第一次的日期', example: '2026-11-07' },
      { name: 'startTime', type: 'time', label: '开始', note: 'HH:MM；留空=全天', example: '19:00' },
      { name: 'endTime', type: 'time', label: '结束', note: 'HH:MM；需要先有开始时间', example: '21:00' },
      { name: 'location', type: 'string', label: '地点', example: '铁城村4栋' },
      { name: 'note', type: 'text', label: '备注' },
      { name: 'repeat', type: 'enum', label: '重复', values: ['none', 'daily', 'weekly'], note: 'none=不重复（默认），daily=每天，weekly=每周' },
      { name: 'repeatDays', type: 'weekdays', label: '每周哪几天', note: 'weekly 时用，0=周日 1=周一 … 6=周六；留空=和 date 同一天', example: '5,6' },
      { name: 'repeatUntil', type: 'date', label: '重复到', note: 'YYYY-MM-DD，留空=一直重复' },
      { name: 'skippedDates', type: 'dates', label: '跳过的日期', note: '逗号分隔；单独跳过一次也可以用 folio skip' },
      { name: 'reminderMinutes', type: 'number|null', label: '提醒', values: ['null', '0', '10', '30', '60', '90', '120'], note: '提前多少分钟弹通知；0=准时，null=不提醒（默认）；需要开始时间', example: '90' },
    ],
  },
  {
    kind: 'quota', label: '额度', route: 'quotas', aliases: ['quotas', '额度', '余额'],
    summary: '各平台的余额或额度。',
    fields: [
      { name: 'platform', type: 'string', label: '平台', required: true, example: 'OpenRouter' },
      { name: 'kind', type: 'enum', label: '类型', values: ['官方', '中转'], note: '默认 官方' },
      { name: 'category', type: 'category', label: '分类', note: '写分类名或 id，见 folio categories quota；默认 其他' },
      { name: 'account', type: 'string', label: '账号', note: '登录邮箱' },
      { name: 'balance', type: 'string', label: '余额', example: '$12.50' },
      { name: 'recordedAt', type: 'date', label: '记录日期', note: 'YYYY-MM-DD' },
      { name: 'entryUrl', type: 'string', label: '入口 URL' },
      { name: 'note', type: 'text', label: '备注' },
    ],
  },
  {
    kind: 'subscription', label: '订阅', route: 'subscriptions', aliases: ['subscriptions', 'sub', '订阅'],
    summary: '有到期日的服务或套餐。到期前 7 天和 1 天会弹通知。',
    fields: [
      { name: 'service', type: 'string', label: '服务', required: true, example: 'ChatGPT' },
      { name: 'category', type: 'category', label: '分类', note: '写分类名或 id，见 folio categories subscription；默认 其他' },
      { name: 'account', type: 'string', label: '账号', note: '登录邮箱' },
      { name: 'plan', type: 'string', label: '套餐', example: 'Plus' },
      { name: 'cost', type: 'string', label: '费用', example: '$20/月' },
      { name: 'expiresAt', type: 'date', label: '到期日', note: 'YYYY-MM-DD' },
      { name: 'autoRenew', type: 'boolean|null', label: '自动续费', values: ['true', 'false', 'null'], note: 'null=未记录' },
      { name: 'benefits', type: 'string', label: '权益' },
      { name: 'status', type: 'string', label: '状态' },
      { name: 'entryUrl', type: 'string', label: '入口 URL' },
      { name: 'note', type: 'text', label: '备注' },
    ],
  },
]

export function kindSpec(name: string): KindSpec | undefined {
  const key = name.trim().toLowerCase()
  return KIND_SPECS.find(spec => spec.kind === key || spec.aliases.includes(key))
}
