import { useEffect, useState } from 'react';
import { DownloadCloud } from 'lucide-react';
import type { UpdateStatus } from '../../shared/updates';

export function useUpdateStatus() {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    if (!window.folio?.getUpdateStatus) return;
    void window.folio.getUpdateStatus().then(setStatus).catch(() => undefined);
    return window.folio.onUpdateStatus?.(setStatus);
  }, []);
  return [status, setStatus] as const;
}

export function UpdateSection({ version, onNotice, onError }: { version: string; onNotice: (value: string) => void; onError: (value: string) => void }) {
  const [status, setStatus] = useUpdateStatus();
  const [busy, setBusy] = useState(false);
  const phase = status?.phase || 'idle';
  const supported = !!window.folio?.checkForUpdates;
  const disabled = !supported || busy || phase === 'unsupported' || phase === 'checking' || phase === 'available' || phase === 'downloading';
  const label = phase === 'downloaded' ? '重启安装' : phase === 'downloading' ? `下载中 ${status?.download_percent ?? 0}%` : phase === 'checking' || phase === 'available' ? '检查中…' : '检查更新';
  const summary = phase === 'downloaded' ? `新版本 v${status?.available_version} 已下载，重启后完成安装。`
    : phase === 'downloading' ? `正在下载 v${status?.available_version ?? ''}…`
    : phase === 'up-to-date' ? '已是最新版本。'
    : phase === 'unsupported' ? status?.message || '仅正式安装版支持应用内更新。'
    : phase === 'error' ? status?.message || '检查更新失败。'
    : '启动后会自动检查一次，下载完成后提示重启。';
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
  return <div className="setting-row">
    <div className="setting-text">
      <h3>Folio {version ? 'v' + version : ''}</h3>
      <p className={phase === 'error' ? 'error' : undefined}>{summary}</p>
      {phase === 'downloading' && <div className="progress-track update-progress" aria-hidden="true"><span style={{ width: (status?.download_percent ?? 0) + '%' }} /></div>}
    </div>
    <button className={'button ' + (phase === 'downloaded' ? 'primary' : 'secondary')} disabled={disabled} onClick={() => void act()}><DownloadCloud size={15} />{label}</button>
  </div>;
}
