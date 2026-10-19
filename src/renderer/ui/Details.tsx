import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ArchiveRestore, ArrowLeft, CalendarDays, Check, CheckCircle2, ExternalLink, MoreHorizontal, PencilLine, Trash2 } from 'lucide-react';
import { getSteps } from '../../shared/markdown';
import { autoRenewLabel, subscriptionCategories } from '../../shared/subscriptions';
import { dateTime, openExternal } from '../api';
import { Markdown } from '../components';
import { expiryClass, expiryLabel } from '../format';
import type { ApiQuota, Item, Subscription, Task } from '../types';

export function DetailToolbar({ caption, onClose, onEdit, onDelete }: { caption: string; onClose: () => void; onEdit?: () => void; onDelete?: () => void }) {
  return <div className="detail-toolbar">
    <button className="icon-button drawer-close" onClick={onClose} aria-label="返回列表"><ArrowLeft size={18} /></button>
    <span className="detail-caption">{caption}</span>
    <div className="detail-tools">
      {onEdit && <button className="button ghost" onClick={onEdit}><PencilLine size={15} />编辑</button>}
      {onDelete && <DropdownMenu.Root><DropdownMenu.Trigger className="icon-button" aria-label="更多操作"><MoreHorizontal size={18} /></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="dropdown" sideOffset={6} align="end"><DropdownMenu.Item className="dropdown-item destructive" onSelect={onDelete}><Trash2 size={15} />移入回收站</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>}
    </div>
  </div>;
}

function Progress({ body }: { body: string }) {
  const steps = getSteps(body), completed = steps.filter(step => step.checked).length;
  return <div className="step-progress"><div><span>检查步骤</span><span>{completed} / {steps.length}</span></div><div className="progress-track"><span style={{ width: completed / steps.length * 100 + '%' }} /></div></div>;
}

function PropertyList({ rows }: { rows: [string, string][] }) {
  return <dl className="property-list">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd className={value ? '' : 'empty'}>{value || '—'}</dd></div>)}</dl>;
}

function EntryButton({ url }: { url: string }) {
  if (!url) return null;
  return <button className="button secondary block" onClick={() => void openExternal(url)}><ExternalLink size={16} />打开入口</button>;
}

export function TaskDetail({ task, busy, onClose, onEdit, onDelete, onToggleStep, onComplete }: {
  task: Task; busy: boolean; onClose: () => void; onEdit: () => void; onDelete: () => void;
  onToggleStep: (index: number, checked: boolean) => void; onComplete: () => void;
}) {
  const done = task.status === 'completed';
  return <div className="detail-layout">
    <DetailToolbar caption="事项详情" onClose={onClose} onEdit={onEdit} onDelete={onDelete} />
    <div className="detail-scroll">
      <h2 className="detail-title">{task.title}</h2>
      <div className="detail-meta">
        {task.dateText && <span className="badge accent"><CalendarDays size={13} />{task.dateText}</span>}
        <span className={'badge' + (done ? ' success' : '')}>{done ? <><CheckCircle2 size={13} />已完成 · {dateTime(task.completedAt)}</> : '待处理'}</span>
      </div>
      {getSteps(task.bodyMarkdown).length > 0 && <Progress body={task.bodyMarkdown} />}
      {task.bodyMarkdown ? <Markdown body={task.bodyMarkdown} disabled={busy} onToggle={onToggleStep} /> : <p className="muted no-description">暂无说明。编辑事项可添加正文和检查步骤。</p>}
    </div>
    <div className="detail-footer">
      <span className="muted">更新于 {dateTime(task.updatedAt)}</span>
      <button className={'button ' + (done ? 'secondary' : 'primary')} disabled={busy} onClick={onComplete}>{done ? <><ArchiveRestore size={16} />恢复待办</> : <><Check size={16} />完成事项</>}</button>
    </div>
  </div>;
}

export function QuotaDetail({ quota, onClose, onEdit, onDelete }: { quota: ApiQuota; onClose: () => void; onEdit: () => void; onDelete: () => void }) {
  return <div className="detail-layout">
    <DetailToolbar caption="API 额度" onClose={onClose} onEdit={onEdit} onDelete={onDelete} />
    <div className="detail-scroll">
      <h2 className="detail-title">{quota.platform}</h2>
      <div className="detail-meta"><span className="badge accent">{quota.kind}</span>{quota.recordedAt && <span className="badge"><CalendarDays size={13} />记录于 {quota.recordedAt}</span>}</div>
      <div className="hero-value"><span>余额</span><strong>{quota.balance || '—'}</strong></div>
      <PropertyList rows={[['备注', quota.note]]} />
      <EntryButton url={quota.entryUrl} />
    </div>
  </div>;
}

export function SubscriptionDetail({ sub, onClose, onEdit, onDelete }: { sub: Subscription; onClose: () => void; onEdit: () => void; onDelete: () => void }) {
  return <div className="detail-layout">
    <DetailToolbar caption="订阅" onClose={onClose} onEdit={onEdit} onDelete={onDelete} />
    <div className="detail-scroll">
      <h2 className="detail-title">{sub.service}</h2>
      <div className="detail-meta">
        <span className="badge accent">{subscriptionCategories[sub.category]}</span>
        {sub.account && <span className="badge">{sub.account}</span>}
        {sub.expiresAt && <span className={'badge ' + expiryClass(sub.expiresAt)}><CalendarDays size={13} />到期 {sub.expiresAt}{expiryLabel(sub.expiresAt)}</span>}
      </div>
      <PropertyList rows={[
        ['套餐', sub.plan], ['权益', sub.benefits], ['状态', sub.status], ['费用', sub.cost],
        ['自动续费', autoRenewLabel(sub.autoRenew)], ['备注', sub.note],
      ]} />
      <EntryButton url={sub.entryUrl} />
    </div>
  </div>;
}

export function TrashDetail({ item, busy, onClose, onRestore }: { item: Item; busy: boolean; onClose: () => void; onRestore: () => void }) {
  return <div className="detail-layout">
    <DetailToolbar caption="回收站内容" onClose={onClose} />
    <div className="detail-scroll">
      <h2 className="detail-title">{item.title}</h2>
      <div className="detail-meta"><span className="badge danger"><Trash2 size={13} />删除于 {dateTime(item.entity.deletedAt)}</span></div>
      {'bodyMarkdown' in item.entity && <Markdown body={item.entity.bodyMarkdown} />}
      <div className="callout"><ArchiveRestore size={18} /><p>正文与步骤状态均保留。</p></div>
    </div>
    <div className="detail-footer"><span /><button className="button primary" disabled={busy} onClick={onRestore}><ArchiveRestore size={16} />恢复内容</button></div>
  </div>;
}
