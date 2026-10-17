export class ApiError extends Error {
  code: string;
  constructor(message: string, code: string) { super(message); this.code = code; }
}

let apiBase = '';

export async function ensureApiBase() {
  if (apiBase) return apiBase;
  if (window.folio?.getApiBase) apiBase = await window.folio.getApiBase();
  else apiBase = '';
  return apiBase;
}

function resolveUrl(url: string) {
  if (/^https?:\/\//i.test(url)) return url;
  return (apiBase || '') + url;
}

export async function request<T>(url: string, method = 'GET', body?: object | FormData): Promise<T> {
  await ensureApiBase();
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers['X-Folio-App'] = '1';
  if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(resolveUrl(url), { method, headers, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError('无法连接本地服务。请重新打开 Folio；当前编辑内容仍保留。', 'OFFLINE');
  }
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new ApiError(data.error || '操作未完成，请稍后重试。', data.code || 'REQUEST_FAILED');
  }
  return response.status === 204 ? undefined as T : response.json();
}

export function assetUrl(url: string) {
  return resolveUrl(url);
}

export async function openExternal(url: string) {
  if (window.folio?.openExternal) return window.folio.openExternal(url);
  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}

export function dateTime(value: string | null | undefined) {
  if (!value) return '';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value));
}

export function fileSize(bytes: number) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 ** 2) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 ** 2).toFixed(1) + ' MB';
}

export function daysUntil(dateText: string | null | undefined) {
  if (!dateText) return null;
  const target = new Date(dateText + 'T00:00:00');
  if (!Number.isFinite(target.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}
