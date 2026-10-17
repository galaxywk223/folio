export type Kind = 'task' | 'note' | 'attachment' | 'quota' | 'subscription';
export type View = 'pending' | 'completed' | 'notes' | 'attachments' | 'quotas' | 'subscriptions' | 'trash';
export type Task = {
  id: string; title: string; dateText: string; bodyMarkdown: string; status: 'pending' | 'completed';
  sortOrder: number; completedAt: string | null; createdAt: string; updatedAt: string; deletedAt: string | null; version: number;
};
export type Note = { id: string; title: string; bodyMarkdown: string; createdAt: string; updatedAt: string; deletedAt: string | null; version: number };
export type Attachment = { id: string; filename: string; storagePath: string; size: number; createdAt: string; deletedAt: string | null };
export type Link = { attachmentId: string; ownerType: 'task' | 'note'; ownerId: string };
export type ApiQuota = {
  id: string; kind: '官方' | '中转'; platform: string; entryUrl: string; balance: string; recordedAt: string;
  note: string; createdAt: string; updatedAt: string; deletedAt: string | null; version: number;
};
export type Subscription = {
  id: string; service: string; account: string; plan: string; benefits: string; status: string; cost: string;
  expiresAt: string; entryUrl: string; note: string; createdAt: string; updatedAt: string; deletedAt: string | null; version: number;
};
export type State = {
  tasks: Task[]; notes: Note[]; attachments: Attachment[]; links: Link[];
  quotas: ApiQuota[]; subscriptions: Subscription[];
  migration: { tasks: number; steps: number; notes: number; attachments: number; sourceHashes: Record<string, string> } | null;
};
export type Selection = { kind: Kind; id: string };
export type EditorValue = { title: string; dateText?: string; bodyMarkdown: string; version?: number };
export type QuotaDraft = { kind: '官方' | '中转'; platform: string; entryUrl: string; balance: string; recordedAt: string; note: string; version?: number };
export type SubscriptionDraft = {
  service: string; account: string; plan: string; benefits: string; status: string; cost: string;
  expiresAt: string; entryUrl: string; note: string; version?: number;
};
export type Backup = { id: string; filename: string; createdAt: string; size: number };
