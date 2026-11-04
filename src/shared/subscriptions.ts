// 额度与订阅共用同一套分类。
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
  item: { category: ServiceCategory; deletedAt: string | null },
  filter: ServiceFilter,
): boolean {
  return !item.deletedAt && (filter === 'all' || item.category === filter);
}

export const subscriptionCategories = serviceCategories;
export type SubscriptionCategory = ServiceCategory;
export type SubscriptionFilter = ServiceFilter;
export const isSubscriptionCategory = isServiceCategory;
export const matchesSubscriptionFilter = matchesServiceFilter;

export function autoRenewLabel(value: boolean | null): string {
  return value === null ? '未记录' : value ? '开启' : '关闭';
}
