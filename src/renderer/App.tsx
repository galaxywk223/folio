import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { AlertCircle, Archive, ArchiveRestore, ArrowLeft, ArrowUpRight, CalendarDays, Check, CheckCircle2, ChevronRight, Circle, CreditCard, Download, DownloadCloud, ExternalLink, FileText, FolderOpen, HardDrive, KeyRound, Link2, Loader2, MoreHorizontal, Paperclip, Plus, RefreshCw, Search, StickyNote, Trash2, Upload, Wallet, X } from 'lucide-react';
import { getSteps } from '../shared/markdown';
import { assetUrl, daysUntil, openExternal, request, dateTime, fileSize } from './api';
import { Confirm, Editor, Empty, Markdown, Modal } from './components';
import type { Confirmation, EditorHandle } from './components';
import type { ApiQuota, Attachment, Backup, EditorValue, Kind, Note, QuotaDraft, Selection, State, Subscription, SubscriptionDraft, Task, View } from './types';
import type { UpdateStatus } from '../shared/updates';

const navigation = [
  { id: 'pending' as const, title: '待办', icon: Circle },
  { id: 'completed' as const, title: '已完成', icon: CheckCircle2 },
  { id: 'notes' as const, title: '随手记', icon: StickyNote },
  { id: 'attachments' as const, title: '附件', icon: Paperclip },
];
const serviceNav = [
  { id: 'quotas' as const, title: 'API 额度', icon: Wallet },
  { id: 'subscriptions' as const, title: 'AI 订阅', icon: CreditCard },
];
const viewTitles: Record<View, string> = {
  pending: '待办', completed: '已完成', notes: '随手记', attachments: '附件',
  quotas: 'API 额度', subscriptions: 'AI 订阅', trash: '回收站',
};
const viewDescriptions: Record<View, string> = {
  pending: '有日期事项在前，未定日期事项随后。',
  completed: '保留每件事项的说明与步骤记录。',
  notes: '保存想法、信息与日常记录。',
  attachments: '集中查看文件，关联到事项或记录。',
  quotas: '官方与中转 API 余额、入口与备注。',
  subscriptions: '按到期日排序；14 天内到期会高亮提醒。',
  trash: '恢复已删除的事项、记录、附件与服务条目。',
};
type Item = Selection & { title: string; subtitle: string; entity: Task | Note | Attachment | ApiQuota | Subscription };
type Editing =
  | { kind: 'task' | 'note'; id: string | null; initial: EditorValue }
  | { kind: 'quota'; id: string | null; initial: QuotaDraft }
  | { kind: 'subscription'; id: string | null; initial: SubscriptionDraft };

const emptyQuota: QuotaDraft = { kind: '官方', platform: '', entryUrl: '', balance: '', recordedAt: '', note: '' };
const emptySubscription: SubscriptionDraft = { service: '', account: '', plan: '', benefits: '', status: '', cost: '', expiresAt: '', entryUrl: '', note: '' };

