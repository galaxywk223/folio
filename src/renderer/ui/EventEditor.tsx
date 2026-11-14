import { useEffect, useState } from 'react';
import { AlertCircle, Save, X } from 'lucide-react';
import { REMINDER_OPTIONS, WEEKDAY_NAMES, effectiveRepeatDays, reminderLabel } from '../../shared/schedule';
import type { Repeat } from '../../shared/schedule';
import type { EventDraft, LogoChange } from '../types';
import { LogoPicker } from './Avatar';

const repeatOptions: [Repeat, string][] = [['none', '不重复'], ['daily', '每天'], ['weekly', '每周']];
// 周一在前。
const weekOrder = [1, 2, 3, 4, 5, 6, 0];

function Field({ id, label, wide, children }: { id: string; label: string; wide?: boolean; children: React.ReactNode }) {
  return <div className={'field' + (wide ? ' wide' : '')}><label className="field-label" htmlFor={id}>{label}</label>{children}</div>;
}

export function EventEditor({ initial, isNew, logo = '', onSave, onCancel, onDirty }: {
  initial: EventDraft; isNew: boolean; logo?: string;
  onSave: (value: EventDraft, logo: LogoChange) => Promise<void> | void; onCancel: () => void; onDirty: (value: boolean) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [logoChange, setLogoChange] = useState<LogoChange>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial) || !!logoChange;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  const set = <K extends keyof EventDraft>(key: K, value: EventDraft[K]) => setDraft(current => ({ ...current, [key]: value }));

  function setStart(value: string) {
    setDraft(current => ({ ...current, startTime: value, endTime: value ? current.endTime : '', reminderMinutes: value ? current.reminderMinutes : null }));
  }
  function toggleDay(day: number) {
    const days = effectiveRepeatDays(draft);
    const next = days.includes(day) ? days.filter(value => value !== day) : [...days, day];
    set('repeatDays', next.sort((a, b) => a - b));
  }
  async function save() {
    if (saving) return;
    if (!draft.title.trim()) { setError('日程标题不能为空。'); return; }
    if (!draft.date) { setError('请选择日期。'); return; }
    setSaving(true); setError('');
    try { await onSave(draft, logoChange); onDirty(false); }
    catch (failure) { setError((failure as Error).message); }
    finally { setSaving(false); }
  }
  const days = effectiveRepeatDays(draft);
  return <div className="editor-layout">
    <div className="detail-toolbar"><span className="detail-caption">{isNew ? '新建日程' : '编辑日程'}</span><button className="icon-button" onClick={onCancel} aria-label="取消编辑"><X size={18} /></button></div>
    <div className="editor-scroll"><div className="form-grid">
      <Field id="e-title" label="标题" wide><input id="e-title" className="input" value={draft.title} autoFocus disabled={saving} onChange={e => set('title', e.target.value)} /></Field>
      <Field id="e-date" label="日期" wide><input id="e-date" className="input" type="date" value={draft.date} disabled={saving} onChange={e => set('date', e.target.value)} /></Field>
      <Field id="e-start" label="开始"><input id="e-start" className="input" type="time" value={draft.startTime} disabled={saving} onChange={e => setStart(e.target.value)} /></Field>
      <Field id="e-end" label="结束"><input id="e-end" className="input" type="time" value={draft.endTime} disabled={saving || !draft.startTime} onChange={e => set('endTime', e.target.value)} /></Field>
      <Field id="e-location" label="地点" wide><input id="e-location" className="input" value={draft.location} disabled={saving} onChange={e => set('location', e.target.value)} /></Field>
      <div className="field wide"><span className="field-label">重复</span>
        <div className="segmented" role="group" aria-label="重复">{repeatOptions.map(([value, label]) =>
          <button key={value} className={draft.repeat === value ? 'active' : ''} aria-pressed={draft.repeat === value} disabled={saving} onClick={() => set('repeat', value)}>{label}</button>)}</div>
      </div>
      {draft.repeat === 'weekly' && <div className="field wide"><span className="field-label">每周哪几天</span>
        <div className="segmented weekday-picker" role="group" aria-label="重复星期">{weekOrder.map(day =>
          <button key={day} className={days.includes(day) ? 'active' : ''} aria-pressed={days.includes(day)} disabled={saving || (days.length === 1 && days.includes(day))} onClick={() => toggleDay(day)}>{WEEKDAY_NAMES[day].slice(1)}</button>)}</div>
      </div>}
      {draft.repeat !== 'none' && <Field id="e-until" label="重复到（可不填）" wide><input id="e-until" className="input" type="date" value={draft.repeatUntil} min={draft.date} disabled={saving} onChange={e => set('repeatUntil', e.target.value)} /></Field>}
      <Field id="e-reminder" label={draft.startTime ? '提醒' : '提醒（需要开始时间）'} wide>
        <select id="e-reminder" className="input" value={draft.reminderMinutes === null ? '' : String(draft.reminderMinutes)} disabled={saving || !draft.startTime}
          onChange={e => set('reminderMinutes', e.target.value === '' ? null : Number(e.target.value))}>
          <option value="">不提醒</option>
          {REMINDER_OPTIONS.map(minutes => <option key={minutes} value={minutes}>{reminderLabel(minutes)}</option>)}
        </select>
      </Field>
      <Field id="e-note" label="备注" wide><textarea id="e-note" className="input textarea short" value={draft.note} disabled={saving} onChange={e => set('note', e.target.value)} /></Field>
      <LogoPicker name={draft.title} logo={logo} change={logoChange} disabled={saving} onChange={setLogoChange} />
    </div>
      {error && <div className="inline-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
    </div>
    <div className="editor-footer"><span>{saving ? '正在保存…' : dirty ? '有未保存的修改' : '尚无修改'}</span><button className="button primary" onClick={() => void save()} disabled={saving}><Save size={16} />保存</button></div>
  </div>;
}
