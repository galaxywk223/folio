import { useEffect, useState } from 'react';
import { ArrowLeft, ExternalLink, History, Loader2, Terminal } from 'lucide-react';
import { request, dateTime } from '../api';
import { Empty } from '../components';
import type { Activity, Kind } from '../types';

const actionLabels: Record<Activity['action'], string> = { create: '新建', update: '修改', delete: '移入回收站', restore: '恢复', skip: '跳过一次' };
const kindLabels: Record<string, string> = { task: '待办', event: '日程', quota: '额度', subscription: '订阅', note: '记录' };
const fieldLabels: Record<string, string> = {
  title: '标题', dateText: '日期', bodyMarkdown: '正文', status: '状态', completedAt: '完成时间',
  date: '日期', startTime: '开始', endTime: '结束', location: '地点', note: '备注', repeat: '重复', repeatDays: '重复星期',
  repeatUntil: '重复到', skippedDates: '跳过日期', reminderMinutes: '提醒（分钟）',
  kind: '类型', category: '分类', platform: '平台', account: '账号', entryUrl: '入口', balance: '余额', recordedAt: '记录日期',
  service: '服务', plan: '套餐', benefits: '权益', cost: '费用', expiresAt: '到期日', autoRenew: '自动续费', deletedAt: '删除时间', logo: 'Logo',
};
const ignored = new Set(['id', 'createdAt', 'updatedAt', 'version', 'sortOrder']);

export function sourceLabel(source: string) {
  return source === 'app' ? '应用内' : source === 'cli' ? '命令行' : source;
}
function show(value: unknown) {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.join('、') : '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}
function changes(entry: Activity): [string, unknown, unknown][] {
  const before = entry.before || {}, after = entry.after || {};
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => !ignored.has(key));
  if (entry.action === 'update' || entry.action === 'skip') {
    return keys.filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key])).map(key => [key, before[key], after[key]]);
  }
  const record = entry.after || entry.before || {};
  return keys.filter(key => key !== 'deletedAt' && show(record[key]) !== '—').map(key => [key, undefined, record[key]]);
}

export function ActivityView({ revision, wide, onOpen, onError }: {
  revision: string; wide: boolean;
  onOpen: (kind: Kind, id: string, deleted: boolean) => void; onError: (message: string) => void;
}) {
  const [entries, setEntries] = useState<Activity[] | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    let active = true;
    request<Activity[]>('/api/activity?limit=300').then(rows => { if (active) setEntries(rows); }).catch(failure => onError((failure as Error).message));
    return () => { active = false; };
  }, [revision, onError]);
  const selected = entries?.find(entry => entry.id === selectedId) || entries?.[0] || null;
  const rows = selected ? changes(selected) : [];
  const deleted = !!selected && (selected.action === 'delete' || !!(selected.after && selected.after.deletedAt));
  return <>
    <section className="list-pane card" aria-label="改动记录">
      <div className="list-heading"><span>最近 {entries?.length ?? 0} 条改动</span></div>
      {!entries ? <Empty title="正在读取改动记录" text="正在连接本机服务。" icon={<Loader2 size={25} className="spinning" />} />
        : !entries.length ? <Empty title="还没有改动记录" text="在应用里或用 folio 命令写入后，改动会记在这里。" icon={<History size={26} />} />
        : <div className="content-list">{entries.map(entry => {
          const active = selected?.id === entry.id;
          return <button key={entry.id} className={'content-row' + (active ? ' selected' : '')} aria-pressed={active} onClick={() => { setSelectedId(entry.id); setDrawerOpen(true); }}>
            <span className="row-icon">{entry.source === 'app' ? <History size={17} /> : <Terminal size={17} />}</span>
            <span className="row-content"><strong>{entry.title || '（无标题）'}</strong><span className="row-metadata">
              <span className={'badge' + (entry.source === 'app' ? '' : ' accent')}>{sourceLabel(entry.source)}</span>
              <span className="badge">{actionLabels[entry.action]}{kindLabels[entry.kind] || entry.kind}</span>
              <span>{dateTime(entry.at)}</span>
            </span></span>
          </button>;
        })}</div>}
    </section>
    {!wide && drawerOpen && <button className="drawer-backdrop" onClick={() => setDrawerOpen(false)} aria-label="关闭详情抽屉" />}
    <aside className={'detail-pane card ' + (drawerOpen ? 'drawer-open' : '')} aria-label="改动详情">
      {!selected ? <Empty title="选择一条改动" text="会显示改了哪些字段。" icon={<History size={26} />} /> : <div className="detail-layout">
        <div className="detail-toolbar">
          <button className="icon-button drawer-close" onClick={() => setDrawerOpen(false)} aria-label="返回列表"><ArrowLeft size={18} /></button>
          <span className="detail-caption">{actionLabels[selected.action]}{kindLabels[selected.kind] || selected.kind}</span>
        </div>
        <div className="detail-scroll">
          <h2 className="detail-title">{selected.title || '（无标题）'}</h2>
          <div className="detail-meta"><span className={'badge' + (selected.source === 'app' ? '' : ' accent')}>{sourceLabel(selected.source)}</span><span className="badge">{dateTime(selected.at)}</span></div>
          {rows.length ? <dl className="property-list">{rows.map(([key, before, after]) => <div key={key}><dt>{fieldLabels[key] || key}</dt>
            <dd>{before === undefined ? show(after) : <><span className="change-old">{show(before)}</span> → {show(after)}</>}</dd></div>)}</dl>
            : <p className="muted no-description">没有字段变化。</p>}
        </div>
        {selected.kind !== 'note' && <div className="detail-footer"><span />
          <button className="button secondary" onClick={() => onOpen(selected.kind as Kind, selected.itemId, deleted)}><ExternalLink size={16} />{deleted ? '去回收站查看' : '打开这一项'}</button>
        </div>}
      </div>}
    </aside>
  </>;
}