export default function App() {
  const [state, setState] = useState<State | null>(null);
  const [view, setView] = useState<View>('pending');
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
  const [linkFile, setLinkFile] = useState<Attachment | null>(null);
  const listRef = useRef<HTMLElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<EditorHandle>(null);
  const scrollPositions = useRef<Record<string, number>>({});
  const effectiveView = query.trim() ? 'search' : view;

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
        if (editing?.kind === 'task' || editing?.kind === 'note') {
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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's' && editing && (editing.kind === 'task' || editing.kind === 'note')) {
        event.preventDefault(); void editorRef.current?.save();
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && !dataOpen && !linkFile && !confirmation) { event.preventDefault(); searchRef.current?.focus(); }
      if (event.key === 'Escape' && !wide && drawerOpen && !dataOpen && !linkFile && !confirmation) guarded(() => setDrawerOpen(false));
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
      ...state.notes.map(note => ({ kind: 'note' as const, id: note.id, title: note.title, subtitle: note.bodyMarkdown, entity: note })),
      ...state.attachments.map(file => ({ kind: 'attachment' as const, id: file.id, title: file.filename, subtitle: fileSize(file.size), entity: file })),
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
          'service' in item.entity ? item.entity.service + item.entity.account + item.entity.plan + item.entity.note + item.entity.status : '',
        ].join('\n').toLocaleLowerCase();
        return hay.includes(keyword);
      });
    }
    if (view === 'trash') return all.filter(item => item.entity.deletedAt).sort((a, b) => b.entity.deletedAt!.localeCompare(a.entity.deletedAt!));
    if (view === 'pending' || view === 'completed') return all.filter(item => !item.entity.deletedAt && item.kind === 'task' && 'status' in item.entity && item.entity.status === view);
    if (view === 'notes') return all.filter(item => !item.entity.deletedAt && item.kind === 'note');
    if (view === 'attachments') return all.filter(item => !item.entity.deletedAt && item.kind === 'attachment');
    if (view === 'quotas') return all.filter(item => !item.entity.deletedAt && item.kind === 'quota');
    if (view === 'subscriptions') return all.filter(item => !item.entity.deletedAt && item.kind === 'subscription');
    return [];
  }, [state, view, query]);
  useEffect(() => {
    if (editing) return;
    if (!selection || !items.some(item => item.id === selection.id && item.kind === selection.kind)) {
      setSelection(items[0] ? { kind: items[0].kind, id: items[0].id } : null);
    }
  }, [items, selection, editing]);
  useLayoutEffect(() => { if (listRef.current) listRef.current.scrollTop = scrollPositions.current[effectiveView] || 0; }, [effectiveView]);
  const selectedItem = items.find(item => item.id === selection?.id && item.kind === selection?.kind);
  const selectedTask = selectedItem?.kind === 'task' ? selectedItem.entity as Task : null;
  const selectedNote = selectedItem?.kind === 'note' ? selectedItem.entity as Note : null;
  const selectedFile = selectedItem?.kind === 'attachment' ? selectedItem.entity as Attachment : null;
  const selectedQuota = selectedItem?.kind === 'quota' ? selectedItem.entity as ApiQuota : null;
  const selectedSub = selectedItem?.kind === 'subscription' ? selectedItem.entity as Subscription : null;
  const counts = state ? {
    pending: state.tasks.filter(task => !task.deletedAt && task.status === 'pending').length,
    completed: state.tasks.filter(task => !task.deletedAt && task.status === 'completed').length,
    notes: state.notes.filter(note => !note.deletedAt).length,
    attachments: state.attachments.filter(file => !file.deletedAt).length,
    quotas: state.quotas.filter(item => !item.deletedAt).length,
    subscriptions: state.subscriptions.filter(item => !item.deletedAt).length,
  } : { pending: 0, completed: 0, notes: 0, attachments: 0, quotas: 0, subscriptions: 0 };
  const trashCount = state ? [...state.tasks, ...state.notes, ...state.attachments, ...state.quotas, ...state.subscriptions].filter(item => item.deletedAt).length : 0;
  const linkedFiles = (type: 'task' | 'note', id: string) => state?.attachments.filter(file => !file.deletedAt && state.links.some(link => link.attachmentId === file.id && link.ownerType === type && link.ownerId === id)) || [];

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
  function startEdit(kind: 'task' | 'note', entity?: Task | Note) {
    guarded(() => {
      setEditing({ kind, id: entity?.id || null, initial: { title: entity?.title || '', bodyMarkdown: entity?.bodyMarkdown || '', dateText: entity && 'dateText' in entity ? entity.dateText : '', version: entity?.version } });
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
          cost: entity.cost, expiresAt: entity.expiresAt, entryUrl: entity.entryUrl, note: entity.note, version: entity.version,
        } : { ...emptySubscription },
      });
      setDrawerOpen(true);
    });
  }
  async function saveEditor(value: EditorValue) {
    if (!editing || (editing.kind !== 'task' && editing.kind !== 'note')) return;
    const record = await request<Task | Note>('/api/' + (editing.kind === 'task' ? 'tasks' : 'notes') + (editing.id ? '/' + editing.id : ''), editing.id ? 'PATCH' : 'POST', value);
    const kind = editing.kind;
    setEditing(null); setDirty(false); setQuery(''); setView(kind === 'task' ? ('status' in record ? record.status : 'pending') : 'notes');
    setSelection({ kind, id: record.id }); setNotice('已保存');
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
    setEditing(null); setDirty(false); setQuery(''); setView('subscriptions'); setSelection({ kind: 'subscription', id: record.id }); setNotice('已保存');
    void load().catch(failure => setError('内容已经保存，列表刷新失败：' + failure.message));
  }
  function completeTask(task: Task) {
    const status = task.status === 'pending' ? 'completed' : 'pending';
    const action = () => operate(() => request('/api/tasks/' + task.id, 'PATCH', { status, version: task.version, confirmIncomplete: true }), status === 'completed' ? '事项已归档，步骤记录保留。' : '事项已恢复到待办。');
    const remaining = getSteps(task.bodyMarkdown).filter(step => !step.checked).length;
    if (status === 'completed' && remaining) setConfirmation({ title: '确认完成整件事项', message: '仍有 ' + remaining + ' 个未完成步骤。归档后保留当前步骤状态。', primary: '完成并归档', action });
    else void action();
  }
  function removeItem(kind: Kind, entity: Task | Note | Attachment | ApiQuota | Subscription) {
    const title = 'filename' in entity ? entity.filename : 'platform' in entity ? entity.platform : 'service' in entity ? entity.service : entity.title;
    const path = { task: 'tasks', note: 'notes', attachment: 'attachments', quota: 'quotas', subscription: 'subscriptions' }[kind];
    setConfirmation({
      title: '移入回收站', message: '“' + title + '”将移入回收站，可随时恢复。', primary: '移入回收站', destructive: true,
      action: () => operate(() => request('/api/' + path + '/' + entity.id, 'DELETE', 'version' in entity ? { version: entity.version } : {}), '已移入回收站'),
    });
  }
  async function uploadFiles(files: File[], owner?: Selection) {
    const data = new FormData();
    files.forEach(file => data.append('files', file));
    if (owner && (owner.kind === 'task' || owner.kind === 'note')) { data.append('ownerType', owner.kind); data.append('ownerId', owner.id); }
    await operate(() => request('/api/attachments', 'POST', data), files.length + ' 个附件已保存到本机');
  }
  async function toggleLink(file: Attachment, ownerType: 'task' | 'note', ownerId: string) {
    const exists = state?.links.some(link => link.attachmentId === file.id && link.ownerType === ownerType && link.ownerId === ownerId);
    await operate(() => request('/api/attachments/' + file.id + '/links', exists ? 'DELETE' : 'POST', { ownerType, ownerId }));
  }
  function jumpToOwner(type: 'task' | 'note', id: string) {
    const owner = type === 'task' ? state?.tasks.find(task => task.id === id) : state?.notes.find(note => note.id === id);
    if (!owner) return;
    guarded(() => { setQuery(''); setView(owner.deletedAt ? 'trash' : type === 'task' ? (owner as Task).status : 'notes'); setSelection({ kind: type, id }); setDrawerOpen(true); });
  }

  const detail = editing?.kind === 'quota' ? <ServiceEditor kind="quota" initial={editing.initial} isNew={!editing.id} onSave={value => void saveQuota(value as QuotaDraft)} onCancel={() => guarded(() => {})} onDirty={setDirty} />
    : editing?.kind === 'subscription' ? <ServiceEditor kind="subscription" initial={editing.initial} isNew={!editing.id} onSave={value => void saveSubscription(value as SubscriptionDraft)} onCancel={() => guarded(() => {})} onDirty={setDirty} />
    : editing && (editing.kind === 'task' || editing.kind === 'note') ? <Editor key={editing.kind + (editing.id || '-new')} ref={editorRef} initial={editing.initial} kind={editing.kind} isNew={!editing.id} onSave={saveEditor} onDirty={setDirty} onCancel={() => guarded(() => {})} />
    : !selectedItem ? <Empty title="选择一项查看详情" text="说明、检查步骤、服务信息与相关附件会显示在这里。" icon={<FileText size={26} />} />
    : view === 'trash' && !query.trim() ? <div className="detail-layout">
      <DetailToolbar caption="回收站内容" onClose={() => setDrawerOpen(false)} />
      <div className="detail-scroll"><h2 className="detail-title">{selectedItem.title}</h2><p className="muted">删除于 {dateTime(selectedItem.entity.deletedAt)}</p>
        {'bodyMarkdown' in selectedItem.entity && <Markdown body={selectedItem.entity.bodyMarkdown} />}
        <div className="recycle-note"><ArchiveRestore size={20} /><p>正文、步骤状态与附件关联均保留。</p></div>
      </div>
      <div className="detail-footer"><button className="button primary" disabled={busy} onClick={() => void operate(() => request('/api/trash/' + selectedItem.kind + '/' + selectedItem.id + '/restore', 'POST'), '已从回收站恢复')}><ArchiveRestore size={16} />恢复内容</button></div>
    </div>
    : selectedTask ? <div className="detail-layout">
      <DetailToolbar caption="事项详情" onClose={() => setDrawerOpen(false)} onEdit={() => startEdit('task', selectedTask)} onDelete={() => removeItem('task', selectedTask)} />
      <div className="detail-scroll"><h2 className="detail-title">{selectedTask.title}</h2><div className="detail-meta">{selectedTask.dateText && <span><CalendarDays size={14} />{selectedTask.dateText}</span>}<span className={selectedTask.status === 'completed' ? 'completed-tag' : ''}>{selectedTask.status === 'completed' ? '已完成 · ' + dateTime(selectedTask.completedAt) : '待处理'}</span></div>
        {getSteps(selectedTask.bodyMarkdown).length > 0 && <Progress body={selectedTask.bodyMarkdown} />}
        {selectedTask.bodyMarkdown ? <Markdown body={selectedTask.bodyMarkdown} disabled={busy} onToggle={(index, checked) => void operate(() => request('/api/tasks/' + selectedTask.id + '/steps', 'POST', { index, checked, version: selectedTask.version }))} /> : <p className="muted no-description">暂无说明。编辑事项可添加正文和检查步骤。</p>}
        <AttachmentSection files={linkedFiles('task', selectedTask.id)} busy={busy} onUpload={files => void uploadFiles(files, { kind: 'task', id: selectedTask.id })} onManage={() => { setView('attachments'); setQuery(''); setSelection(null); }} />
      </div><div className="detail-footer"><span className="muted">更新于 {dateTime(selectedTask.updatedAt)}</span><button className={'button ' + (selectedTask.status === 'pending' ? 'primary' : 'secondary')} disabled={busy} onClick={() => completeTask(selectedTask)}>{selectedTask.status === 'pending' ? <><Check size={16} />完成事项</> : <><ArchiveRestore size={16} />恢复待办</>}</button></div>
    </div>
    : selectedNote ? <div className="detail-layout">
      <DetailToolbar caption="随手记录" onClose={() => setDrawerOpen(false)} onEdit={() => startEdit('note', selectedNote)} onDelete={() => removeItem('note', selectedNote)} />
      <div className="detail-scroll"><h2 className="detail-title">{selectedNote.title}</h2><div className="detail-meta"><span>更新于 {dateTime(selectedNote.updatedAt)}</span></div>{selectedNote.bodyMarkdown ? <Markdown body={selectedNote.bodyMarkdown} /> : <p className="muted no-description">记录正文为空。</p>}
        <AttachmentSection files={linkedFiles('note', selectedNote.id)} busy={busy} onUpload={files => void uploadFiles(files, { kind: 'note', id: selectedNote.id })} onManage={() => changeView('attachments')} />
      </div>
    </div>
    : selectedQuota ? <div className="detail-layout">
      <DetailToolbar caption="API 额度" onClose={() => setDrawerOpen(false)} onEdit={() => startQuotaEdit(selectedQuota)} onDelete={() => removeItem('quota', selectedQuota)} />
      <div className="detail-scroll"><h2 className="detail-title">{selectedQuota.platform}</h2>
        <div className="detail-meta"><span>{selectedQuota.kind}</span>{selectedQuota.recordedAt && <span>记录于 {selectedQuota.recordedAt}</span>}</div>
        <dl className="file-properties"><dt>余额</dt><dd>{selectedQuota.balance || '—'}</dd><dt>备注</dt><dd>{selectedQuota.note || '—'}</dd></dl>
        {selectedQuota.entryUrl && <button className="button secondary download-full" onClick={() => void openExternal(selectedQuota.entryUrl)}><ExternalLink size={16} />打开入口</button>}
      </div>
    </div>
    : selectedSub ? <div className="detail-layout">
      <DetailToolbar caption="AI 订阅" onClose={() => setDrawerOpen(false)} onEdit={() => startSubEdit(selectedSub)} onDelete={() => removeItem('subscription', selectedSub)} />
      <div className="detail-scroll">
        <h2 className="detail-title">{selectedSub.service}</h2>
        <div className="detail-meta">
          {selectedSub.account && <span>{selectedSub.account}</span>}
          {selectedSub.expiresAt && <span className={expiryClass(selectedSub.expiresAt)}><CalendarDays size={14} />到期 {selectedSub.expiresAt}{expiryLabel(selectedSub.expiresAt)}</span>}
        </div>
        <dl className="file-properties">
          <dt>套餐</dt><dd>{selectedSub.plan || '—'}</dd>
          <dt>权益</dt><dd>{selectedSub.benefits || '—'}</dd>
          <dt>状态</dt><dd>{selectedSub.status || '—'}</dd>
          <dt>费用</dt><dd>{selectedSub.cost || '—'}</dd>
          <dt>备注</dt><dd>{selectedSub.note || '—'}</dd>
        </dl>
        {selectedSub.entryUrl && <button className="button secondary download-full" onClick={() => void openExternal(selectedSub.entryUrl)}><ExternalLink size={16} />打开入口</button>}
      </div>
    </div>
    : selectedFile ? <div className="detail-layout">
      <DetailToolbar caption="文件信息" onClose={() => setDrawerOpen(false)} onDelete={() => removeItem('attachment', selectedFile)} />
      <div className="detail-scroll"><div className="file-detail-icon"><FileText size={30} /></div><h2 className="detail-title">{selectedFile.filename}</h2><dl className="file-properties"><dt>大小</dt><dd>{fileSize(selectedFile.size)}</dd><dt>添加时间</dt><dd>{dateTime(selectedFile.createdAt)}</dd><dt>保存位置</dt><dd>本机附件目录</dd></dl><a className="button secondary download-full" href={assetUrl('/api/attachments/' + selectedFile.id + '/download')}><Download size={16} />下载文件</a>
        <section className="related-section"><div className="section-heading"><h3>关联内容</h3><button className="text-button" onClick={() => setLinkFile(selectedFile)}><Link2 size={14} />管理关联</button></div>
          {state?.links.filter(link => link.attachmentId === selectedFile.id).length ? state.links.filter(link => link.attachmentId === selectedFile.id).map(link => {
            const owner = link.ownerType === 'task' ? state.tasks.find(task => task.id === link.ownerId) : state.notes.find(note => note.id === link.ownerId);
            return <button key={link.ownerType + link.ownerId} className="related-row" onClick={() => jumpToOwner(link.ownerType, link.ownerId)}><span>{owner?.title || '关联内容'}{owner?.deletedAt && <small>回收站</small>}</span><ArrowUpRight size={15} /></button>;
          }) : <p className="muted">尚未关联到事项或记录。</p>}
        </section>
      </div>
    </div> : null;

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark" aria-hidden="true"><FolioMark /></span><span>Folio</span></div>
      <p className="nav-caption">事务</p>
      <nav aria-label="事务导航">{navigation.map(item => <button key={item.id} className={'nav-item ' + (view === item.id && !query.trim() ? 'active' : '')} onClick={() => changeView(item.id)} title={item.title}><item.icon size={18} /><span>{item.title}</span><small>{counts[item.id]}</small></button>)}</nav>
      <p className="nav-caption service-caption">服务</p>
      <nav aria-label="服务导航">{serviceNav.map(item => <button key={item.id} className={'nav-item ' + (view === item.id && !query.trim() ? 'active' : '')} onClick={() => changeView(item.id)} title={item.title}><item.icon size={18} /><span>{item.title}</span><small>{counts[item.id]}</small></button>)}</nav>
      <div className="sidebar-bottom">
        <button className={'nav-item ' + (view === 'trash' && !query.trim() ? 'active' : '')} onClick={() => changeView('trash')} title="回收站"><Trash2 size={17} /><span>回收站</span>{trashCount > 0 && <small>{trashCount}</small>}</button>
        <button className="nav-item" onClick={() => guarded(() => setDataOpen(true))} title="备份与导出"><HardDrive size={17} /><span>备份与导出</span></button>
        <UpdatePanel onNotice={setNotice} onError={setError} />
        <div className="local-status"><span />本地保存 · 离线可用</div>
      </div>
    </aside>
    <main className="workspace">
      <header className="topbar">
        <div className="page-heading"><h1>{query.trim() ? '搜索结果' : viewTitles[view]}</h1><p>{query.trim() ? '搜索事项、记录、额度与订阅。' : viewDescriptions[view]}</p></div>
        <div className="topbar-actions">
          <label className="search-field"><Search size={16} /><input ref={searchRef} value={query} onChange={event => { const value = event.target.value; if (dirty) guarded(() => setQuery(value)); else { setEditing(null); setQuery(value); } }} placeholder="搜索全部内容" aria-label="搜索全部内容" />{query ? <button className="icon-button" aria-label="清除搜索" onClick={() => setQuery('')}><X size={14} /></button> : <kbd>Ctrl K</kbd>}</label>
          <button className="icon-button refresh-button" title="重新读取数据" aria-label="重新读取数据" disabled={busy} onClick={() => guarded(() => void load().catch(failure => setError(failure.message)))}><RefreshCw size={16} /></button>
          {(view === 'pending' || view === 'notes') && !query.trim() && <button className="button primary new-button" onClick={() => startEdit(view === 'notes' ? 'note' : 'task')}><Plus size={16} /><span>{view === 'notes' ? '新记录' : '新事项'}</span></button>}
          {view === 'quotas' && !query.trim() && <button className="button primary new-button" onClick={() => startQuotaEdit()}><Plus size={16} /><span>新额度</span></button>}
          {view === 'subscriptions' && !query.trim() && <button className="button primary new-button" onClick={() => startSubEdit()}><Plus size={16} /><span>新订阅</span></button>}
          {view === 'attachments' && !query.trim() && <FilePicker busy={busy} label="添加文件" onPick={files => void uploadFiles(files)} />}
        </div>
      </header>
      {error && <div className="error-banner" role="alert"><AlertCircle size={16} /><span>{error}</span><button className="icon-button" aria-label="关闭错误提示" onClick={() => setError('')}><X size={16} /></button></div>}
      {notice && <div className="notice" role="status"><Check size={15} /><span>{notice}</span><button className="icon-button" onClick={() => setNotice('')} aria-label="关闭提示"><X size={14} /></button></div>}
      <div className="content-grid">
        <section ref={listRef} className="list-pane" aria-label="内容列表" onScroll={event => { scrollPositions.current[effectiveView] = event.currentTarget.scrollTop; }}>
          <div className="list-heading"><span>{items.length} {view === 'attachments' && !query ? '个文件' : '项内容'}</span><span>{busy ? <><Loader2 className="spinning" size={13} />正在保存</> : query.trim() ? '全部记录' : view === 'notes' ? '最近更新在前' : view === 'trash' ? '最近删除在前' : view === 'attachments' ? '最近添加在前' : view === 'subscriptions' ? '按到期排序' : view === 'quotas' ? '按平台排序' : '按日期排序'}</span></div>
          {!state ? <Empty title={error ? '暂时无法读取数据' : '正在读取本地记录'} text={error ? '本地服务恢复后可重新读取，编辑内容不会清空。' : '正在连接本机服务。'} action={error ? () => void load().catch(failure => setError(failure.message)) : undefined} actionLabel="重新读取" icon={<Loader2 size={25} className={error ? '' : 'spinning'} />} /> :
            !items.length ? <Empty
              title={query.trim() ? '没有找到匹配内容' : view === 'pending' ? '待办列表为空' : view === 'completed' ? '还没有已完成事项' : view === 'notes' ? '还没有随手记录' : view === 'attachments' ? '附件目录为空' : view === 'quotas' ? '还没有额度记录' : view === 'subscriptions' ? '还没有订阅记录' : '回收站为空'}
              text={query.trim() ? '尝试其他关键词，或清除搜索查看全部内容。' : view === 'completed' ? '完成的事项会保留在这里。' : view === 'trash' ? '删除内容后，可在这里恢复。' : view === 'attachments' ? '通过“添加文件”保存文件，或从事项详情中添加。' : view === 'quotas' ? '记录官方与中转平台的余额与入口。' : view === 'subscriptions' ? '记录套餐、费用与到期日。' : '从一条真实事项或记录开始。'}
              action={query.trim() ? () => setQuery('') : view === 'pending' || view === 'notes' ? () => startEdit(view === 'notes' ? 'note' : 'task') : view === 'quotas' ? () => startQuotaEdit() : view === 'subscriptions' ? () => startSubEdit() : undefined}
              actionLabel={query.trim() ? '清除搜索' : '新建'}
              icon={view === 'notes' ? <StickyNote size={27} /> : view === 'attachments' ? <FolderOpen size={27} /> : view === 'completed' ? <Archive size={27} /> : view === 'trash' ? <Trash2 size={27} /> : view === 'quotas' ? <KeyRound size={27} /> : view === 'subscriptions' ? <CreditCard size={27} /> : <Circle size={27} />}
            /> :
            <div className="content-list">{items.map((item, index) => <div key={item.kind + item.id}>
              {!query && view === 'pending' && item.kind === 'task' && !(item.entity as Task).dateText && (index === 0 || (items[index - 1].entity as Task).dateText) && <div className="list-group-label">未定日期</div>}
              <button className={'content-row ' + (selection?.id === item.id && selection.kind === item.kind ? 'selected' : '') + (item.kind === 'subscription' && expiryUrgent((item.entity as Subscription).expiresAt) ? ' urgent' : '')} onClick={() => choose(item)} aria-pressed={selection?.id === item.id && selection.kind === item.kind}>
                <span className={'row-icon ' + item.kind}>
                  {item.kind === 'task' ? ((item.entity as Task).status === 'completed' ? <CheckCircle2 size={18} /> : <Circle size={18} />)
                    : item.kind === 'note' ? <FileText size={18} />
                    : item.kind === 'attachment' ? <Paperclip size={18} />
                    : item.kind === 'quota' ? <Wallet size={18} />
                    : <CreditCard size={18} />}
                </span>
                <span className="row-content"><strong>{item.title}</strong><span className="row-metadata">
                  {view === 'trash' && !query ? <span>删除于 {dateTime(item.entity.deletedAt)}</span>
                    : item.kind === 'task' ? <><span className={(item.entity as Task).dateText ? 'date-label' : ''}>{(item.entity as Task).dateText || '未定日期'}</span>{getSteps((item.entity as Task).bodyMarkdown).length > 0 && <span>{getSteps((item.entity as Task).bodyMarkdown).filter(step => step.checked).length}/{getSteps((item.entity as Task).bodyMarkdown).length} 步骤</span>}{linkedFiles('task', item.id).length > 0 && <span><Paperclip size={12} />{linkedFiles('task', item.id).length}</span>}{query && <span>{(item.entity as Task).status === 'completed' ? '已完成' : '待办'}</span>}</>
                    : item.kind === 'note' ? <span className="note-excerpt">{(item.entity as Note).bodyMarkdown.replace(/[#*_\n\r]/g, ' ').slice(0, 65) || '正文为空'}</span>
                    : item.kind === 'quota' ? <span>{(item.entity as ApiQuota).kind} · {(item.entity as ApiQuota).balance || '余额未填'}{(item.entity as ApiQuota).recordedAt ? ' · ' + (item.entity as ApiQuota).recordedAt : ''}</span>
                    : item.kind === 'subscription' ? <span className={expiryClass((item.entity as Subscription).expiresAt)}>{(item.entity as Subscription).plan || '未填套餐'}{(item.entity as Subscription).expiresAt ? ' · 到期 ' + (item.entity as Subscription).expiresAt + expiryLabel((item.entity as Subscription).expiresAt) : ''}</span>
                    : <span>{fileSize((item.entity as Attachment).size)} · {dateTime((item.entity as Attachment).createdAt)}</span>}
                </span></span><ChevronRight className="row-arrow" size={16} />
              </button>
            </div>)}</div>}
        </section>
        {!wide && drawerOpen && <button className="drawer-backdrop" onClick={() => guarded(() => setDrawerOpen(false))} aria-label="关闭详情抽屉" />}
        <aside ref={detailRef} className={'detail-pane ' + (drawerOpen ? 'drawer-open' : '')} aria-label="内容详情" role={!wide && drawerOpen ? 'dialog' : undefined} aria-modal={!wide && drawerOpen ? true : undefined}>{detail}</aside>
      </div>
    </main>
    <Confirm value={confirmation} onClose={() => setConfirmation(null)} />
    <DataManager open={dataOpen} onOpenChange={setDataOpen} onNotice={setNotice} onError={setError} onRestore={async (action) => {
      setConfirmation({ title: '从完整备份恢复', message: '恢复将替换应用中的事项、记录、附件与服务条目。当前数据会先自动备份。', primary: '备份当前数据并恢复', action: () => operate(async () => { await action(); setDataOpen(false); setSelection(null); setQuery(''); setView('pending'); }, '备份已恢复，恢复前的数据另有自动备份。') });
    }} />
    <LinkManager file={linkFile} state={state} busy={busy} onClose={() => setLinkFile(null)} onToggle={(type, id) => linkFile && void toggleLink(linkFile, type, id)} />
  </div>;
}

function FolioMark() {
  return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <rect x="2.5" y="2.5" width="6.2" height="13" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
    <rect x="9.3" y="2.5" width="6.2" height="13" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
    <path d="M4.2 7h2.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <circle cx="12.4" cy="9" r="1.15" fill="currentColor" />
  </svg>;
}

function UpdatePanel({ onNotice, onError }: { onNotice: (value: string) => void; onError: (value: string) => void }) {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!window.folio?.getUpdateStatus) return;
    void window.folio.getUpdateStatus().then(setStatus).catch(() => undefined);
    return window.folio.onUpdateStatus?.(setStatus);
  }, []);
  if (!window.folio?.checkForUpdates) return null;
  const phase = status?.phase || 'idle';
  const disabled = busy || phase === 'unsupported' || phase === 'checking' || phase === 'available' || phase === 'downloading';
  const label = phase === 'downloaded' ? '重启安装' : phase === 'downloading' ? `下载中 ${status?.download_percent ?? 0}%` : phase === 'checking' ? '检查中…' : '检查更新';
  async function act() {
    setBusy(true);
    try {
      if (phase === 'downloaded') {
        const result = await window.folio!.installUpdate();
        if (!result.started) onNotice('已取消安装更新');
      } else {
        const next = await window.folio!.checkForUpdates();
        setStatus(next);
        if (next.phase === 'up-to-date') onNotice('已是最新版本 ' + next.current_version);
        else if (next.phase === 'unsupported') onNotice(next.message || '仅正式安装版支持更新');
        else if (next.phase === 'error') onError(next.message || '检查更新失败');
      }
    } catch (failure) {
      onError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return <div className="update-panel">
    <button className="nav-item" disabled={disabled} onClick={() => void act()} title={status?.message || label}>
      <DownloadCloud size={17} /><span>{label}</span>
      {status?.available_version && phase !== 'up-to-date' && <small>v{status.available_version}</small>}
    </button>
    {phase === 'downloading' && <div className="update-progress" aria-hidden="true"><span style={{ width: (status?.download_percent ?? 0) + '%' }} /></div>}
    {phase === 'unsupported' && <p className="update-hint">{status?.message}</p>}
    {phase === 'error' && status?.message && <p className="update-hint error">{status.message}</p>}
  </div>;
}

function expiryUrgent(dateText: string) {
  const days = daysUntil(dateText);
  return days !== null && days <= 14;
}
function expiryClass(dateText: string) {
  const days = daysUntil(dateText);
  if (days === null) return '';
  if (days < 0) return 'expiry-overdue';
  if (days <= 14) return 'expiry-soon';
  return '';
}
function expiryLabel(dateText: string) {
  const days = daysUntil(dateText);
  if (days === null) return '';
  if (days < 0) return ` · 已过期 ${-days} 天`;
  if (days === 0) return ' · 今天到期';
  if (days <= 14) return ` · ${days} 天后`;
  return '';
}

function DetailToolbar({ caption, onClose, onEdit, onDelete }: { caption: string; onClose: () => void; onEdit?: () => void; onDelete?: () => void }) {
  return <div className="detail-toolbar"><button className="icon-button drawer-close" onClick={onClose} aria-label="返回列表"><ArrowLeft size={18} /></button><span className="detail-caption">{caption}</span><div className="detail-tools">{onEdit && <button className="text-button" onClick={onEdit}><FileText size={14} />编辑</button>}{onDelete && <DropdownMenu.Root><DropdownMenu.Trigger className="icon-button" aria-label="更多操作"><MoreHorizontal size={19} /></DropdownMenu.Trigger><DropdownMenu.Portal><DropdownMenu.Content className="dropdown" sideOffset={6} align="end"><DropdownMenu.Item className="dropdown-item destructive" onSelect={onDelete}><Trash2 size={15} />移入回收站</DropdownMenu.Item></DropdownMenu.Content></DropdownMenu.Portal></DropdownMenu.Root>}</div></div>;
}
function Progress({ body }: { body: string }) {
  const steps = getSteps(body), completed = steps.filter(step => step.checked).length;
  return <div className="step-progress"><div><span>检查步骤</span><span>{completed} / {steps.length}</span></div><div className="progress-track"><span style={{ width: completed / steps.length * 100 + '%' }} /></div></div>;
}
function FilePicker({ label = '添加附件', busy = false, onPick }: { label?: string; busy?: boolean; onPick: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return <><button className="button secondary" disabled={busy} onClick={() => input.current?.click()}><Upload size={15} /><span>{label}</span></button><input ref={input} type="file" hidden multiple onChange={event => { const files = [...(event.target.files || [])]; event.target.value = ''; if (files.length) onPick(files); }} /></>;
}
function AttachmentSection({ files, busy, onUpload, onManage }: { files: Attachment[]; busy: boolean; onUpload: (files: File[]) => void; onManage: () => void }) {
  return <section className="related-section"><div className="section-heading"><h3>相关附件 <small>{files.length}</small></h3><FilePicker busy={busy} onPick={onUpload} /></div>{files.length ? files.map(file => <a className="attached-file" key={file.id} href={assetUrl('/api/attachments/' + file.id + '/download')}><FileText size={17} /><span>{file.filename}<small>{fileSize(file.size)}</small></span><Download size={15} /></a>) : <p className="muted">暂无附件，可添加本地文件。</p>}<button className="text-button manage-files" onClick={onManage}>查看全部附件<ArrowUpRight size={13} /></button></section>;
}
function LinkManager({ file, state, busy, onClose, onToggle }: { file: Attachment | null; state: State | null; busy: boolean; onClose: () => void; onToggle: (type: 'task' | 'note', id: string) => void }) {
  const [tab, setTab] = useState<'task' | 'note'>('task');
  const [search, setSearch] = useState('');
  const owners = state ? (tab === 'task' ? state.tasks : state.notes).filter(owner => !owner.deletedAt && owner.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())) : [];
  return <Modal open={!!file} onOpenChange={open => !open && onClose()} title="管理附件关联" description={file?.filename + ' · 关联变更即时保存'}>
    <div className="link-filters"><div className="segmented"><button className={tab === 'task' ? 'active' : ''} onClick={() => setTab('task')}>事项</button><button className={tab === 'note' ? 'active' : ''} onClick={() => setTab('note')}>记录</button></div><input className="plain-input" value={search} onChange={event => setSearch(event.target.value)} placeholder="搜索关联内容" aria-label="搜索关联内容" /></div>
    <div className="link-options">{owners.map(owner => {
      const linked = state?.links.some(link => link.attachmentId === file?.id && link.ownerType === tab && link.ownerId === owner.id);
      return <button key={owner.id} className={'link-option ' + (linked ? 'linked' : '')} disabled={busy} onClick={() => onToggle(tab, owner.id)} aria-pressed={linked}><span className="link-check">{linked ? <Check size={14} /> : <Plus size={14} />}</span><span>{owner.title}</span><small>{linked ? '已关联' : '关联'}</small></button>;
    })}{!owners.length && <p className="muted">暂无可关联内容。</p>}</div>
  </Modal>;
}
function DataManager({ open, onOpenChange, onNotice, onError, onRestore }: { open: boolean; onOpenChange: (open: boolean) => void; onNotice: (value: string) => void; onError: (value: string) => void; onRestore: (action: () => Promise<unknown>) => Promise<void> }) {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [working, setWorking] = useState(false);
  const [exported, setExported] = useState<{ directory: string; downloadUrl: string } | null>(null);
  const restoreInput = useRef<HTMLInputElement>(null);
  const refresh = () => request<Backup[]>('/api/backups').then(setBackups).catch(failure => onError(failure.message));
  useEffect(() => { if (open) void refresh(); }, [open]);
  async function action(work: () => Promise<void>) {
    setWorking(true);
    try { await work(); } catch (failure) { onError((failure as Error).message); }
    finally { setWorking(false); }
  }
  return <Modal open={open} onOpenChange={value => !working && onOpenChange(value)} title="备份与导出" description="完整备份包含数据库、附件、回收站与服务条目；Markdown 导出包含当前可见记录。">
    <div className="data-action"><div><h3>导出 Markdown</h3><p>保留日期、正文、检查步骤与服务表，另存到独立导出目录。</p></div><button className="button secondary" disabled={working} onClick={() => void action(async () => { const result = await request<{ directory: string; downloadUrl: string }>('/api/export', 'POST'); setExported(result); onNotice('已另存到 ' + result.directory); })}><Download size={15} />导出</button></div>
    {exported && <div className="export-result"><span>{exported.directory}</span><a href={assetUrl(exported.downloadUrl)}>下载导出包<Download size={14} /></a></div>}
    <div className="data-action"><div><h3>完整备份</h3><p>备份文件保存在本机“备份”目录，可下载另存。</p></div><button className="button primary" disabled={working} onClick={() => void action(async () => { await request('/api/backups', 'POST'); await refresh(); onNotice('完整备份已保存'); })}><Archive size={15} />创建备份</button></div>
    <div className="backup-list">{backups.map(item => <div className="backup-row" key={item.id}><Archive size={17} /><span><strong>{dateTime(item.createdAt)}</strong><small>{fileSize(item.size)} · {item.filename}</small></span><a className="icon-button" href={assetUrl('/api/backups/' + item.id + '/download')} aria-label={'下载备份 ' + item.filename}><Download size={16} /></a><button className="text-button" disabled={working} onClick={() => void onRestore(() => request('/api/backups/' + item.id + '/restore', 'POST'))}>恢复</button></div>)}{!backups.length && <p className="muted">尚未创建完整备份。</p>}</div>
    <div className="restore-upload"><span>已有其他备份文件</span><button className="text-button" disabled={working} onClick={() => restoreInput.current?.click()}><Upload size={14} />选择备份恢复</button><input type="file" accept=".zip" ref={restoreInput} hidden onChange={event => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (file) void onRestore(() => { const form = new FormData(); form.append('file', file); return request('/api/restore', 'POST', form); });
    }} /></div>
  </Modal>;
}

