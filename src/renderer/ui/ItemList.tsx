import type { RefObject, UIEvent } from 'react';
import { Archive, Bell, CalendarClock, CalendarDays, CalendarRange, CheckCircle2, Circle, CreditCard, History, KeyRound, ListChecks, Loader2, MapPin, Repeat2, Sun, Trash2, Wallet } from 'lucide-react';
import { getSteps } from '../../shared/markdown';
import { timeRange } from '../../shared/schedule';
import { dateTime } from '../api';
import { Empty } from '../components';
import { expiryClass, expiryLabel, expiryUrgent } from '../format';
import type { ApiQuota, EventItem, Item, Selection, Subscription, Task, View } from '../types';

const emptyCopy: Record<View, { title: string; text: string }> = {
  today: { title: '今天没有安排', text: '今天的日程、到期待办和快到期的订阅会显示在这里。' },
  schedule: { title: '未来两周没有日程', text: '新建日程，或让智能体用 folio 命令写入。' },
  activity: { title: '还没有改动记录', text: '' },
  pending: { title: '待办列表为空', text: '从一条真实事项开始。' },
  completed: { title: '还没有已完成事项', text: '完成的事项会保留在这里。' },
  quotas: { title: '还没有额度记录', text: '记录官方与中转平台的余额与入口。' },
  subscriptions: { title: '还没有订阅记录', text: '记录套餐、费用与到期日。' },
  trash: { title: '回收站为空', text: '删除内容后，可在这里恢复。' },
};
const emptyIcons: Record<View, React.ReactNode> = {
  today: <Sun size={26} />, schedule: <CalendarRange size={26} />, activity: <History size={26} />,
  pending: <Circle size={26} />, completed: <Archive size={26} />, quotas: <KeyRound size={26} />,
  subscriptions: <CreditCard size={26} />, trash: <Trash2 size={26} />,
};

export function ItemList({ listRef, loaded, error, items, view, searching, selection, busy, filtersLocked, filter, subscriptionCategories, quotaCategories, onManageCategories, header, onFilter, onChoose, onNew, onClearSearch, onReload, onScroll }: {
  listRef: RefObject<HTMLElement | null>; loaded: boolean; error: string; items: Item[]; view: View; searching: boolean;
  selection: Selection | null; busy: boolean; filtersLocked: boolean; filter: string; subscriptionCategories: ReadonlyMap<string, string>; quotaCategories: ReadonlyMap<string, string>; onManageCategories?: () => void; header?: React.ReactNode;
  onFilter: (filter: string) => void; onChoose: (item: Item) => void; onNew?: () => void;
  onClearSearch: () => void; onReload: () => void; onScroll: (event: UIEvent<HTMLElement>) => void;
}) {
  const categories = [...(view === 'subscriptions' ? subscriptionCategories : quotaCategories)];
  const inTrash = view === 'trash' && !searching;
  return <section ref={listRef} className="list-pane card" aria-label="内容列表" onScroll={onScroll}>
    {header}
    {(view === 'subscriptions' || view === 'quotas') && !searching && <div className="list-filters"><div className="segmented" role="group" aria-label={view === 'quotas' ? '额度分类' : '订阅分类'}>
      {[['all', '全部'], ...categories].map(([id, name]) => <button key={id} className={filter === id ? 'active' : ''} aria-pressed={filter === id} disabled={filtersLocked || busy} onClick={() => onFilter(id)}>{name}</button>)}
    </div>{onManageCategories && <button className="button secondary" disabled={filtersLocked || busy} onClick={onManageCategories}>管理分类</button>}</div>}
    <div className="list-heading"><span>{items.length} 项内容</span>{busy && <span><Loader2 className="spinning" size={13} />正在保存</span>}</div>
    {!loaded ? <Empty title={error ? '暂时无法读取数据' : '正在读取本地记录'} text={error ? '本地服务恢复后可重新读取，编辑内容不会清空。' : '正在连接本机服务。'} action={error ? onReload : undefined} actionLabel="重新读取" icon={<Loader2 size={25} className={error ? '' : 'spinning'} />} />
      : !items.length ? <Empty
        title={searching ? '没有找到匹配内容' : emptyCopy[view].title}
        text={searching ? '尝试其他关键词，或清除搜索查看全部内容。' : emptyCopy[view].text}
        action={searching ? onClearSearch : onNew}
        actionLabel={searching ? '清除搜索' : '新建'}
        icon={emptyIcons[view]}
      />
      : <div className="content-list">{items.map((item, index) => {
        const selected = selection?.id === item.id && selection.kind === item.kind && (selection.date ?? '') === (item.date ?? '');
        const urgent = item.kind === 'subscription' && expiryUrgent((item.entity as Subscription).expiresAt);
        const groupStart = !!item.group && (index === 0 || items[index - 1].group !== item.group);
        return <div key={item.kind + item.id + (item.date ?? '')}>
          {groupStart && <div className="list-group-label">{item.group}</div>}
          <button className={'content-row' + (selected ? ' selected' : '') + (urgent ? ' urgent' : '')} onClick={() => onChoose(item)} aria-pressed={selected}>
            <span className={'row-icon ' + item.kind + (item.kind === 'task' && (item.entity as Task).status === 'completed' ? ' done' : '')}>
              {item.kind === 'task' ? ((item.entity as Task).status === 'completed' ? <CheckCircle2 size={18} /> : <Circle size={18} />)
                : item.kind === 'quota' ? <Wallet size={17} /> : item.kind === 'event' ? <CalendarClock size={17} /> : <CreditCard size={17} />}
            </span>
            <span className="row-content"><strong>{item.title}</strong><span className="row-metadata">
              {inTrash ? <span>删除于 {dateTime(item.entity.deletedAt)}</span> : <RowMeta item={item} searching={searching} subscriptionCategories={subscriptionCategories} quotaCategories={quotaCategories} />}
            </span></span>
            {item.kind === 'quota' && !inTrash && <span className="row-value">{(item.entity as ApiQuota).balance || '—'}</span>}
          </button>
        </div>;
      })}</div>}
  </section>;
}

