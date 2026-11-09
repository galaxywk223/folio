import { useEffect, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import type { CloseBehavior, SettingsInfo, SettingsPatch, ThemeSource } from '../../shared/settings';
import { DataPanel } from './DataPanel';
import { UpdateSection } from './UpdateSection';

const themes: { id: ThemeSource; label: string }[] = [{ id: 'system', label: '跟随系统' }, { id: 'light', label: '浅色' }, { id: 'dark', label: '深色' }];
const closeOptions: { id: CloseBehavior; label: string }[] = [{ id: 'tray', label: '最小化到托盘' }, { id: 'quit', label: '直接退出' }];

export function SettingsView({ revision, onNotice, onError, onRestore }: {
  revision: string; onNotice: (value: string) => void; onError: (value: string) => void; onRestore: (action: () => Promise<unknown>) => void;
}) {
  const [settings, setSettings] = useState<SettingsInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const bridge = window.folio;
  useEffect(() => {
    if (!bridge?.getSettings) return;
    void bridge.getSettings().then(setSettings).catch(failure => onError((failure as Error).message));
  }, [bridge, onError]);
  async function change(patch: SettingsPatch) {
    if (!bridge?.setSettings) return;
    setSaving(true);
    try { setSettings(await bridge.setSettings(patch)); }
    catch (failure) { onError((failure as Error).message); }
    finally { setSaving(false); }
  }
  const locked = !settings || saving;
  const autostartOn = !!settings?.openAtLogin;

  return <section className="settings-page card" aria-label="设置">
    <div className="settings-inner">
      <section className="settings-section">
        <h2>通用</h2>
        <div className="setting-row">
          <div className="setting-text">
            <h3>开机自启动</h3>
            <p>{settings && !settings.autostartSupported ? '仅正式安装版可用。' : '登录 Windows 后在后台启动，只显示托盘图标，日程和订阅提醒照常弹出。'}</p>
          </div>
          <button type="button" role="switch" aria-checked={autostartOn} aria-label="开机自启动" className={'switch' + (autostartOn ? ' on' : '')}
            disabled={locked || !settings?.autostartSupported} onClick={() => void change({ openAtLogin: !autostartOn })}><span /></button>
        </div>
        <div className="setting-row">
          <div className="setting-text">
            <h3>关闭窗口时</h3>
            <p>{settings?.closeBehavior === 'quit' ? '点窗口右上角 × 会退出 Folio，之后不再提醒。' : 'Folio 留在托盘里继续提醒，右键托盘图标可退出。'}</p>
          </div>
          <div className="segmented" role="radiogroup" aria-label="关闭窗口时">
            {closeOptions.map(option => <button key={option.id} type="button" role="radio" aria-checked={settings?.closeBehavior === option.id}
              className={settings?.closeBehavior === option.id ? 'active' : ''} disabled={locked} onClick={() => void change({ closeBehavior: option.id })}>{option.label}</button>)}
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>外观</h2>
        <div className="setting-row">
          <div className="setting-text"><h3>主题</h3><p>跟随系统时随 Windows 的浅色 / 深色模式切换。</p></div>
          <div className="segmented" role="radiogroup" aria-label="主题">
            {themes.map(option => <button key={option.id} type="button" role="radio" aria-checked={settings?.theme === option.id}
              className={settings?.theme === option.id ? 'active' : ''} disabled={locked} onClick={() => void change({ theme: option.id })}>{option.label}</button>)}
          </div>
        </div>
      </section>

      <section className="settings-section">
        <h2>数据</h2>
        <div className="setting-row">
          <div className="setting-text"><h3>数据目录</h3><p className="setting-path">{settings?.dataDir || '—'}</p></div>
          <button className="button secondary" disabled={!bridge?.openDataDir} onClick={() => void bridge?.openDataDir().catch(failure => onError((failure as Error).message))}><FolderOpen size={15} />打开</button>
        </div>
        <DataPanel revision={revision} onNotice={onNotice} onError={onError} onRestore={onRestore} />
      </section>

      <section className="settings-section">
        <h2>关于与更新</h2>
        <UpdateSection version={settings?.version || ''} onNotice={onNotice} onError={onError} />
      </section>
    </div>
  </section>;
}
