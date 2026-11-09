import { useEffect, useRef, useState } from 'react';
import { Archive, Download, FileDown, Upload } from 'lucide-react';
import { assetUrl, dateTime, fileSize, request } from '../api';
import type { Backup } from '../types';

export function DataPanel({ revision, onNotice, onError, onRestore }: { revision: string; onNotice: (value: string) => void; onError: (value: string) => void; onRestore: (action: () => Promise<unknown>) => void }) {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [working, setWorking] = useState(false);
  const [exported, setExported] = useState<{ directory: string; downloadUrl: string } | null>(null);
  const restoreInput = useRef<HTMLInputElement>(null);
  const refresh = () => request<Backup[]>('/api/backups').then(setBackups).catch(failure => onError(failure.message));
  // 恢复备份后数据版本会变，跟着刷新列表（恢复前会自动备份一份）。
  useEffect(() => { void refresh(); }, [revision]);
  async function action(work: () => Promise<void>) {
    setWorking(true);
    try { await work(); } catch (failure) { onError((failure as Error).message); }
    finally { setWorking(false); }
  }
  return <>
    <div className="data-action">
      <span className="data-icon"><FileDown size={18} /></span>
      <div><h3>导出 Markdown</h3><p>保留日期、正文、检查步骤与服务表，另存到独立导出目录。</p></div>
      <button className="button secondary" disabled={working} onClick={() => void action(async () => { const result = await request<{ directory: string; downloadUrl: string }>('/api/export', 'POST'); setExported(result); onNotice('已另存到 ' + result.directory); })}><Download size={15} />导出</button>
    </div>
    {exported && <div className="export-result"><span>{exported.directory}</span><a href={assetUrl(exported.downloadUrl)}>下载导出包<Download size={14} /></a></div>}
    <div className="data-action">
      <span className="data-icon"><Archive size={18} /></span>
      <div><h3>完整备份</h3><p>包含数据库与回收站内容，保存在本机“备份”目录，可下载另存。</p></div>
      <button className="button primary" disabled={working} onClick={() => void action(async () => { await request('/api/backups', 'POST'); await refresh(); onNotice('完整备份已保存'); })}><Archive size={15} />创建备份</button>
    </div>
    <div className="backup-list">{backups.map(item => <div className="backup-row" key={item.id}>
      <span><strong>{dateTime(item.createdAt)}</strong><small>{fileSize(item.size)} · {item.filename}</small></span>
      <a className="icon-button" href={assetUrl('/api/backups/' + item.id + '/download')} aria-label={'下载备份 ' + item.filename}><Download size={16} /></a>
      <button className="button ghost" disabled={working} onClick={() => onRestore(() => request('/api/backups/' + item.id + '/restore', 'POST'))}>恢复</button>
    </div>)}{!backups.length && <p className="muted backup-empty">尚未创建完整备份。</p>}</div>
    <div className="restore-upload"><span>已有其他备份文件</span><button className="button ghost" disabled={working} onClick={() => restoreInput.current?.click()}><Upload size={14} />选择备份恢复</button><input type="file" accept=".zip" ref={restoreInput} hidden onChange={event => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (file) onRestore(() => { const form = new FormData(); form.append('file', file); return request('/api/restore', 'POST', form); });
    }} /></div>
  </>;
}
