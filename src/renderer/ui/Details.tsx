import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ArchiveRestore, ArrowLeft, Bell, CalendarDays, CalendarOff, Check, CheckCircle2, Clock, ExternalLink, MapPin, MoreHorizontal, PencilLine, Repeat2, Trash2 } from 'lucide-react';
import { getSteps } from '../../shared/markdown';
import { reminderLabel, repeatLabel, timeRange, weekdayLabel } from '../../shared/schedule';
import { autoRenewLabel } from '../../shared/subscriptions';
import { dateTime, openExternal } from '../api';
import { Markdown } from '../components';
import { expiryClass, expiryLabel } from '../format';
import type { ApiQuota, EventItem, Item, Subscription, Task } from '../types';
import { Avatar } from './Avatar';

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

function DetailTitle({ name, logo, done }: { name: string; logo: string; done?: boolean }) {
  return <div className="detail-heading"><Avatar name={name} logo={logo} size="lg" done={done} /><h2 className="detail-title">{name}</h2></div>;
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
      <DetailTitle name={task.title} logo={task.logo} done={done} />
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

export function QuotaDetail({ quota, categoryName, onClose, onEdit, onDelete }: { quota: ApiQuota; categoryName: string; onClose: () => void; onEdit: () => void; onDelete: () => void }) {
  return <div className="detail-layout">
    <DetailToolbar caption="额度" onClose={onClose} onEdit={onEdit} onDelete={onDelete} />
    <div className="detail-scroll">
      <DetailTitle name={quota.platform} logo={quota.logo} />
      <div className="detail-meta"><span className="badge accent">{categoryName}</span><span className="badge">{quota.kind}</span>{quota.account && <span className="badge">{quota.account}</span>}{quota.recordedAt && <span className="badge"><CalendarDays size={13} />记录于 {quota.recordedAt}</span>}</div>
      <div className="hero-value"><span>余额</span><strong>{quota.balance || '—'}</strong></div>
      <PropertyList rows={[['备注', quota.note]]} />
      <EntryButton url={quota.entryUrl} />
    </div>
  </div>;
}

export function SubscriptionDetail({ sub, categoryName, onClose, onEdit, onDelete }: { sub: Subscription; categoryName: string; onClose: () => void; onEdit: () => void; onDelete: () => void }) {
  return <div className="detail-layout">
    <DetailToolbar caption="订阅" onClose={onClose} onEdit={onEdit} onDelete={onDelete} />
    <div className="detail-scroll">
      <DetailTitle name={sub.service} logo={sub.logo} />
      <div className="detail-meta">
        <span className="badge accent">{categoryName}</span>
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

export function EventDetail({ event, date, busy, onClose, onEdit, onDelete, onSkip }: {
  event: EventItem; date?: string; busy: boolean; onClose: () => void; onEdit: () => void; onDelete: () => void; onSkip?: () => void;
}) {
  const shownDate = date || event.date;
  return <div className="detail-layout">
    <DetailToolbar caption="日程" onClose={onClose} onEdit={onEdit} onDelete={onDelete} />
    <div className="detail-scroll">
      <DetailTitle name={event.title} logo={event.logo} />
      <div className="detail-meta">
        <span className="badge accent"><CalendarDays size={13} />{shownDate} {weekdayLabel(shownDate)}</span>
        <span className="badge"><Clock size={13} />{timeRange(event)}</span>
        {event.location && <span className="badge"><MapPin size={13} />{event.location}</span>}
      </div>
      <PropertyList rows={[
        ['重复', repeatLabel(event)],
        ['提醒', reminderLabel(event.reminderMinutes)],
        ['已跳过', event.skippedDates.join('、')],
        ['备注', event.note],
      ]} />
      <div className="callout">{event.reminderMinutes === null ? <CalendarDays size={18} /> : <Bell size={18} />}<p>{event.reminderMinutes === null ? '这条日程不会弹出提醒。' : '到时间会弹出 Windows 通知，Folio 在托盘运行即可。'}</p></div>
    </div>
    <div className="detail-footer">
      <span className="muted">{event.repeat !== 'none' && <><Repeat2 size={13} /> 重复日程</>}</span>
      {onSkip && <button className="button secondary" disabled={busy} onClick={onSkip}><CalendarOff size={16} />跳过这一次</button>}
    </div>
  </div>;
}

export function TrashDetail({ item, busy, onClose, onRestore }: { item: Item; busy: boolean; onClose: () => void; onRestore: () => void }) {
  return <div className="detail-layout">
    <DetailToolbar caption="回收站内容" onClose={onClose} />
    <div className="detail-scroll">
      <DetailTitle name={item.title} logo={item.entity.logo} />
      <div className="detail-meta"><span className="badge danger"><Trash2 size={13} />删除于 {dateTime(item.entity.deletedAt)}</span></div>
      {'bodyMarkdown' in item.entity && <Markdown body={item.entity.bodyMarkdown} />}
      <div className="callout"><ArchiveRestore size={18} /><p>正文与步骤状态均保留。</p></div>
    </div>
    <div className="detail-footer"><span /><button className="button primary" disabled={busy} onClick={onRestore}><ArchiveRestore size={16} />恢复内容</button></div>
  </div>;
}
