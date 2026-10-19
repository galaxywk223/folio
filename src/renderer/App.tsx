import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, FileText, X } from 'lucide-react';
import { getSteps } from '../shared/markdown';
import { subscriptionCategories, matchesSubscriptionFilter } from '../shared/subscriptions';
import type { SubscriptionFilter } from '../shared/subscriptions';
import { request } from './api';
import { Confirm, Editor, Empty } from './components';
import type { Confirmation, EditorHandle } from './components';
import { parseBalance } from './format';
import type { ApiQuota, EditorValue, Item, Kind, QuotaDraft, Selection, State, Subscription, SubscriptionDraft, Task, View } from './types';
import { DataManager } from './ui/DataManager';
import { QuotaDetail, SubscriptionDetail, TaskDetail, TrashDetail } from './ui/Details';
import { ItemList } from './ui/ItemList';
import { QuotaOverview, SubscriptionOverview } from './ui/Overview';
import { ServiceEditor } from './ui/ServiceEditor';
import { Sidebar } from './ui/Sidebar';
import { Topbar } from './ui/Topbar';

const viewTitles: Record<View, string> = {
  pending: '待办', completed: '已完成', quotas: 'API 额度', subscriptions: '订阅', trash: '回收站',
};
const viewDescriptions: Record<View, string> = {
  pending: '有日期事项在前，未定日期事项随后。',
  completed: '保留每件事项的说明与步骤记录。',
  quotas: '官方与中转 API 余额、入口与备注。',
  subscriptions: '按到期日排序；14 天内到期会高亮提醒。',
  trash: '恢复已删除的事项与服务条目。',
};
type Editing =
  | { kind: 'task'; id: string | null; initial: EditorValue }
  | { kind: 'quota'; id: string | null; initial: QuotaDraft }
  | { kind: 'subscription'; id: string | null; initial: SubscriptionDraft };

const emptyQuota: QuotaDraft = { kind: '官方', platform: '', entryUrl: '', balance: '', recordedAt: '', note: '' };
const emptySubscription: SubscriptionDraft = { service: '', category: 'other', autoRenew: null, account: '', plan: '', benefits: '', status: '', cost: '', expiresAt: '', entryUrl: '', note: '' };

