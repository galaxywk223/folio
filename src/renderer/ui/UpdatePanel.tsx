import { useEffect, useState } from 'react';
import { DownloadCloud } from 'lucide-react';
import type { UpdateStatus } from '../../shared/updates';

export function UpdatePanel({ onNotice, onError }: { onNotice: (value: string) => void; onError: (value: string) => void }) {
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
    <button className={'nav-item' + (phase === 'downloaded' ? ' highlight' : '')} disabled={disabled} onClick={() => void act()} title={status?.message || label}>
      <DownloadCloud size={17} /><span>{label}</span>
      {status?.available_version && phase !== 'up-to-date' && <small>v{status.available_version}</small>}
    </button>
    {phase === 'downloading' && <div className="progress-track update-progress" aria-hidden="true"><span style={{ width: (status?.download_percent ?? 0) + '%' }} /></div>}
    {phase === 'unsupported' && <p className="update-hint">{status?.message}</p>}
    {phase === 'error' && status?.message && <p className="update-hint error">{status.message}</p>}
  </div>;
}
