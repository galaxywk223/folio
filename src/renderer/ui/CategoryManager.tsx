import { useState } from 'react';
import { request } from '../api';
import { Modal } from '../components';
import type { State } from '../types';

export function CategoryManager({ state, onClose, onRefresh }: {
  state: State; onClose: () => void; onRefresh: () => Promise<State>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<{ id: string; name: string; count: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const route = '/api/subscription-categories';

  async function save() {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError('');
    try {
      await request(editing ? route + '/' + editing : route, editing ? 'PATCH' : 'POST', { name });
      setEditing(null);
      setName('');
      await onRefresh();
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  async function remove() {
    if (busy || !deleting) return;
    setBusy(true);
    setError('');
    try {
      await request(route + '/' + deleting.id, 'DELETE', { count: deleting.count });
      await onRefresh();
    } catch (failure) {
      setError((failure as Error).message);
      await onRefresh().catch(() => {});
    } finally {
      setDeleting(null);
      setBusy(false);
    }
  }

  return <Modal open onOpenChange={open => { if (!open && !busy) onClose(); }} title="管理订阅分类">
    <div className="category-manager">
      {deleting ? <>
        <p>删除「{deleting.name}」后，{deleting.count} 条订阅将移到「其他」，数量包含回收站中的订阅。</p>
        <div className="category-row">
          <button className="button secondary" disabled={busy} onClick={() => setDeleting(null)}>取消</button>
          <button className="button danger" disabled={busy} onClick={() => void remove()}>确认删除分类</button>
        </div>
      </> : <>
        <form className="category-row" onSubmit={event => { event.preventDefault(); void save(); }}>
          <input className="input" aria-label="分类名称" placeholder={editing ? '修改分类名称' : '新分类名称'} value={name}
            maxLength={80} disabled={busy} onChange={event => setName(event.target.value)} />
          <button className="button primary" disabled={busy || !name.trim()}>{editing ? '保存名称' : '新增分类'}</button>
          {editing && <button type="button" className="button secondary" disabled={busy} onClick={() => { setEditing(null); setName(''); setError(''); }}>取消改名</button>}
        </form>
        {state.subscriptionCategories.map(category => <div className="category-row" key={category.id}>
          <strong>{category.name}</strong>
          {category.id === 'other' ? <span className="badge">默认分类</span> : <>
            <button className="button secondary" disabled={busy} aria-label={'重命名 ' + category.name}
              onClick={() => { setEditing(category.id); setName(category.name); setError(''); }}>改名</button>
            <button className="button secondary" disabled={busy} aria-label={'删除 ' + category.name}
              onClick={() => {
                setError('');
                setEditing(null);
                setName('');
                setDeleting({ ...category, count: state.subscriptions.filter(item => item.category === category.id).length });
              }}>删除</button>
          </>}
        </div>)}
      </>}
      {error && <div className="inline-error" role="alert">{error}</div>}
    </div>
  </Modal>;
}