function RowMeta({ item, searching, subscriptionCategories, quotaCategories }: { item: Item; searching: boolean; subscriptionCategories: ReadonlyMap<string, string>; quotaCategories: ReadonlyMap<string, string> }) {
  if (item.kind === 'task') {
    const task = item.entity as Task;
    const steps = getSteps(task.bodyMarkdown);
    return <>
      <span className={'badge' + (task.dateText ? ' accent' : '')}><CalendarDays size={12} />{task.dateText || '未定日期'}</span>
      {steps.length > 0 && <span className="badge"><ListChecks size={12} />{steps.filter(step => step.checked).length}/{steps.length}</span>}
      {searching && <span className="badge">{task.status === 'completed' ? '已完成' : '待办'}</span>}
    </>;
  }
  if (item.kind === 'event') {
    const event = item.entity as EventItem;
    return <>
      <span className="badge accent"><CalendarClock size={12} />{(searching || !item.date) ? event.date + ' · ' : ''}{timeRange(event)}</span>
      {event.location && <span className="badge"><MapPin size={12} />{event.location}</span>}
      {event.repeat !== 'none' && <span className="badge"><Repeat2 size={12} />重复</span>}
      {event.reminderMinutes !== null && <span className="badge"><Bell size={12} />提醒</span>}
    </>;
  }
  if (item.kind === 'quota') {
    const quota = item.entity as ApiQuota;
    return <>
      <span className="badge">{quotaCategories.get(quota.category)}</span>
      <span className="badge">{quota.kind}</span>
      {quota.recordedAt && <span>记录于 {quota.recordedAt}</span>}
    </>;
  }
  const sub = item.entity as Subscription;
  return <>
    <span className="badge">{subscriptionCategories.get(sub.category)}</span>
    <span>{sub.plan || '未填套餐'}</span>
    {sub.expiresAt && <span className={'badge ' + expiryClass(sub.expiresAt)}><CalendarDays size={12} />{sub.expiresAt}{expiryLabel(sub.expiresAt)}</span>}
  </>;
}
