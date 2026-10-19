import { daysUntil } from './api';

export function parseBalance(text: string) {
  const match = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const value = Number(match[0]);
  return Number.isFinite(value) ? value : null;
}

export function expiryUrgent(dateText: string) {
  const days = daysUntil(dateText);
  return days !== null && days <= 14;
}
export function expiryClass(dateText: string) {
  const days = daysUntil(dateText);
  if (days === null) return '';
  if (days < 0) return 'expiry-overdue';
  if (days <= 14) return 'expiry-soon';
  return '';
}
export function expiryLabel(dateText: string) {
  const days = daysUntil(dateText);
  if (days === null) return '';
  if (days < 0) return ` · 已过期 ${-days} 天`;
  if (days === 0) return ' · 今天到期';
  if (days <= 14) return ` · ${days} 天后`;
  return '';
}
