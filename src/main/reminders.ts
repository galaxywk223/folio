import { Notification } from 'electron'
import fs from 'node:fs'
import { addDays, dueReminders, leadLabel, localDate, timeRange } from '../shared/schedule'
import type { ScheduleEvent } from '../shared/schedule'

type SubscriptionLike = { id: string; service: string; account: string; expiresAt: string; deletedAt: string | null }
export type ReminderStore = { state(): { events: ScheduleEvent[]; subscriptions: SubscriptionLike[] } }
export type NavigateTarget = { kind: 'event' | 'subscription'; id: string; date?: string }

const TICK_MS = 30_000
/** 睡眠或卡顿后，只补发这么久以内错过的提醒。 */
const CATCH_UP_MS = 15 * 60_000
const SUBSCRIPTION_HOUR = 9
const SUBSCRIPTION_LEADS = [7, 1]

export class ReminderScheduler {
  private timer: NodeJS.Timeout | null = null
  private lastTick = new Date()
  // 通知对象需要保持引用，否则 Windows 上点击事件可能失效。
  private readonly shown = new Set<Notification>()

  constructor(private readonly options: {
    store: ReminderStore
    statePath: string
    onOpen: (target: NavigateTarget) => void
    onError?: (error: unknown) => void
  }) {}

  start(): void {
    if (this.timer || !Notification.isSupported()) return
    this.lastTick = new Date()
    this.timer = setInterval(() => this.tick(), TICK_MS)
    this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  tick(now = new Date()): void {
    try {
      const state = this.options.store.state()
      const since = new Date(Math.max(this.lastTick.getTime(), now.getTime() - CATCH_UP_MS))
      this.lastTick = now
      for (const { event, date } of dueReminders(state.events, since, now)) {
        const body = [leadLabel(event.reminderMinutes), timeRange(event), event.location].filter(Boolean).join(' · ')
        this.notify(event.title, body, { kind: 'event', id: event.id, date })
      }
      this.checkSubscriptions(state.subscriptions, now)
    } catch (error) {
      this.options.onError?.(error)
    }
  }

  private checkSubscriptions(subscriptions: SubscriptionLike[], now: Date): void {
    const today = localDate(now)
    if (now.getHours() < SUBSCRIPTION_HOUR || this.readState().subscriptionsNotifiedOn === today) return
    for (const lead of SUBSCRIPTION_LEADS) {
      const target = addDays(today, lead)
      for (const item of subscriptions) {
        if (item.deletedAt || item.expiresAt !== target) continue
        const name = item.service + (item.account ? ' · ' + item.account : '')
        this.notify('订阅' + (lead === 1 ? '明天' : lead + ' 天后') + '到期', name + '，到期日 ' + item.expiresAt, { kind: 'subscription', id: item.id })
      }
    }
    this.writeState({ subscriptionsNotifiedOn: today })
  }

  private notify(title: string, body: string, target: NavigateTarget): void {
    const notification = new Notification({ title, body })
    this.shown.add(notification)
    const release = () => this.shown.delete(notification)
    notification.on('click', () => { release(); this.options.onOpen(target) })
    notification.on('close', release)
    notification.show()
  }

  private readState(): { subscriptionsNotifiedOn?: string } {
    try { return JSON.parse(fs.readFileSync(this.options.statePath, 'utf8')) } catch { return {} }
  }

  private writeState(value: { subscriptionsNotifiedOn: string }): void {
    try { fs.writeFileSync(this.options.statePath, JSON.stringify(value)) } catch (error) { this.options.onError?.(error) }
  }
}
