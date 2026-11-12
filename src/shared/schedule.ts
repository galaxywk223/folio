// 日程的重复与提醒计算，界面、主进程提醒和命令行共用。全部按本机时区计算。

export type Repeat = 'none' | 'daily' | 'weekly'

export type ScheduleEvent = {
  id: string
  title: string
  date: string
  startTime: string
  endTime: string
  location: string
  note: string
  repeat: Repeat
  repeatDays: number[]
  repeatUntil: string
  skippedDates: string[]
  reminderMinutes: number | null
  deletedAt: string | null
}

export type Occurrence<T extends ScheduleEvent = ScheduleEvent> = { event: T; date: string }

export const REPEATS: readonly Repeat[] = ['none', 'daily', 'weekly']
export const REMINDER_OPTIONS: readonly number[] = [0, 10, 30, 60, 90, 120]
export const WEEKDAY_NAMES = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const
export const REPEAT_WINDOW_DAYS = 14
const MAX_RANGE_DAYS = 400

const pad = (value: number) => String(value).padStart(2, '0')

export function localDate(value: Date = new Date()): string {
  return value.getFullYear() + '-' + pad(value.getMonth() + 1) + '-' + pad(value.getDate())
}

export function parseLocalDate(date: string): Date {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(year, month - 1, day)
}

export function addDays(date: string, days: number): string {
  const value = parseLocalDate(date)
  value.setDate(value.getDate() + days)
  return localDate(value)
}

export function weekdayOf(date: string): number {
  return parseLocalDate(date).getDay()
}

export function weekdayLabel(date: string): string {
  return WEEKDAY_NAMES[weekdayOf(date)]
}

/** 重复日程没写星期时，按第一次发生那天的星期重复。 */
export function effectiveRepeatDays(event: Pick<ScheduleEvent, 'date' | 'repeatDays'>): number[] {
  return event.repeatDays.length ? event.repeatDays : [weekdayOf(event.date)]
}

export function occursOn(event: ScheduleEvent, date: string): boolean {
  if (event.deletedAt || date < event.date) return false
  if (event.repeatUntil && date > event.repeatUntil) return false
  if (event.skippedDates.includes(date)) return false
  if (event.repeat === 'none') return date === event.date
  if (event.repeat === 'daily') return true
  return effectiveRepeatDays(event).includes(weekdayOf(date))
}

export function compareOccurrences(a: Occurrence, b: Occurrence): number {
  return a.date.localeCompare(b.date)
    || a.event.startTime.localeCompare(b.event.startTime)
    || a.event.title.localeCompare(b.event.title)
}

/** from、to 都包含在内。 */
export function occurrencesBetween<T extends ScheduleEvent>(events: readonly T[], from: string, to: string): Occurrence<T>[] {
  const result: Occurrence<T>[] = []
  let date = from
  for (let index = 0; date <= to && index < MAX_RANGE_DAYS; index += 1, date = addDays(date, 1)) {
    for (const event of events) if (occursOn(event, date)) result.push({ event, date })
  }
  return result.sort(compareOccurrences)
}

/**
 * 「日程」页和命令行默认看的范围：不重复的日程从今天起全部列出；重复日程只展开 repeatWindowDays 天，
 * 起始日在窗口之后的重复日程列出它的第一次，免得看不到。
 */
export function upcomingOccurrences<T extends ScheduleEvent>(events: readonly T[], from: string, repeatWindowDays: number = REPEAT_WINDOW_DAYS): Occurrence<T>[] {
  const windowEnd = addDays(from, repeatWindowDays - 1)
  const result: Occurrence<T>[] = []
  for (const event of events) {
    if (event.deletedAt) continue
    if (event.repeat === 'none') {
      if (event.date >= from && occursOn(event, event.date)) result.push({ event, date: event.date })
      continue
    }
    const inWindow = occurrencesBetween([event], from, windowEnd)
    if (inWindow.length) { result.push(...inWindow); continue }
    if (event.date <= windowEnd) continue
    const first = occurrencesBetween([event], event.date, addDays(event.date, MAX_RANGE_DAYS))[0]
    if (first) result.push(first)
  }
  return result.sort(compareOccurrences)
}

export function startAt(event: Pick<ScheduleEvent, 'startTime'>, date: string): Date | null {
  if (!event.startTime) return null
  const [hours, minutes] = event.startTime.split(':').map(Number)
  const value = parseLocalDate(date)
  value.setHours(hours, minutes, 0, 0)
  return value
}

export function reminderAt(event: Pick<ScheduleEvent, 'startTime' | 'reminderMinutes'>, date: string): Date | null {
  const start = startAt(event, date)
  if (!start || event.reminderMinutes === null) return null
  return new Date(start.getTime() - event.reminderMinutes * 60_000)
}

/** 提醒时间落在 (since, until] 内的日程。提醒最多提前两小时，所以多看一天。 */
export function dueReminders<T extends ScheduleEvent>(events: readonly T[], since: Date, until: Date): Occurrence<T>[] {
  if (until <= since) return []
  const candidates = occurrencesBetween(events, localDate(since), addDays(localDate(until), 1))
  return candidates.filter(({ event, date }) => {
    const at = reminderAt(event, date)
    return at !== null && at > since && at <= until
  })
}

export function timeRange(event: Pick<ScheduleEvent, 'startTime' | 'endTime'>): string {
  if (!event.startTime) return '全天'
  return event.endTime ? event.startTime + '–' + event.endTime : event.startTime
}

export function repeatLabel(event: Pick<ScheduleEvent, 'repeat' | 'repeatDays' | 'date' | 'repeatUntil'>): string {
  if (event.repeat === 'none') return '不重复'
  const base = event.repeat === 'daily' ? '每天'
    : '每' + effectiveRepeatDays(event).slice().sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map(day => WEEKDAY_NAMES[day]).join('、')
  return event.repeatUntil ? base + '，到 ' + event.repeatUntil : base
}

export function reminderLabel(minutes: number | null): string {
  if (minutes === null) return '不提醒'
  if (minutes === 0) return '准时'
  if (minutes < 60) return '提前 ' + minutes + ' 分钟'
  return '提前 ' + (minutes / 60) + ' 小时'
}

/** 提醒通知里的"多久后开始"。 */
export function leadLabel(minutes: number | null): string {
  if (!minutes) return '现在开始'
  if (minutes < 60) return minutes + ' 分钟后开始'
  return (minutes / 60) + ' 小时后开始'
}