function ServiceEditor({ kind, initial, isNew, onSave, onCancel, onDirty }: {
  kind: 'quota' | 'subscription';
  initial: QuotaDraft | SubscriptionDraft;
  isNew: boolean;
  onSave: (value: QuotaDraft | SubscriptionDraft) => Promise<void> | void;
  onCancel: () => void;
  onDirty: (value: boolean) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  function setField<K extends string>(key: K, value: string) {
    setDraft(current => ({ ...current, [key]: value }));
  }
  async function save() {
    if (saving) return;
    if (kind === 'quota' && !(draft as QuotaDraft).platform.trim()) { setError('平台名称不能为空。'); return; }
    if (kind === 'subscription' && !(draft as SubscriptionDraft).service.trim()) { setError('服务名称不能为空。'); return; }
    setSaving(true); setError('');
    try { await onSave(draft); onDirty(false); }
    catch (failure) { setError((failure as Error).message); }
    finally { setSaving(false); }
  }
  return <div className="editor-layout">
    <div className="detail-toolbar"><span className="detail-caption">{isNew ? '新建' : '编辑'}{kind === 'quota' ? '额度' : '订阅'}</span><button className="icon-button" onClick={onCancel} aria-label="取消编辑"><X size={18} /></button></div>
    <div className="editor-scroll service-form">
      {kind === 'quota' ? <>
        <label className="field-label">类型</label>
        <div className="segmented kind-segment"><button className={(draft as QuotaDraft).kind === '官方' ? 'active' : ''} onClick={() => setField('kind', '官方')}>官方</button><button className={(draft as QuotaDraft).kind === '中转' ? 'active' : ''} onClick={() => setField('kind', '中转')}>中转</button></div>
        <label className="field-label" htmlFor="q-platform">平台</label>
        <input id="q-platform" className="title-field" value={(draft as QuotaDraft).platform} onChange={e => setField('platform', e.target.value)} disabled={saving} />
        <label className="field-label" htmlFor="q-balance">余额</label>
        <input id="q-balance" className="title-field" value={(draft as QuotaDraft).balance} onChange={e => setField('balance', e.target.value)} disabled={saving} />
        <label className="field-label" htmlFor="q-url">入口 URL</label>
        <input id="q-url" className="title-field" value={(draft as QuotaDraft).entryUrl} onChange={e => setField('entryUrl', e.target.value)} disabled={saving} />
        <label className="field-label" htmlFor="q-date">记录日期</label>
        <input id="q-date" type="date" className="title-field" value={(draft as QuotaDraft).recordedAt} onChange={e => setField('recordedAt', e.target.value)} disabled={saving} />
        <label className="field-label" htmlFor="q-note">备注</label>
        <textarea id="q-note" className="body-editor short" value={(draft as QuotaDraft).note} onChange={e => setField('note', e.target.value)} disabled={saving} />
      </> : <>
        <label className="field-label" htmlFor="s-service">服务</label>
        <input id="s-service" className="title-field" value={(draft as SubscriptionDraft).service} onChange={e => setField('service', e.target.value)} disabled={saving} />
        <label className="field-label" htmlFor="s-account">账号</label>
        <input id="s-account" className="title-field" value={(draft as SubscriptionDraft).account} onChange={e => setField('account', e.target.value)} disabled={saving} />
        <label className="field-label" htmlFor="s-plan">套餐</label>
        <input id="s-plan" className="title-field" value={(draft as SubscriptionDraft).plan} onChange={e => setField('plan', e.target.value)} disabled={saving} />
        <label className="field-label" htmlFor="s-benefits">权益</label>
        <input id="s-benefits" className="title-field" value={(draft as SubscriptionDraft).benefits} onChange={e => setField('benefits', e.target.value)} disabled={saving} />
        <label className="field-label" htmlFor="s-status">状态</label>
        <input id="s-status" className="title-field" value={(draft as SubscriptionDraft).status} onChange={e => setField('status', e.target.value)} disabled={saving} />
        <label className="field-label" htmlFor="s-cost">费用</label>
        <input id="s-cost" className="title-field" value={(draft as SubscriptionDraft).cost} onChange={e => setField('cost', e.target.value)} disabled={saving} />
        <label className="field-label" htmlFor="s-exp">到期日</label>
        <input id="s-exp" type="date" className="title-field" value={(draft as SubscriptionDraft).expiresAt} onChange={e => setField('expiresAt', e.target.value)} disabled={saving} />
        <label className="field-label" htmlFor="s-url">入口 URL</label>
        <input id="s-url" className="title-field" value={(draft as SubscriptionDraft).entryUrl} onChange={e => setField('entryUrl', e.target.value)} disabled={saving} />
        <label className="field-label" htmlFor="s-note">备注</label>
        <textarea id="s-note" className="body-editor short" value={(draft as SubscriptionDraft).note} onChange={e => setField('note', e.target.value)} disabled={saving} />
      </>}
      {error && <div className="inline-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
    </div>
    <div className="editor-footer"><span>{saving ? '正在保存…' : dirty ? '有未保存的修改' : '尚无修改'}</span><button className="button primary" onClick={() => void save()} disabled={saving}>保存</button></div>
  </div>;
}
