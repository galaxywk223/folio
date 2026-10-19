import type { RefObject } from 'react';
import { Plus, RefreshCw, Search, X } from 'lucide-react';

export function Topbar({ title, description, query, searchRef, busy, newLabel, onQuery, onRefresh, onNew }: {
  title: string; description: string; query: string; searchRef: RefObject<HTMLInputElement | null>; busy: boolean;
  newLabel?: string; onQuery: (value: string) => void; onRefresh: () => void; onNew?: () => void;
}) {
  return <header className="topbar">
    <div className="page-heading"><h1>{title}</h1><p>{description}</p></div>
    <div className="topbar-actions">
      <label className="search-field"><Search size={16} />
        <input ref={searchRef} value={query} onChange={event => onQuery(event.target.value)} placeholder="搜索全部内容" aria-label="搜索全部内容" />
        {query ? <button className="icon-button small" aria-label="清除搜索" onClick={() => onQuery('')}><X size={14} /></button> : <kbd>Ctrl K</kbd>}
      </label>
      <button className="icon-button bordered refresh-button" title="重新读取数据" aria-label="重新读取数据" disabled={busy} onClick={onRefresh}><RefreshCw size={16} /></button>
      {onNew && newLabel && <button className="button primary new-button" onClick={onNew}><Plus size={16} /><span>{newLabel}</span></button>}
    </div>
  </header>;
}
