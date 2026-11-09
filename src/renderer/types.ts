import type { Repeat, ScheduleEvent } from '../shared/schedule';
import type { SubscriptionCategory } from '../shared/subscriptions';

export type Kind = 'task' | 'quota' | 'subscription' | 'event';
export type View = 'today' | 'schedule' | 'pending' | 'completed' | 'quotas' | 'subscriptions' | 'trash' | 'activity' | 'settings';
export type Task = {
  id: string; title: string; dateText: string; bodyMarkdown: string; status: 'pending' | 'completed';
  sortOrder: number; completedAt: string | null; createdAt: string; updatedAt: string; deletedAt: string | null; version: number;
};
export type Note = { id: string; title: string; bodyMarkdown: string; createdAt: string; updatedAt: string; deletedAt: string | null; version: number };
export type Attachment = { id: string; filename: string; storagePath: string; size: number; createdAt: string; deletedAt: string | null };
export type Link = { attachmentId: string; ownerType: 'task' | 'note'; ownerId: string };
export type ApiQuota = {
  id: string; kind: '官方' | '中转'; category: string; platform: string; account: string; entryUrl: string; balance: string; recordedAt: string;
  note: string; createdAt: string; updatedAt: string; deletedAt: string | null; version: number;
};
export type Subscription = {
  id: string; service: string; account: string; plan: string; benefits: string; status: string; cost: string;
  category: string; autoRenew: boolean | null;
  expiresAt: string; entryUrl: string; note: string; createdAt: string; updatedAt: string; deletedAt: string | null; version: number;
};
export type EventItem = ScheduleEvent & { createdAt: string; updatedAt: string; version: number };
export type EventDraft = {
  title: string; date: string; startTime: string; endTime: string; location: string; note: string;
  repeat: Repeat; repeatDays: number[]; repeatUntil: string; reminderMinutes: number | null; version?: number;
};
export type Activity = {
  id: number; at: string; source: string; action: 'create' | 'update' | 'delete' | 'restore' | 'skip';
  kind: Kind | 'note'; itemId: string; title: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null;
};
export type State = {
  tasks: Task[]; events: EventItem[]; notes: Note[]; attachments: Attachment[]; links: Link[];
  quotas: ApiQuota[]; subscriptions: Subscription[]; subscriptionCategories: SubscriptionCategory[]; quotaCategories: SubscriptionCategory[];
  migration: { tasks: number; steps: number; notes: number; attachments: number; sourceHashes: Record<string, string> } | null;
};
// 重复日程会在多天出现，date 用来区分选中的是哪一天。
export type Selection = { kind: Kind; id: string; date?: string };
export type EditorValue = { title: string; dateText?: string; bodyMarkdown: string; version?: number };
export type QuotaDraft = { kind: '官方' | '中转'; category: string; platform: string; account: string; entryUrl: string; balance: string; recordedAt: string; note: string; version?: number };
export type SubscriptionDraft = {
  service: string; account: string; plan: string; benefits: string; status: string; cost: string;
  category: string; autoRenew: boolean | null;
  expiresAt: string; entryUrl: string; note: string; version?: number;
};
export type Backup = { id: string; filename: string; createdAt: string; size: number };
export type Entity = Task | ApiQuota | Subscription | EventItem;
export type Item = Selection & { title: string; subtitle: string; entity: Entity; group?: string };
