import { useEffect, useState } from 'react';
import { AlertCircle, Save, X } from 'lucide-react';
import { subscriptionCategories } from '../../shared/subscriptions';
import type { SubscriptionCategory } from '../../shared/subscriptions';
import type { QuotaDraft, SubscriptionDraft } from '../types';

function Field({ id, label, wide, children }: { id: string; label: string; wide?: boolean; children: React.ReactNode }) {
  return <div className={'field' + (wide ? ' wide' : '')}><label className="field-label" htmlFor={id}>{label}</label>{children}</div>;
}

export function ServiceEditor({ kind, initial, isNew, onSave, onCancel, onDirty }: {
  kind: 'quota' | 'subscription';
  initial: QuotaDraft | SubscriptionDraft;
  isNew: boolean;
  onSave: (value: QuotaDraft | SubscriptionDraft) => Promise<void> | void;
  onCancel: () => void;
  onDirty: (value: boolean) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  function setField(key: string, value: string | boolean | null) {
    setDraft(current => ({ ...current, [key]: value }));
  }
  async function save() {
    if (saving) return;
    if (kind === 'quota' && !(draft as QuotaDraft).platform.trim()) { setError('平台名称不能为空。'); return; }
    if (kind === 'subscription' && !(draft as SubscriptionDraft).service.trim()) { setError('服务名称不能为空。'); return; }
    setSaving(true); setError('');
    try { await onSave(draft); onDirty(false); }
    catch (failure) { setError((failure as Error).message); }
    finally { setSaving(false); }
  }
  const quota = draft as QuotaDraft, sub = draft as SubscriptionDraft;
  const text = (id: string, key: string, value: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) =>
    <input id={id} className="input" value={value} onChange={e => setField(key, e.target.value)} disabled={saving} {...props} />;
  return <div className="editor-layout">
    <div className="detail-toolbar"><span className="detail-caption">{isNew ? '新建' : '编辑'}{kind === 'quota' ? '额度' : '订阅'}</span><button className="icon-button" onClick={onCancel} aria-label="取消编辑"><X size={18} /></button></div>
    <div className="editor-scroll"><div className="form-grid">
      {kind === 'quota' ? <>
        <div className="field wide"><span className="field-label">类型</span>
          <div className="segmented" role="group" aria-label="额度类型">{(['官方', '中转'] as const).map(value => <button key={value} className={quota.kind === value ? 'active' : ''} aria-pressed={quota.kind === value} onClick={() => setField('kind', value)}>{value}</button>)}</div>
        </div>
        <Field id="q-platform" label="平台" wide>{text('q-platform', 'platform', quota.platform, { autoFocus: true })}</Field>
        <Field id="q-balance" label="余额">{text('q-balance', 'balance', quota.balance)}</Field>
        <Field id="q-date" label="记录日期">{text('q-date', 'recordedAt', quota.recordedAt, { type: 'date' })}</Field>
        <Field id="q-url" label="入口 URL" wide>{text('q-url', 'entryUrl', quota.entryUrl, { placeholder: 'https://' })}</Field>
        <Field id="q-note" label="备注" wide><textarea id="q-note" className="input textarea short" value={quota.note} onChange={e => setField('note', e.target.value)} disabled={saving} /></Field>
      </> : <>
        <Field id="s-service" label="服务" wide>{text('s-service', 'service', sub.service, { autoFocus: true })}</Field>
        <Field id="s-category" label="分类">
          <select id="s-category" className="input" value={sub.category} onChange={e => setField('category', e.target.value as SubscriptionCategory)} disabled={saving}>
            {Object.entries(subscriptionCategories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </Field>
        <Field id="s-account" label="账号">{text('s-account', 'account', sub.account)}</Field>
        <Field id="s-plan" label="套餐">{text('s-plan', 'plan', sub.plan)}</Field>
        <Field id="s-cost" label="费用">{text('s-cost', 'cost', sub.cost)}</Field>
        <Field id="s-exp" label="到期日">{text('s-exp', 'expiresAt', sub.expiresAt, { type: 'date' })}</Field>
        <Field id="s-renew" label="自动续费">
          <select id="s-renew" className="input" value={sub.autoRenew === null ? '' : String(sub.autoRenew)} onChange={e => setField('autoRenew', e.target.value === '' ? null : e.target.value === 'true')} disabled={saving}>
            <option value="">未记录</option><option value="true">开启</option><option value="false">关闭</option>
          </select>
        </Field>
        <Field id="s-benefits" label="权益" wide>{text('s-benefits', 'benefits', sub.benefits)}</Field>
        <Field id="s-status" label="状态" wide>{text('s-status', 'status', sub.status)}</Field>
        <Field id="s-url" label="入口 URL" wide>{text('s-url', 'entryUrl', sub.entryUrl, { placeholder: 'https://' })}</Field>
        <Field id="s-note" label="备注" wide><textarea id="s-note" className="input textarea short" value={sub.note} onChange={e => setField('note', e.target.value)} disabled={saving} /></Field>
      </>}
    </div>
      {error && <div className="inline-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
    </div>
    <div className="editor-footer"><span>{saving ? '正在保存…' : dirty ? '有未保存的修改' : '尚无修改'}</span><button className="button primary" onClick={() => void save()} disabled={saving}><Save size={16} />保存</button></div>
  </div>;
}
