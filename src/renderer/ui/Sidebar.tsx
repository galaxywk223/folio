import { CheckCircle2, Circle, CreditCard, HardDrive, Trash2, Wallet } from 'lucide-react';
import { UpdatePanel } from './UpdatePanel';
import type { View } from '../types';

type Counts = Record<'pending' | 'completed' | 'quotas' | 'subscriptions', number>;

const groups = [
  { caption: '事务', label: '事务导航', items: [
    { id: 'pending' as const, title: '待办', icon: Circle },
    { id: 'completed' as const, title: '已完成', icon: CheckCircle2 },
  ] },
  { caption: '服务', label: '服务导航', items: [
    { id: 'quotas' as const, title: 'API 额度', icon: Wallet },
    { id: 'subscriptions' as const, title: '订阅', icon: CreditCard },
  ] },
];

export function Sidebar({ active, counts, trashCount, onView, onData, onNotice, onError }: {
  active: View | null; counts: Counts; trashCount: number;
  onView: (view: View) => void; onData: () => void;
  onNotice: (value: string) => void; onError: (value: string) => void;
}) {
  return <aside className="sidebar card">
    <div className="brand"><span className="brand-mark" aria-hidden="true"><FolioMark /></span><span>Folio</span></div>
    {groups.map(group => <div className="nav-group" key={group.caption}>
      <p className="nav-caption">{group.caption}</p>
      <nav aria-label={group.label}>{group.items.map(item => <button key={item.id} className={'nav-item ' + (active === item.id ? 'active' : '')} onClick={() => onView(item.id)} title={item.title}>
        <item.icon size={17} /><span>{item.title}</span><small>{counts[item.id]}</small>
      </button>)}</nav>
    </div>)}
    <div className="sidebar-bottom">
      <button className={'nav-item ' + (active === 'trash' ? 'active' : '')} onClick={() => onView('trash')} title="回收站"><Trash2 size={17} /><span>回收站</span>{trashCount > 0 && <small>{trashCount}</small>}</button>
      <button className="nav-item" onClick={onData} title="备份与导出"><HardDrive size={17} /><span>备份与导出</span></button>
      <UpdatePanel onNotice={onNotice} onError={onError} />
      <div className="local-status"><span />本地保存 · 离线可用</div>
    </div>
  </aside>;
}

function FolioMark() {
  return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
    <rect x="2.5" y="2.5" width="6.2" height="13" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
    <rect x="9.3" y="2.5" width="6.2" height="13" rx="1.2" stroke="currentColor" strokeWidth="1.5" />
    <path d="M4.2 7h2.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    <circle cx="12.4" cy="9" r="1.15" fill="currentColor" />
  </svg>;
}
