import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, FileText, RefreshCw, X } from 'lucide-react';
import { getSteps } from '../shared/markdown';
import { addDays, localDate, occurrencesBetween, timeRange, weekdayLabel } from '../shared/schedule';
import { matchesServiceFilter, matchesSubscriptionFilter } from '../shared/subscriptions';
import { daysUntil, request } from './api';
import { Confirm, Editor, Empty } from './components';
import type { Confirmation, EditorHandle } from './components';
import { parseBalance } from './format';
import type { ApiQuota, Entity, EditorValue, EventDraft, EventItem, Item, Kind, QuotaDraft, Selection, State, Subscription, SubscriptionDraft, Task, View } from './types';
import { ActivityView } from './ui/ActivityView';
import { CategoryManager } from './ui/CategoryManager';
import { EventDetail, QuotaDetail, SubscriptionDetail, TaskDetail, TrashDetail } from './ui/Details';
import { EventEditor } from './ui/EventEditor';
import { ItemList } from './ui/ItemList';
import { QuotaOverview, SubscriptionOverview, TodayOverview } from './ui/Overview';
import { ServiceEditor } from './ui/ServiceEditor';
import { SettingsView } from './ui/SettingsView';
import { Sidebar } from './ui/Sidebar';
import { Topbar } from './ui/Topbar';

const viewTitles: Record<View, string> = {
  today: '今天', schedule: '日程', pending: '待办', completed: '已完成', quotas: '额度', subscriptions: '订阅', trash: '回收站', activity: '改动记录', settings: '设置',
};
const viewDescriptions: Record<View, string> = {
  today: '今天的日程、到期待办和 7 天内到期的订阅。',
  schedule: '今天起两周内的日程，重复日程按天展开。',
  pending: '有日期事项在前，未定日期事项随后。',
  completed: '保留每件事项的说明与步骤记录。',
  quotas: '按分类记录官方与中转额度、入口与备注。',
  subscriptions: '按到期日排序；14 天内到期会高亮提醒。',
  trash: '恢复已删除的事项与服务条目。',
  activity: '应用内和 folio 命令写入的每一次改动。',
  settings: '启动、窗口、外观、数据备份与更新。',
};
const SCHEDULE_DAYS = 14;
const SUBSCRIPTION_SOON_DAYS = 7;
const REVISION_POLL_MS = 3000;
type Editing =
  | { kind: 'task'; id: string | null; initial: EditorValue }
  | { kind: 'quota'; id: string | null; initial: QuotaDraft }
  | { kind: 'subscription'; id: string | null; initial: SubscriptionDraft }
  | { kind: 'event'; id: string | null; initial: EventDraft };

const emptyQuota: QuotaDraft = { kind: '官方', category: 'other', platform: '', account: '', entryUrl: '', balance: '', recordedAt: '', note: '' };
const emptySubscription: SubscriptionDraft = { service: '', category: 'other', autoRenew: null, account: '', plan: '', benefits: '', status: '', cost: '', expiresAt: '', entryUrl: '', note: '' };
const emptyEvent = (date: string): EventDraft => ({ title: '', date, startTime: '', endTime: '', location: '', note: '', repeat: 'none', repeatDays: [], repeatUntil: '', reminderMinutes: null });
const entityTitle = (entity: Entity) => 'platform' in entity ? entity.platform : 'service' in entity ? entity.service : entity.title;
const sameSelection = (item: Item, selection: Selection | null) =>
  !!selection && item.id === selection.id && item.kind === selection.kind && (item.date ?? '') === (selection.date ?? '');
const dayLabel = (date: string, today: string) => (date === today ? '今天 · ' : date === addDays(today, 1) ? '明天 · ' : '') + date.slice(5) + ' ' + weekdayLabel(date);

