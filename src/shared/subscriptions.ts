export const subscriptionCategories = {
  ai: 'AI',
  network: '网络',
  other: '其他',
} as const;

export type SubscriptionCategory = keyof typeof subscriptionCategories;
export type SubscriptionFilter = 'all' | SubscriptionCategory;

export function isSubscriptionCategory(value: unknown): value is SubscriptionCategory {
  return typeof value === 'string' && Object.hasOwn(subscriptionCategories, value);
}

export function autoRenewLabel(value: boolean | null): string {
  return value === null ? '未记录' : value ? '开启' : '关闭';
}

export function matchesSubscriptionFilter(
  item: { category: SubscriptionCategory; deletedAt: string | null },
  filter: SubscriptionFilter,
): boolean {
  return !item.deletedAt && (filter === 'all' || item.category === filter);
}
