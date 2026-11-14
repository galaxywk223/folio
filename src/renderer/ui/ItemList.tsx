import type { RefObject, UIEvent } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Archive, Bell, CalendarClock, CalendarDays, CalendarOff, CalendarRange, Check, CheckCircle2, ChevronDown, Circle, CreditCard, History, KeyRound, ListChecks, Loader2, MapPin, Repeat2, Settings, Settings2, Sun, Trash2 } from 'lucide-react';
import { getSteps } from '../../shared/markdown';
import { timeRange } from '../../shared/schedule';
import { dateTime } from '../api';
import { Empty } from '../components';
import { expiryClass, expiryLabel, expiryUrgent } from '../format';
import type { CategoryNav } from './Sidebar';
import { Avatar } from './Avatar';
import type { ApiQuota, EventItem, Item, Selection, Subscription, Task, View } from '../types';

const emptyCopy: Record<View, { title: string; text: string }> = {
  today: { title: '今天没有安排', text: '今天的日程、到期待办和快到期的订阅会显示在这里。' },
  schedule: { title: '没有即将到来的日程', text: '新建日程，或让智能体用 folio 命令写入。' },
  activity: { title: '还没有改动记录', text: '' },
  pending: { title: '待办列表为空', text: '从一条真实事项开始。' },
  completed: { title: '还没有已完成事项', text: '完成的事项会保留在这里。' },
  quotas: { title: '还没有额度记录', text: '记录官方与中转平台的余额与入口。' },
  subscriptions: { title: '还没有订阅记录', text: '记录套餐、费用与到期日。' },
  trash: { title: '回收站为空', text: '删除内容后，可在这里恢复。' },
  settings: { title: '设置', text: '' },
};
const emptyIcons: Record<View, React.ReactNode> = {
  today: <Sun size={26} />, schedule: <CalendarRange size={26} />, activity: <History size={26} />,
  pending: <Circle size={26} />, completed: <Archive size={26} />, quotas: <KeyRound size={26} />,
  subscriptions: <CreditCard size={26} />, trash: <Trash2 size={26} />, settings: <Settings size={26} />,
};

export function ItemList({ listRef, loaded, error, items, view, searching, selection, busy, categoryNav, subscriptionCategories, quotaCategories, header, onChoose, onNew, onClearSearch, onReload, onScroll }: {
  listRef: RefObject<HTMLElement | null>; loaded: boolean; error: string; items: Item[]; view: View; searching: boolean;
  selection: Selection | null; busy: boolean; categoryNav?: CategoryNav; subscriptionCategories: ReadonlyMap<string, string>; quotaCategories: ReadonlyMap<string, string>; header?: React.ReactNode;
  onChoose: (item: Item) => void; onNew?: () => void;
  onClearSearch: () => void; onReload: () => void; onScroll: (event: UIEvent<HTMLElement>) => void;
}) {
  const inTrash = view === 'trash' && !searching;
  // 分组或已选分类时，分类已经写在组标题或侧栏里，行里不再重复；搜索结果里保留。
  const showCategory = searching;
  return <section ref={listRef} className="list-pane card" aria-label="内容列表" onScroll={onScroll}>
    {header}
    <div className="list-heading">
      {categoryNav ? <CategoryDropdown nav={categoryNav} /> : <span />}
      <span className="list-count">{busy ? <><Loader2 className="spinning" size={13} />正在保存</> : items.length + ' 项'}</span>
    </div>
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
          {groupStart && <div className="list-group-label"><span>{item.group}</span></div>}
          <button className={'content-row' + (selected ? ' selected' : '') + (urgent ? ' urgent' : '') + (item.skipped ? ' skipped' : '')} onClick={() => onChoose(item)} aria-pressed={selected}>
            <Avatar name={rowTitle(item)} logo={item.entity.logo} done={item.kind === 'task' && (item.entity as Task).status === 'completed'} />
            <span className="row-content"><strong>{rowTitle(item)}</strong><span className="row-metadata">
              {item.skipped && <span className="badge skipped-badge"><CalendarOff size={12} />已跳过</span>}
              {inTrash ? <span>删除于 {dateTime(item.entity.deletedAt)}</span> : <RowMeta item={item} searching={searching} showCategory={showCategory} subscriptionCategories={subscriptionCategories} quotaCategories={quotaCategories} />}
            </span></span>
            {!inTrash && item.kind === 'quota' && <span className="row-side"><strong>{(item.entity as ApiQuota).balance || '—'}</strong>{(item.entity as ApiQuota).recordedAt && <small>{(item.entity as ApiQuota).recordedAt}</small>}</span>}
            {!inTrash && item.kind === 'subscription' && <SubscriptionSide sub={item.entity as Subscription} />}
          </button>
        </div>;
      })}</div>}
  </section>;
}

function rowTitle(item: Item) {
  if (item.kind === 'quota') return (item.entity as ApiQuota).platform;
  if (item.kind === 'subscription') return (item.entity as Subscription).service;
  return item.title;
}

function CategoryDropdown({ nav }: { nav: CategoryNav }) {
  const current = nav.categories.find(category => category.id === nav.filter)?.name ?? '全部';
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger className="category-dropdown" disabled={nav.locked}>分类：{current}<ChevronDown size={14} /></DropdownMenu.Trigger>
    <DropdownMenu.Portal><DropdownMenu.Content className="dropdown" sideOffset={6} align="start">
      {[{ id: 'all', name: '全部', count: -1 }, ...nav.categories].map(category => <DropdownMenu.Item key={category.id} className="dropdown-item" onSelect={() => nav.onFilter(category.id)}>
        <span className="dropdown-check">{nav.filter === category.id && <Check size={14} />}</span><span>{category.name}</span>{category.count >= 0 && <small className="dropdown-count">{category.count}</small>}
      </DropdownMenu.Item>)}
      <DropdownMenu.Separator className="dropdown-separator" />
      <DropdownMenu.Item className="dropdown-item" onSelect={nav.onManage}><Settings2 size={14} />管理分类</DropdownMenu.Item>
    </DropdownMenu.Content></DropdownMenu.Portal>
  </DropdownMenu.Root>;
}

function SubscriptionSide({ sub }: { sub: Subscription }) {
  if (!sub.expiresAt) return <span className="row-side"><small>未填到期日</small></span>;
  const label = expiryLabel(sub.expiresAt).replace(/^ · /, '');
  return <span className={'row-side ' + expiryClass(sub.expiresAt)}><strong>{sub.expiresAt}</strong>{label && <small>{label}</small>}</span>;
}

function RowMeta({ item, searching, showCategory, subscriptionCategories, quotaCategories }: { item: Item; searching: boolean; showCategory: boolean; subscriptionCategories: ReadonlyMap<string, string>; quotaCategories: ReadonlyMap<string, string> }) {
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
      {showCategory && <span className="badge">{quotaCategories.get(quota.category)}</span>}
      <span className={'badge' + (quota.kind === '中转' ? ' accent' : '')}>{quota.kind}</span>
      {quota.account && <span className="meta-text">{quota.account}</span>}
    </>;
  }
  const sub = item.entity as Subscription;
  return <>
    {showCategory && <span className="badge">{subscriptionCategories.get(sub.category)}</span>}
    <span className="meta-text">{[sub.plan || '未填套餐', sub.account].filter(Boolean).join(' · ')}</span>
  </>;
}
