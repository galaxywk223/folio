import { useState } from 'react';
import { request } from '../api';
import { Modal } from '../components';
import type { SubscriptionCategory } from '../../shared/subscriptions';
import type { State } from '../types';

export function CategoryManager({ title, itemLabel, route, categories, countOf, onClose, onRefresh }: {
  title: string; itemLabel: string; route: string; categories: SubscriptionCategory[]; countOf: (id: string) => number;
  onClose: () => void; onRefresh: () => Promise<State>;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [deleting, setDeleting] = useState<{ id: string; name: string; count: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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

  async function move(index: number, offset: -1 | 1) {
    const target = index + offset;
    if (busy || target < 0 || target >= categories.length - 1) return;
    const expectedIds = categories.map(category => category.id);
    const ids = [...expectedIds];
    [ids[index], ids[target]] = [ids[target], ids[index]];
    setBusy(true);
    setError('');
    try {
      await request(route + '/order', 'PATCH', { ids, expectedIds });
      await onRefresh();
    } catch (failure) {
      setError((failure as Error).message);
      await onRefresh().catch(() => {});
    } finally { setBusy(false); }
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

  return <Modal open onOpenChange={open => { if (!open && !busy) onClose(); }} title={title}>
    <div className="category-manager">
      {deleting ? <>
        <p>删除「{deleting.name}」后，{deleting.count} 条{itemLabel}将移到「其他」，数量包含回收站中的{itemLabel}。</p>
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
        {categories.map((category, index) => <div className="category-row" key={category.id}>
          <strong>{category.name}</strong>
          {category.id === 'other' ? <span className="badge">默认分类</span> : <>
            <button className="button secondary" disabled={busy || index === 0} aria-label={'上移 ' + category.name}
              onClick={() => void move(index, -1)}>上移</button>
            <button className="button secondary" disabled={busy || index >= categories.length - 2} aria-label={'下移 ' + category.name}
              onClick={() => void move(index, 1)}>下移</button>
            <button className="button secondary" disabled={busy} aria-label={'重命名 ' + category.name}
              onClick={() => { setEditing(category.id); setName(category.name); setError(''); }}>改名</button>
            <button className="button secondary" disabled={busy} aria-label={'删除 ' + category.name}
              onClick={() => {
                setError('');
                setEditing(null);
                setName('');
                setDeleting({ ...category, count: countOf(category.id) });
              }}>删除</button>
          </>}
        </div>)}
      </>}
      {error && <div className="inline-error" role="alert">{error}</div>}
    </div>
  </Modal>;
}
