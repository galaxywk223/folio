// 额度保留固定分类，订阅分类从数据库读取。
export const serviceCategories = {
  ai: 'AI',
  network: '网络',
  other: '其他',
} as const;

export type ServiceCategory = keyof typeof serviceCategories;
export type ServiceFilter = 'all' | ServiceCategory;

export function isServiceCategory(value: unknown): value is ServiceCategory {
  return typeof value === 'string' && Object.hasOwn(serviceCategories, value);
}

export function matchesServiceFilter(
  item: { category: string; deletedAt: string | null },
  filter: string,
): boolean {
  return !item.deletedAt && (filter === 'all' || item.category === filter);
}

export type SubscriptionCategory = { id: string; name: string };
export const matchesSubscriptionFilter: (
  item: { category: string; deletedAt: string | null }, filter: string,
) => boolean = matchesServiceFilter;

export function autoRenewLabel(value: boolean | null): string {
  return value === null ? '未记录' : value ? '开启' : '关闭';
}
