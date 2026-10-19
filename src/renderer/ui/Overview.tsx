import { daysUntil } from '../api';
import type { ApiQuota, Subscription } from '../types';

type Stat = { label: string; value: string | number; tone?: 'warning' | 'danger' | 'accent' };

export function SubscriptionOverview({ items }: { items: Subscription[] }) {
  const live = items.filter(item => !item.deletedAt);
  const days = live.map(item => daysUntil(item.expiresAt));
  const soon = days.filter(value => value !== null && value >= 0 && value <= 14).length;
  const overdue = days.filter(value => value !== null && value < 0).length;
  return <Stats stats={[
    { label: '订阅总数', value: live.length },
    { label: '14 天内到期', value: soon, tone: soon ? 'warning' : undefined },
    { label: '已过期', value: overdue, tone: overdue ? 'danger' : undefined },
    { label: '自动续费', value: live.filter(item => item.autoRenew).length, tone: 'accent' },
  ]} />;
}

export function QuotaOverview({ items }: { items: ApiQuota[] }) {
  const live = items.filter(item => !item.deletedAt);
  const latest = live.map(item => item.recordedAt).filter(Boolean).sort().at(-1);
  return <Stats stats={[
    { label: '平台总数', value: live.length },
    { label: '官方', value: live.filter(item => item.kind === '官方').length },
    { label: '中转', value: live.filter(item => item.kind === '中转').length },
    { label: '最近记录', value: latest || '—', tone: 'accent' },
  ]} />;
}

function Stats({ stats }: { stats: Stat[] }) {
  return <div className="overview" role="group" aria-label="概览">
    {stats.map(stat => <div className={'stat' + (stat.tone ? ' ' + stat.tone : '')} key={stat.label}>
      <span>{stat.label}</span><strong>{stat.value}</strong>
    </div>)}
  </div>;
}
