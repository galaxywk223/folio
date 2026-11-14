import { useEffect, useRef, useState } from 'react';
import { Check, ImagePlus, Trash2, Undo2 } from 'lucide-react';
import { assetUrl } from '../api';
import type { LogoChange } from '../types';

const AVATAR_TONES = 8;
export const logoUrl = (logo: string) => assetUrl('/api/logos/' + encodeURIComponent(logo));

// 头像：有 logo 显示 logo，没有就显示首字母（英文大写，中文取第一个字）；颜色由名字决定。
export function Avatar({ name, logo, src, size = 'md', done = false }: { name: string; logo?: string; src?: string; size?: 'md' | 'lg'; done?: boolean }) {
  const [failed, setFailed] = useState('');
  const image = src || (logo ? logoUrl(logo) : '');
  const text = name.trim();
  let hash = 0;
  for (const char of text) hash = (hash * 31 + char.codePointAt(0)!) >>> 0;
  const first = [...text][0] ?? '?';
  const showImage = !!image && failed !== image;
  return <span className={'avatar ' + size + (showImage ? ' has-logo' : ' tone-' + (hash % AVATAR_TONES))} aria-hidden="true">
    {showImage ? <img src={image} alt="" draggable={false} onError={() => setFailed(image)} /> : /[a-z]/i.test(first) ? first.toUpperCase() : first}
    {done && <i className="avatar-done"><Check size={9} strokeWidth={3.5} /></i>}
  </span>;
}

// 编辑器里的 logo 选择：选好的图在保存时一起上传。
export function LogoPicker({ name, logo, change, disabled, onChange }: {
  name: string; logo: string; change: LogoChange; disabled?: boolean; onChange: (change: LogoChange) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    if (!change || !('file' in change)) { setPreview(''); return; }
    const url = URL.createObjectURL(change.file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [change]);
  const removed = !!change && 'remove' in change;
  const hasLogo = !!preview || (!!logo && !removed);
  function choose(file: File | undefined) {
    if (!file) return;
    if (file.size > 1024 * 1024) { setError('图片不能超过 1 MB。'); return; }
    setError('');
    onChange({ file });
  }
  return <div className="field wide logo-field">
    <span className="field-label">Logo <span>可不设，默认显示首字母</span></span>
    <div className="logo-picker">
      <Avatar name={name || '?'} logo={removed ? '' : logo} src={preview} size="lg" />
      <div className="logo-actions">
        <button type="button" className="button secondary" disabled={disabled} onClick={() => input.current?.click()}><ImagePlus size={15} />{hasLogo ? '更换图片' : '选择图片'}</button>
        {hasLogo && <button type="button" className="button ghost" disabled={disabled} onClick={() => onChange(logo ? { remove: true } : null)}><Trash2 size={15} />移除</button>}
        {change && <button type="button" className="button ghost" disabled={disabled} onClick={() => onChange(null)}><Undo2 size={15} />还原</button>}
      </div>
      <input ref={input} type="file" hidden accept="image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon,.ico,.svg" onChange={event => { choose(event.target.files?.[0]); event.target.value = ''; }} />
    </div>
    <p className="logo-hint">{error || 'PNG、JPG、WebP、SVG 或 ICO，最大 1 MB。正方形、透明背景的图效果最好。'}</p>
  </div>;
}
