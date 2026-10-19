import { createContext, forwardRef, useContext, useEffect, useImperativeHandle, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertCircle, Check, FileText, Plus, Save, X } from 'lucide-react';
import { getSteps } from '../shared/markdown';
import type { EditorValue } from './types';

const StepContext = createContext<{ index: number; text: string; checked: boolean } | null>(null);
export function Markdown({ body, onToggle, disabled = false }: { body: string; onToggle?: (index: number, checked: boolean) => void; disabled?: boolean }) {
  const steps = getSteps(body);
  return <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]} components={{
    li: ({ node, children, className }) => {
      const step = steps.find(item => item.line === node?.position?.start.line);
      return <StepContext.Provider value={step || null}><li className={className}>{children}</li></StepContext.Provider>;
    },
    input: function MarkdownCheckbox({ checked }) {
      const step = useContext(StepContext);
      return <input type="checkbox" checked={step?.checked ?? !!checked} disabled={disabled || !onToggle || !step}
        aria-label={step?.text || '检查步骤'} onChange={event => step && onToggle?.(step.index, event.target.checked)} />;
    },
    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
    img: ({ src, alt }) => <a href={src} target="_blank" rel="noopener noreferrer">{alt || '查看图片'}</a>,
  }}>{body}</ReactMarkdown></div>;
}
export function Modal({ open, onOpenChange, title, description, children, className = '' }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; children: React.ReactNode; className?: string }) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}><Dialog.Portal><Dialog.Overlay className="modal-overlay" /><Dialog.Content className={'modal ' + className}>
    <div className="modal-heading"><Dialog.Title>{title}</Dialog.Title><Dialog.Close className="icon-button" aria-label="关闭弹窗"><X size={18} /></Dialog.Close></div>
    <Dialog.Description className={description ? 'modal-description' : 'sr-only'}>{description || title + '操作面板'}</Dialog.Description>
    {children}
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
export type Confirmation = { title: string; message: string; primary: string; action: () => Promise<void> | void; secondary?: string; secondaryAction?: () => void; destructive?: boolean };
export function Confirm({ value, onClose }: { value: Confirmation | null; onClose: () => void }) {
  return <AlertDialog.Root open={!!value} onOpenChange={open => !open && onClose()}><AlertDialog.Portal><AlertDialog.Overlay className="modal-overlay confirm-overlay" /><AlertDialog.Content className="modal confirm-modal">
    <AlertDialog.Title>{value?.title}</AlertDialog.Title><AlertDialog.Description>{value?.message}</AlertDialog.Description>
    <div className="modal-actions"><AlertDialog.Cancel className="button secondary">取消</AlertDialog.Cancel>
      {value?.secondary && <AlertDialog.Action className="button secondary" onClick={() => value.secondaryAction?.()}>{value.secondary}</AlertDialog.Action>}
      <AlertDialog.Action className={'button ' + (value?.destructive ? 'danger' : 'primary')} onClick={() => void value?.action()}>{value?.primary}</AlertDialog.Action>
    </div>
  </AlertDialog.Content></AlertDialog.Portal></AlertDialog.Root>;
}
export function Empty({ title, text, action, actionLabel = '新建', icon = <FileText size={28} /> }: { title: string; text: string; action?: () => void; actionLabel?: string; icon?: React.ReactNode }) {
  return <div className="empty-state"><span className="empty-icon">{icon}</span><h3>{title}</h3><p>{text}</p>{action && <button className="button secondary" onClick={action}><Plus size={16} />{actionLabel}</button>}</div>;
}
export type EditorHandle = { save: () => Promise<boolean> };
export const Editor = forwardRef<EditorHandle, {
  initial: EditorValue; kind: 'task' | 'note'; isNew: boolean; onSave: (value: EditorValue) => Promise<void>; onCancel: () => void; onDirty: (value: boolean) => void;
}>(function Editor({ initial, kind, isNew, onSave, onCancel, onDirty }, ref) {
  const [title, setTitle] = useState(initial.title);
  const [dateText, setDateText] = useState(initial.dateText || '');
  const [body, setBody] = useState(initial.bodyMarkdown);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const textarea = useRef<HTMLTextAreaElement>(null);
  const dirty = title !== initial.title || dateText !== (initial.dateText || '') || body !== initial.bodyMarkdown;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  async function save() {
    if (saving) return false;
    if (kind === 'task' && !title.trim()) { setError('事项标题不能为空。'); return false; }
    setSaving(true); setError('');
    try {
      await onSave({ title, dateText, bodyMarkdown: body, version: initial.version });
      onDirty(false);
      return true;
    } catch (failure) { setError((failure as Error).message); return false; }
    finally { setSaving(false); }
  }
  useImperativeHandle(ref, () => ({ save }));
  function addStep() {
    setBody(current => current + (current && !current.endsWith('\n') ? '\n' : '') + '- [ ] ');
    setPreview(false);
    requestAnimationFrame(() => { textarea.current?.focus(); textarea.current?.setSelectionRange(9999999, 9999999); });
  }
  return <div className="editor-layout">
    <div className="detail-toolbar"><span className="detail-caption">{isNew ? '新建' : '编辑'}{kind === 'task' ? '事项' : '记录'}</span><button className="icon-button" onClick={onCancel} aria-label="取消编辑"><X size={18} /></button></div>
    <div className="editor-scroll">
      <div className="field"><label className="field-label" htmlFor="editor-title">标题</label><input autoFocus id="editor-title" className="input title-input" value={title} onChange={event => setTitle(event.target.value)} placeholder={kind === 'task' ? '事项名称' : '记录标题（可留空）'} maxLength={500} disabled={saving} /></div>
      {kind === 'task' && <div className="field"><label className="field-label" htmlFor="editor-date">日期 <span>可留空</span></label><div className="date-field"><input id="editor-date" className="input" value={dateText} onChange={event => setDateText(event.target.value)} placeholder="YYYY-MM-DD，可添加时间或“前”" disabled={saving} /><input type="date" className="input date-picker" aria-label="选择事项日期" value={dateText.match(/^\d{4}-\d{2}-\d{2}/)?.[0] || ''} onChange={event => setDateText(event.target.value + (dateText.endsWith('前') ? '前' : ''))} disabled={saving} /></div></div>}
      <div className="editor-heading"><label className="field-label" htmlFor="editor-body">正文</label><div className="segmented"><button className={!preview ? 'active' : ''} onClick={() => setPreview(false)}>编辑</button><button className={preview ? 'active' : ''} onClick={() => setPreview(true)}>预览</button></div></div>
      {preview ? <div className="input editor-preview">{body ? <Markdown body={body} /> : <p className="muted">正文为空</p>}</div> : <textarea ref={textarea} id="editor-body" className="input textarea" value={body} onChange={event => setBody(event.target.value)} placeholder="记录说明、检查步骤或相关链接…" spellCheck={false} disabled={saving} />}
      <div className="editor-help"><span>支持 Markdown</span>{kind === 'task' && <button className="text-button" onClick={addStep} disabled={saving}><Plus size={14} />添加检查步骤</button>}</div>
      {error && <div className="inline-error" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
    </div>
    <div className="editor-footer"><span>{saving ? '正在保存…' : dirty ? '有未保存的修改' : '尚无修改'} <kbd>Ctrl S</kbd></span><button className="button primary" onClick={() => void save()} disabled={saving}><Save size={16} />{saving ? '保存中' : '保存'}</button></div>
  </div>;
});