export default function App() {
  const [state, setState] = useState<State | null>(null);
  const [view, setView] = useState<View>('today');
  const [today, setToday] = useState(() => localDate());
  const [revision, setRevision] = useState('');
  const [externalChange, setExternalChange] = useState(false);
  const [selectedSubscriptionFilter, setSubscriptionFilter] = useState('all');
  const [categoriesOpen, setCategoriesOpen] = useState<'subscription' | 'quota' | null>(null);
  const [selectedQuotaFilter, setQuotaFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<Selection | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [wide, setWide] = useState(window.innerWidth >= 1180);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const listRef = useRef<HTMLElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<EditorHandle>(null);
  const scrollPositions = useRef<Record<string, number>>({});
  const seenRevision = useRef('');
  const categoryNames = useMemo(() => new Map(state?.subscriptionCategories.map(({ id, name }) => [id, name])), [state]);
  const subscriptionFilter = categoryNames.has(selectedSubscriptionFilter) ? selectedSubscriptionFilter : 'all';
  useEffect(() => {
    if (state && !categoryNames.has(selectedSubscriptionFilter)) setSubscriptionFilter('all');
  }, [state, categoryNames, selectedSubscriptionFilter]);
  const quotaCategoryNames = useMemo(() => new Map(state?.quotaCategories.map(({ id, name }) => [id, name])), [state]);
  const quotaFilter = quotaCategoryNames.has(selectedQuotaFilter) ? selectedQuotaFilter : 'all';
  useEffect(() => {
    if (state && !quotaCategoryNames.has(selectedQuotaFilter)) setQuotaFilter('all');
  }, [state, quotaCategoryNames, selectedQuotaFilter]);
  const effectiveView = query.trim() ? 'search' : view === 'subscriptions' ? 'subscriptions-' + subscriptionFilter : view === 'quotas' ? 'quotas-' + quotaFilter : view;

  const load = useCallback(async () => {
    const result = await request<State>('/api/state');
    setState(result);
    setExternalChange(false);
    return result;
  }, []);
  useEffect(() => { void load().catch(failure => setError(failure.message)); }, [load]);
  useEffect(() => {
    const resize = () => setWide(window.innerWidth >= 1180);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  // 过了零点，「今天」和日程范围跟着变。
  useEffect(() => {
    const timer = setInterval(() => setToday(localDate()), 60_000);
    return () => clearInterval(timer);
  }, []);
  // 命令行或智能体写入后自动刷新；正在编辑时只提示，不打断。
  const editingRef = useRef(false);
  editingRef.current = !!editing;
  useEffect(() => {
    let stopped = false;
    async function poll() {
      if (document.visibilityState !== 'visible') return;
      try {
        const { revision: next } = await request<{ revision: string }>('/api/revision');
        if (stopped || next === seenRevision.current) return;
        const first = !seenRevision.current;
        seenRevision.current = next;
        setRevision(next);
        if (first) return;
        if (editingRef.current) setExternalChange(true);
        else await load();
      } catch { /* 本地服务暂时不可用时下次再试 */ }
    }
    void poll();
    const timer = setInterval(() => void poll(), REVISION_POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [load]);
  useEffect(() => {
    if (!editing && externalChange) void load().catch(failure => setError(failure.message));
  }, [editing, externalChange, load]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function guarded(action: () => void) {
    if (!dirty) { setEditing(null); setDirty(false); action(); return; }
    setConfirmation({
      title: '存在未保存的修改', message: '当前编辑内容尚未保存。保存后继续，或明确放弃本次修改。', primary: '保存并继续',
      action: async () => {
        if (editing?.kind === 'task') {
          if (await editorRef.current?.save()) action();
        } else {
          setEditing(null); setDirty(false); action();
        }
      },
      secondary: '放弃修改', secondaryAction: () => { setEditing(null); setDirty(false); action(); },
    });
  }
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && editing?.kind === 'task') {
        event.preventDefault(); void editorRef.current?.save();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !confirmation) { event.preventDefault(); searchRef.current?.focus(); }
      if (event.key === 'Escape' && !wide && drawerOpen && !confirmation) guarded(() => setDrawerOpen(false));
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });
  useEffect(() => {
    if (!wide && drawerOpen) detailRef.current?.querySelector<HTMLElement>('button,input,textarea')?.focus();
  }, [wide, drawerOpen]);

  const items = useMemo<Item[]>(() => {
    if (!state) return [];
    const eventItem = (event: EventItem, date?: string, group?: string): Item => ({
      kind: 'event', id: event.id, date, group, title: event.title,
      subtitle: (date ? '' : event.date + ' ') + timeRange(event), entity: event,
    });
    const subscriptionItem = (item: Subscription, group?: string): Item => ({ kind: 'subscription', id: item.id, group, title: item.service + (item.account ? ' · ' + item.account : ''), subtitle: [item.plan, item.expiresAt].filter(Boolean).join(' · '), entity: item });
    const taskItem = (task: Task, group?: string): Item => ({ kind: 'task', id: task.id, group, title: task.title, subtitle: task.dateText, entity: task });
    const all: Item[] = [
      ...state.tasks.map(task => taskItem(task)),
      ...state.events.map(event => eventItem(event)),
      ...state.quotas.map(item => ({ kind: 'quota' as const, id: item.id, title: item.platform + (item.account ? ' · ' + item.account : ''), subtitle: item.balance + ' · ' + item.kind, entity: item })),
      ...state.subscriptions.map(item => subscriptionItem(item)),
    ];
    if (query.trim()) {
      const keyword = query.trim().toLocaleLowerCase();
      return all.filter(item => {
        if (item.entity.deletedAt) return false;
        const hay = [
          item.title, item.subtitle,
          'bodyMarkdown' in item.entity ? item.entity.bodyMarkdown : '',
          'location' in item.entity ? item.entity.location + item.entity.note : '',
          'platform' in item.entity ? item.entity.platform + item.entity.account + item.entity.balance + item.entity.note + (quotaCategoryNames.get(item.entity.category) ?? '') : '',
          'service' in item.entity ? item.entity.service + item.entity.account + item.entity.plan + item.entity.note + item.entity.status + (categoryNames.get(item.entity.category) ?? '') : '',
        ].join('\n').toLocaleLowerCase();
        return hay.includes(keyword);
      });
    }
    if (view === 'today') {
      const events = occurrencesBetween(state.events, today, today).map(({ event, date }) => eventItem(event, date, '日程'));
      const tasks = state.tasks.filter(task => !task.deletedAt && task.status === 'pending' && task.dateText && task.dateText.slice(0, 10) <= today)
        .map(task => taskItem(task, '待办'));
      const subscriptions = state.subscriptions.filter(item => {
        const days = daysUntil(item.expiresAt);
        return !item.deletedAt && days !== null && days >= 0 && days <= SUBSCRIPTION_SOON_DAYS;
      }).map(item => subscriptionItem(item, '订阅'));
      return [...events, ...tasks, ...subscriptions];
    }
    if (view === 'schedule') {
      return occurrencesBetween(state.events, today, addDays(today, SCHEDULE_DAYS - 1)).map(({ event, date }) => eventItem(event, date, dayLabel(date, today)));
    }
    if (view === 'trash') return all.filter(item => item.entity.deletedAt).sort((a, b) => b.entity.deletedAt!.localeCompare(a.entity.deletedAt!));
    if (view === 'pending' || view === 'completed') {
      return state.tasks.filter(task => !task.deletedAt && task.status === view)
        .map(task => taskItem(task, view === 'pending' && !task.dateText ? '未定日期' : undefined));
    }
    if (view === 'quotas') {
      return all
        .filter(item => item.kind === 'quota' && matchesServiceFilter(item.entity as ApiQuota, quotaFilter))
        .sort((a, b) => {
          const aVal = parseBalance((a.entity as ApiQuota).balance);
          const bVal = parseBalance((b.entity as ApiQuota).balance);
          if (aVal === null && bVal === null) return a.title.localeCompare(b.title);
          if (aVal === null) return 1;
          if (bVal === null) return -1;
          return bVal - aVal;
        });
    }
    if (view === 'subscriptions') return all.filter(item => item.kind === 'subscription' && matchesSubscriptionFilter(item.entity as Subscription, subscriptionFilter));
    return [];
  }, [state, view, query, today, subscriptionFilter, quotaFilter, categoryNames, quotaCategoryNames]);
  useEffect(() => {
    if (editing || view === 'activity' || view === 'settings') return;
    if (!selection || !items.some(item => sameSelection(item, selection))) {
      setSelection(items[0] ? { kind: items[0].kind, id: items[0].id, date: items[0].date } : null);
    }
  }, [items, selection, editing, view]);
  useLayoutEffect(() => { if (listRef.current) listRef.current.scrollTop = scrollPositions.current[effectiveView] || 0; }, [effectiveView]);
  const selectedItem = items.find(item => sameSelection(item, selection));
  const selectedTask = selectedItem?.kind === 'task' ? selectedItem.entity as Task : null;
  const selectedQuota = selectedItem?.kind === 'quota' ? selectedItem.entity as ApiQuota : null;
  const selectedSub = selectedItem?.kind === 'subscription' ? selectedItem.entity as Subscription : null;
  const selectedEvent = selectedItem?.kind === 'event' ? selectedItem.entity as EventItem : null;
  const todayStats = useMemo(() => {
    if (!state) return { events: 0, tasks: 0, overdue: 0, subscriptions: 0, schedule: 0 };
    const due = state.tasks.filter(task => !task.deletedAt && task.status === 'pending' && task.dateText && task.dateText.slice(0, 10) <= today);
    return {
      events: occurrencesBetween(state.events, today, today).length,
      tasks: due.length,
      overdue: due.filter(task => task.dateText.slice(0, 10) < today).length,
      subscriptions: state.subscriptions.filter(item => { const days = daysUntil(item.expiresAt); return !item.deletedAt && days !== null && days >= 0 && days <= SUBSCRIPTION_SOON_DAYS; }).length,
      schedule: occurrencesBetween(state.events, today, addDays(today, SCHEDULE_DAYS - 1)).length,
    };
  }, [state, today]);
  const counts = state ? {
    today: todayStats.events + todayStats.tasks + todayStats.subscriptions,
    schedule: todayStats.schedule,
    pending: state.tasks.filter(task => !task.deletedAt && task.status === 'pending').length,
    completed: state.tasks.filter(task => !task.deletedAt && task.status === 'completed').length,
    quotas: state.quotas.filter(item => !item.deletedAt).length,
    subscriptions: state.subscriptions.filter(item => !item.deletedAt).length,
  } : { today: 0, schedule: 0, pending: 0, completed: 0, quotas: 0, subscriptions: 0 };
  const trashCount = state ? [...state.tasks, ...state.events, ...state.quotas, ...state.subscriptions].filter(item => item.deletedAt).length : 0;

  async function operate(action: () => Promise<unknown>, success?: string) {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); await load(); if (success) setNotice(success); }
    catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }
  function changeView(next: View) {
    guarded(() => { setView(next); setQuery(''); setSelection(null); setDrawerOpen(false); });
  }
  function choose(item: Item) {
    guarded(() => { setSelection({ kind: item.kind, id: item.id, date: item.date }); setDrawerOpen(true); });
  }
  // 打开某一项：通知、改动记录都走这里。
  function openEntity(kind: Kind, id: string, date?: string) {
    if (!state) return;
    const lists: Record<Kind, Entity[]> = { task: state.tasks, event: state.events, quota: state.quotas, subscription: state.subscriptions };
    const entity = lists[kind].find(item => item.id === id);
    if (!entity) { setError('这一项已经不存在了。'); return; }
    guarded(() => {
      setQuery(''); setDrawerOpen(true);
      if (entity.deletedAt) { setView('trash'); setSelection({ kind, id }); return; }
      if (kind === 'task') { setView((entity as Task).status); setSelection({ kind, id }); return; }
      if (kind === 'quota') { setView('quotas'); setQuotaFilter('all'); setSelection({ kind, id }); return; }
      if (kind === 'subscription') { setView('subscriptions'); setSubscriptionFilter('all'); setSelection({ kind, id }); return; }
      const next = date || occurrencesBetween([entity as EventItem], today, addDays(today, SCHEDULE_DAYS - 1))[0]?.date;
      if (next && next >= today && next <= addDays(today, SCHEDULE_DAYS - 1)) { setView(next === today ? 'today' : 'schedule'); setSelection({ kind, id, date: next }); }
      else { setQuery(entityTitle(entity)); setSelection({ kind, id }); }
    });
  }
  const openEntityRef = useRef(openEntity);
  openEntityRef.current = openEntity;
  useEffect(() => window.folio?.onNavigate?.(target => openEntityRef.current(target.kind, target.id, target.date)), []);
  const reportError = useCallback((message: string) => setError(message), []);

  function restoreBackup(action: () => Promise<unknown>) {
    setConfirmation({
      title: '从完整备份恢复', message: '恢复将替换应用中的事项、日程与服务条目。当前数据会先自动备份。', primary: '备份当前数据并恢复',
      action: () => operate(async () => { await action(); setSelection(null); setQuery(''); setView('today'); }, '备份已恢复，恢复前的数据另有自动备份。'),
    });
  }

  function startEdit(entity?: Task) {
    guarded(() => {
      setEditing({ kind: 'task', id: entity?.id || null, initial: { title: entity?.title || '', bodyMarkdown: entity?.bodyMarkdown || '', dateText: entity?.dateText || '', version: entity?.version } });
      setDrawerOpen(true);
    });
  }
  function startQuotaEdit(entity?: ApiQuota) {
    guarded(() => {
      setEditing({
        kind: 'quota', id: entity?.id || null,
        initial: entity ? { kind: entity.kind, category: entity.category, platform: entity.platform, account: entity.account, entryUrl: entity.entryUrl, balance: entity.balance, recordedAt: entity.recordedAt, note: entity.note, version: entity.version } : { ...emptyQuota },
      });
      setDrawerOpen(true);
    });
  }
  function startSubEdit(entity?: Subscription) {
    guarded(() => {
      setEditing({
        kind: 'subscription', id: entity?.id || null,
        initial: entity ? {
          service: entity.service, account: entity.account, plan: entity.plan, benefits: entity.benefits, status: entity.status,
          category: entity.category, autoRenew: entity.autoRenew,
          cost: entity.cost, expiresAt: entity.expiresAt, entryUrl: entity.entryUrl, note: entity.note, version: entity.version,
        } : { ...emptySubscription },
      });
      setDrawerOpen(true);
    });
  }
  function startEventEdit(entity?: EventItem) {
    guarded(() => {
      setEditing({
        kind: 'event', id: entity?.id || null,
        initial: entity ? {
          title: entity.title, date: entity.date, startTime: entity.startTime, endTime: entity.endTime, location: entity.location, note: entity.note,
          repeat: entity.repeat, repeatDays: entity.repeatDays, repeatUntil: entity.repeatUntil, reminderMinutes: entity.reminderMinutes, version: entity.version,
        } : emptyEvent(today),
      });
      setDrawerOpen(true);
    });
  }
  async function saveEditor(value: EditorValue) {
    if (!editing || editing.kind !== 'task') return;
    const record = await request<Task>('/api/tasks' + (editing.id ? '/' + editing.id : ''), editing.id ? 'PATCH' : 'POST', value);
    setEditing(null); setDirty(false); setQuery(''); setView(record.status);
    setSelection({ kind: 'task', id: record.id }); setNotice('已保存');
    void load().catch(failure => setError('内容已经保存，列表刷新失败：' + failure.message));
  }
  async function saveQuota(value: QuotaDraft) {
    if (!editing || editing.kind !== 'quota') return;
    const record = await request<ApiQuota>('/api/quotas' + (editing.id ? '/' + editing.id : ''), editing.id ? 'PATCH' : 'POST', value);
    setEditing(null); setDirty(false); setQuery(''); setView('quotas');
    if (quotaFilter !== 'all' && quotaFilter !== record.category) setQuotaFilter(record.category);
    setSelection({ kind: 'quota', id: record.id }); setNotice('已保存');
    void load().catch(failure => setError('内容已经保存，列表刷新失败：' + failure.message));
  }
  async function saveSubscription(value: SubscriptionDraft) {
    if (!editing || editing.kind !== 'subscription') return;
    const record = await request<Subscription>('/api/subscriptions' + (editing.id ? '/' + editing.id : ''), editing.id ? 'PATCH' : 'POST', value);
    setEditing(null); setDirty(false); setQuery(''); setView('subscriptions');
    if (subscriptionFilter !== 'all' && subscriptionFilter !== record.category) setSubscriptionFilter(record.category);
    setSelection({ kind: 'subscription', id: record.id }); setNotice('已保存');
    void load().catch(failure => setError('内容已经保存，列表刷新失败：' + failure.message));
  }
  async function saveEvent(value: EventDraft) {
    if (!editing || editing.kind !== 'event') return;
    const record = await request<EventItem>('/api/events' + (editing.id ? '/' + editing.id : ''), editing.id ? 'PATCH' : 'POST', value);
    const next = occurrencesBetween([record], today, addDays(today, SCHEDULE_DAYS - 1))[0]?.date;
    setEditing(null); setDirty(false); setQuery(''); setNotice('已保存');
    if (next) { setView(view === 'today' && next === today ? 'today' : 'schedule'); setSelection({ kind: 'event', id: record.id, date: next }); }
    else { setQuery(record.title); setSelection({ kind: 'event', id: record.id }); }
    void load().catch(failure => setError('内容已经保存，列表刷新失败：' + failure.message));
  }
  function skipOccurrence(event: EventItem, date: string) {
    setConfirmation({
      title: '跳过这一次', message: '“' + event.title + '”在 ' + date + ' ' + weekdayLabel(date) + ' 这一次不再显示，也不会提醒；其他日子照常。', primary: '跳过这一次',
      action: () => operate(() => request('/api/events/' + event.id + '/skip', 'POST', { date, version: event.version }), '已跳过这一次'),
    });
  }
  function completeTask(task: Task) {
    const status = task.status === 'pending' ? 'completed' : 'pending';
    const action = () => operate(() => request('/api/tasks/' + task.id, 'PATCH', { status, version: task.version, confirmIncomplete: true }), status === 'completed' ? '事项已归档，步骤记录保留。' : '事项已恢复到待办。');
    const remaining = getSteps(task.bodyMarkdown).filter(step => !step.checked).length;
    if (status === 'completed' && remaining) setConfirmation({ title: '确认完成整件事项', message: '仍有 ' + remaining + ' 个未完成步骤。归档后保留当前步骤状态。', primary: '完成并归档', action });
    else void action();
  }
  function removeItem(kind: Kind, entity: Entity) {
    const path = { task: 'tasks', quota: 'quotas', subscription: 'subscriptions', event: 'events' }[kind];
    const extra = kind === 'event' && (entity as EventItem).repeat !== 'none' ? '所有重复都会一起删除；只取消某一次请用「跳过这一次」。' : '可随时恢复。';
    setConfirmation({
      title: '移入回收站', message: '“' + entityTitle(entity) + '”将移入回收站，' + extra, primary: '移入回收站', destructive: true,
      action: () => operate(() => request('/api/' + path + '/' + entity.id, 'DELETE', { version: entity.version }), '已移入回收站'),
    });
  }

  const searching = !!query.trim();
  const showActivity = view === 'activity' && !searching;
  const showSettings = view === 'settings' && !searching;
  const closeDrawer = () => setDrawerOpen(false);
  const newAction = view === 'today' || view === 'schedule' ? { label: '新日程', run: () => startEventEdit() }
    : view === 'pending' ? { label: '新事项', run: () => startEdit() }
    : view === 'quotas' ? { label: '新额度', run: () => startQuotaEdit() }
    : view === 'subscriptions' ? { label: '新订阅', run: () => startSubEdit() } : null;

  const detail = editing?.kind === 'quota' ? <ServiceEditor kind="quota" categories={state?.quotaCategories} initial={editing.initial} isNew={!editing.id} onSave={value => saveQuota(value as QuotaDraft)} onCancel={() => guarded(() => {})} onDirty={setDirty} />
    : editing?.kind === 'subscription' ? <ServiceEditor kind="subscription" categories={state?.subscriptionCategories} initial={editing.initial} isNew={!editing.id} onSave={value => saveSubscription(value as SubscriptionDraft)} onCancel={() => guarded(() => {})} onDirty={setDirty} />
    : editing?.kind === 'event' ? <EventEditor key={'event' + (editing.id || '-new')} initial={editing.initial} isNew={!editing.id} onSave={saveEvent} onCancel={() => guarded(() => {})} onDirty={setDirty} />
    : editing?.kind === 'task' ? <Editor key={'task' + (editing.id || '-new')} ref={editorRef} initial={editing.initial} kind="task" isNew={!editing.id} onSave={saveEditor} onDirty={setDirty} onCancel={() => guarded(() => {})} />
    : !selectedItem ? <Empty title="选择一项查看详情" text="说明、检查步骤与服务信息会显示在这里。" icon={<FileText size={26} />} />
    : view === 'trash' && !searching ? <TrashDetail item={selectedItem} busy={busy} onClose={closeDrawer} onRestore={() => void operate(() => request('/api/trash/' + selectedItem.kind + '/' + selectedItem.id + '/restore', 'POST'), '已从回收站恢复')} />
    : selectedTask ? <TaskDetail task={selectedTask} busy={busy} onClose={closeDrawer} onEdit={() => startEdit(selectedTask)} onDelete={() => removeItem('task', selectedTask)}
      onToggleStep={(index, checked) => void operate(() => request('/api/tasks/' + selectedTask.id + '/steps', 'POST', { index, checked, version: selectedTask.version }))} onComplete={() => completeTask(selectedTask)} />
    : selectedEvent ? <EventDetail event={selectedEvent} date={selectedItem.date} busy={busy} onClose={closeDrawer} onEdit={() => startEventEdit(selectedEvent)} onDelete={() => removeItem('event', selectedEvent)}
      onSkip={selectedEvent.repeat !== 'none' && selectedItem.date ? () => skipOccurrence(selectedEvent, selectedItem.date!) : undefined} />
    : selectedQuota ? <QuotaDetail quota={selectedQuota} categoryName={quotaCategoryNames.get(selectedQuota.category) ?? ''} onClose={closeDrawer} onEdit={() => startQuotaEdit(selectedQuota)} onDelete={() => removeItem('quota', selectedQuota)} />
    : selectedSub ? <SubscriptionDetail sub={selectedSub} categoryName={categoryNames.get(selectedSub.category) ?? ''} onClose={closeDrawer} onEdit={() => startSubEdit(selectedSub)} onDelete={() => removeItem('subscription', selectedSub)} />
    : null;
  const header = !state || searching ? undefined
    : view === 'today' ? <TodayOverview events={todayStats.events} tasks={todayStats.tasks} overdue={todayStats.overdue} subscriptions={todayStats.subscriptions} />
    : view === 'subscriptions' ? <SubscriptionOverview items={state.subscriptions} />
    : view === 'quotas' ? <QuotaOverview items={state.quotas} /> : undefined;

  return <div className="app-shell">
    <Sidebar active={searching ? null : view} counts={counts} trashCount={trashCount} onView={changeView} />
    <main className="workspace">
      <Topbar
        title={searching ? '搜索结果' : viewTitles[view]} description={searching ? '搜索事项、日程、额度与订阅。' : viewDescriptions[view]}
        query={query} searchRef={searchRef} busy={busy}
        onQuery={value => { if (dirty) guarded(() => setQuery(value)); else { setEditing(null); setQuery(value); } }}
        onRefresh={() => guarded(() => void load().catch(failure => setError(failure.message)))}
        newLabel={!searching ? newAction?.label : undefined} onNew={!searching ? newAction?.run : undefined}
      />
      {error && <div className="error-banner" role="alert"><AlertCircle size={16} /><span>{error}</span><button className="icon-button small" aria-label="关闭错误提示" onClick={() => setError('')}><X size={15} /></button></div>}
      {externalChange && <div className="info-banner" role="status"><RefreshCw size={15} /><span>有新的外部改动（例如 folio 命令写入）。保存或取消当前编辑后会自动刷新。</span></div>}
      {notice && <div className="toast" role="status"><Check size={15} /><span>{notice}</span><button className="icon-button small" onClick={() => setNotice('')} aria-label="关闭提示"><X size={14} /></button></div>}
      <div className="content-grid">
        {showSettings ? <SettingsView revision={revision} onNotice={setNotice} onError={reportError} onRestore={restoreBackup} />
        : showActivity ? <ActivityView revision={revision} wide={wide} onOpen={(kind, id) => openEntity(kind, id)} onError={reportError} /> : <>
          <ItemList
            listRef={listRef} loaded={!!state} error={error} items={items} view={view} searching={searching}
            selection={selection} busy={busy} filtersLocked={!!editing} filter={view === 'quotas' ? quotaFilter : subscriptionFilter}
            header={header}
            subscriptionCategories={categoryNames} quotaCategories={quotaCategoryNames}
            onManageCategories={state && (view === 'subscriptions' || view === 'quotas') ? () => setCategoriesOpen(view === 'quotas' ? 'quota' : 'subscription') : undefined}
            onFilter={category => guarded(() => { if (view === 'quotas') setQuotaFilter(category); else setSubscriptionFilter(category); setSelection(null); setDrawerOpen(false); })}
            onChoose={choose} onNew={newAction?.run} onClearSearch={() => setQuery('')}
            onReload={() => void load().catch(failure => setError(failure.message))}
            onScroll={event => { scrollPositions.current[effectiveView] = event.currentTarget.scrollTop; }}
          />
          {!wide && drawerOpen && <button className="drawer-backdrop" onClick={() => guarded(() => setDrawerOpen(false))} aria-label="关闭详情抽屉" />}
          <aside ref={detailRef} className={'detail-pane card ' + (drawerOpen ? 'drawer-open' : '')} aria-label="内容详情" role={!wide && drawerOpen ? 'dialog' : undefined} aria-modal={!wide && drawerOpen ? true : undefined}>{detail}</aside>
        </>}
      </div>
    </main>
    {state && categoriesOpen === 'subscription' && <CategoryManager title="管理订阅分类" itemLabel="订阅" route="/api/subscription-categories"
      categories={state.subscriptionCategories} countOf={id => state.subscriptions.filter(item => item.category === id).length}
      onClose={() => setCategoriesOpen(null)} onRefresh={load} />}
    {state && categoriesOpen === 'quota' && <CategoryManager title="管理额度分类" itemLabel="额度" route="/api/quota-categories"
      categories={state.quotaCategories} countOf={id => state.quotas.filter(item => item.category === id).length}
      onClose={() => setCategoriesOpen(null)} onRefresh={load} />}
    <Confirm value={confirmation} onClose={() => setConfirmation(null)} />
  </div>;
}