export default function App() {
  const [state, setState] = useState<State | null>(null);
  const [view, setView] = useState<View>('pending');
  const [subscriptionFilter, setSubscriptionFilter] = useState<SubscriptionFilter>('all');
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
  const [dataOpen, setDataOpen] = useState(false);
  const listRef = useRef<HTMLElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<EditorHandle>(null);
  const scrollPositions = useRef<Record<string, number>>({});
  const effectiveView = query.trim() ? 'search' : view === 'subscriptions' ? 'subscriptions-' + subscriptionFilter : view;

  const load = useCallback(async () => {
    const result = await request<State>('/api/state');
    setState(result);
    return result;
  }, []);
  useEffect(() => { void load().catch(failure => setError(failure.message)); }, [load]);
  useEffect(() => {
    const resize = () => setWide(window.innerWidth >= 1180);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !dataOpen && !confirmation) { event.preventDefault(); searchRef.current?.focus(); }
      if (event.key === 'Escape' && !wide && drawerOpen && !dataOpen && !confirmation) guarded(() => setDrawerOpen(false));
    };
    window.addEventListener('keydown', keydown);
    return () => window.removeEventListener('keydown', keydown);
  });
  useEffect(() => {
    if (!wide && drawerOpen) detailRef.current?.querySelector<HTMLElement>('button,input,textarea')?.focus();
  }, [wide, drawerOpen]);

  const items = useMemo<Item[]>(() => {
    if (!state) return [];
    const all: Item[] = [
      ...state.tasks.map(task => ({ kind: 'task' as const, id: task.id, title: task.title, subtitle: task.dateText, entity: task })),
      ...state.quotas.map(item => ({ kind: 'quota' as const, id: item.id, title: item.platform, subtitle: item.balance + ' · ' + item.kind, entity: item })),
      ...state.subscriptions.map(item => ({ kind: 'subscription' as const, id: item.id, title: item.service + (item.account ? ' · ' + item.account : ''), subtitle: [item.plan, item.expiresAt].filter(Boolean).join(' · '), entity: item })),
    ];
    if (query.trim()) {
      const keyword = query.trim().toLocaleLowerCase();
      return all.filter(item => {
        if (item.entity.deletedAt) return false;
        const hay = [
          item.title, item.subtitle,
          'bodyMarkdown' in item.entity ? item.entity.bodyMarkdown : '',
          'platform' in item.entity ? item.entity.platform + item.entity.balance + item.entity.note : '',
          'service' in item.entity ? item.entity.service + item.entity.account + item.entity.plan + item.entity.note + item.entity.status + subscriptionCategories[item.entity.category] : '',
        ].join('\n').toLocaleLowerCase();
        return hay.includes(keyword);
      });
    }
    if (view === 'trash') return all.filter(item => item.entity.deletedAt).sort((a, b) => b.entity.deletedAt!.localeCompare(a.entity.deletedAt!));
    if (view === 'pending' || view === 'completed') return all.filter(item => !item.entity.deletedAt && item.kind === 'task' && (item.entity as Task).status === view);
    if (view === 'quotas') {
      return all
        .filter(item => !item.entity.deletedAt && item.kind === 'quota')
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
  }, [state, view, query, subscriptionFilter]);
  useEffect(() => {
    if (editing) return;
    if (!selection || !items.some(item => item.id === selection.id && item.kind === selection.kind)) {
      setSelection(items[0] ? { kind: items[0].kind, id: items[0].id } : null);
    }
  }, [items, selection, editing]);
  useLayoutEffect(() => { if (listRef.current) listRef.current.scrollTop = scrollPositions.current[effectiveView] || 0; }, [effectiveView]);
  const selectedItem = items.find(item => item.id === selection?.id && item.kind === selection?.kind);
  const selectedTask = selectedItem?.kind === 'task' ? selectedItem.entity as Task : null;
  const selectedQuota = selectedItem?.kind === 'quota' ? selectedItem.entity as ApiQuota : null;
  const selectedSub = selectedItem?.kind === 'subscription' ? selectedItem.entity as Subscription : null;
  const counts = state ? {
    pending: state.tasks.filter(task => !task.deletedAt && task.status === 'pending').length,
    completed: state.tasks.filter(task => !task.deletedAt && task.status === 'completed').length,
    quotas: state.quotas.filter(item => !item.deletedAt).length,
    subscriptions: state.subscriptions.filter(item => !item.deletedAt).length,
  } : { pending: 0, completed: 0, quotas: 0, subscriptions: 0 };
  const trashCount = state ? [...state.tasks, ...state.quotas, ...state.subscriptions].filter(item => item.deletedAt).length : 0;

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
    guarded(() => { setSelection({ kind: item.kind, id: item.id }); setDrawerOpen(true); });
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
        initial: entity ? { kind: entity.kind, platform: entity.platform, entryUrl: entity.entryUrl, balance: entity.balance, recordedAt: entity.recordedAt, note: entity.note, version: entity.version } : { ...emptyQuota },
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
    setEditing(null); setDirty(false); setQuery(''); setView('quotas'); setSelection({ kind: 'quota', id: record.id }); setNotice('已保存');
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
  function completeTask(task: Task) {
    const status = task.status === 'pending' ? 'completed' : 'pending';
    const action = () => operate(() => request('/api/tasks/' + task.id, 'PATCH', { status, version: task.version, confirmIncomplete: true }), status === 'completed' ? '事项已归档，步骤记录保留。' : '事项已恢复到待办。');
    const remaining = getSteps(task.bodyMarkdown).filter(step => !step.checked).length;
    if (status === 'completed' && remaining) setConfirmation({ title: '确认完成整件事项', message: '仍有 ' + remaining + ' 个未完成步骤。归档后保留当前步骤状态。', primary: '完成并归档', action });
    else void action();
  }
  function removeItem(kind: Kind, entity: Task | ApiQuota | Subscription) {
    const title = 'platform' in entity ? entity.platform : 'service' in entity ? entity.service : entity.title;
    const path = { task: 'tasks', quota: 'quotas', subscription: 'subscriptions' }[kind];
    setConfirmation({
      title: '移入回收站', message: '“' + title + '”将移入回收站，可随时恢复。', primary: '移入回收站', destructive: true,
      action: () => operate(() => request('/api/' + path + '/' + entity.id, 'DELETE', { version: entity.version }), '已移入回收站'),
    });
  }

  const searching = !!query.trim();
  const closeDrawer = () => setDrawerOpen(false);
  const newAction = view === 'pending' ? { label: '新事项', run: () => startEdit() }
    : view === 'quotas' ? { label: '新额度', run: () => startQuotaEdit() }
    : view === 'subscriptions' ? { label: '新订阅', run: () => startSubEdit() } : null;

  const detail = editing?.kind === 'quota' ? <ServiceEditor kind="quota" initial={editing.initial} isNew={!editing.id} onSave={value => saveQuota(value as QuotaDraft)} onCancel={() => guarded(() => {})} onDirty={setDirty} />
    : editing?.kind === 'subscription' ? <ServiceEditor kind="subscription" initial={editing.initial} isNew={!editing.id} onSave={value => saveSubscription(value as SubscriptionDraft)} onCancel={() => guarded(() => {})} onDirty={setDirty} />
    : editing?.kind === 'task' ? <Editor key={'task' + (editing.id || '-new')} ref={editorRef} initial={editing.initial} kind="task" isNew={!editing.id} onSave={saveEditor} onDirty={setDirty} onCancel={() => guarded(() => {})} />
    : !selectedItem ? <Empty title="选择一项查看详情" text="说明、检查步骤与服务信息会显示在这里。" icon={<FileText size={26} />} />
    : view === 'trash' && !searching ? <TrashDetail item={selectedItem} busy={busy} onClose={closeDrawer} onRestore={() => void operate(() => request('/api/trash/' + selectedItem.kind + '/' + selectedItem.id + '/restore', 'POST'), '已从回收站恢复')} />
    : selectedTask ? <TaskDetail task={selectedTask} busy={busy} onClose={closeDrawer} onEdit={() => startEdit(selectedTask)} onDelete={() => removeItem('task', selectedTask)}
      onToggleStep={(index, checked) => void operate(() => request('/api/tasks/' + selectedTask.id + '/steps', 'POST', { index, checked, version: selectedTask.version }))} onComplete={() => completeTask(selectedTask)} />
    : selectedQuota ? <QuotaDetail quota={selectedQuota} onClose={closeDrawer} onEdit={() => startQuotaEdit(selectedQuota)} onDelete={() => removeItem('quota', selectedQuota)} />
    : selectedSub ? <SubscriptionDetail sub={selectedSub} onClose={closeDrawer} onEdit={() => startSubEdit(selectedSub)} onDelete={() => removeItem('subscription', selectedSub)} />
    : null;

  return <div className="app-shell">
    <Sidebar active={searching ? null : view} counts={counts} trashCount={trashCount} onView={changeView} onData={() => guarded(() => setDataOpen(true))} onNotice={setNotice} onError={setError} />
    <main className="workspace">
      <Topbar
        title={searching ? '搜索结果' : viewTitles[view]} description={searching ? '搜索事项、额度与订阅。' : viewDescriptions[view]}
        query={query} searchRef={searchRef} busy={busy}
        onQuery={value => { if (dirty) guarded(() => setQuery(value)); else { setEditing(null); setQuery(value); } }}
        onRefresh={() => guarded(() => void load().catch(failure => setError(failure.message)))}
        newLabel={!searching ? newAction?.label : undefined} onNew={!searching ? newAction?.run : undefined}
      />
      {error && <div className="error-banner" role="alert"><AlertCircle size={16} /><span>{error}</span><button className="icon-button small" aria-label="关闭错误提示" onClick={() => setError('')}><X size={15} /></button></div>}
      {notice && <div className="toast" role="status"><Check size={15} /><span>{notice}</span><button className="icon-button small" onClick={() => setNotice('')} aria-label="关闭提示"><X size={14} /></button></div>}
      <div className="content-grid">
        <ItemList
          listRef={listRef} loaded={!!state} error={error} items={items} view={view} searching={searching}
          selection={selection} busy={busy} filtersLocked={!!editing} subscriptionFilter={subscriptionFilter}
          header={state && !searching ? view === 'subscriptions' ? <SubscriptionOverview items={state.subscriptions} /> : view === 'quotas' ? <QuotaOverview items={state.quotas} /> : undefined : undefined}
          onFilter={category => guarded(() => { setSubscriptionFilter(category); setSelection(null); setDrawerOpen(false); })}
          onChoose={choose} onNew={newAction?.run} onClearSearch={() => setQuery('')}
          onReload={() => void load().catch(failure => setError(failure.message))}
          onScroll={event => { scrollPositions.current[effectiveView] = event.currentTarget.scrollTop; }}
        />
        {!wide && drawerOpen && <button className="drawer-backdrop" onClick={() => guarded(() => setDrawerOpen(false))} aria-label="关闭详情抽屉" />}
        <aside ref={detailRef} className={'detail-pane card ' + (drawerOpen ? 'drawer-open' : '')} aria-label="内容详情" role={!wide && drawerOpen ? 'dialog' : undefined} aria-modal={!wide && drawerOpen ? true : undefined}>{detail}</aside>
      </div>
    </main>
    <Confirm value={confirmation} onClose={() => setConfirmation(null)} />
    <DataManager open={dataOpen} onOpenChange={setDataOpen} onNotice={setNotice} onError={setError} onRestore={async (action) => {
      setConfirmation({ title: '从完整备份恢复', message: '恢复将替换应用中的事项与服务条目。当前数据会先自动备份。', primary: '备份当前数据并恢复', action: () => operate(async () => { await action(); setDataOpen(false); setSelection(null); setQuery(''); setView('pending'); }, '备份已恢复，恢复前的数据另有自动备份。') });
    }} />
  </div>;
}
