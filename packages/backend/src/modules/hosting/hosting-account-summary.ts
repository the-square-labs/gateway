import type { HostingMoney, HostingResourceSnapshot } from './hosting-provider.types.js';

/** Monthly-equivalent recurring VM prices, not accrued usage or account invoices. */
export function monthlyVmExpenses(resources: HostingResourceSnapshot[], emptyCurrency?: string): HostingMoney | null {
  const currency = resources[0]?.price?.currency ?? emptyCurrency;
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return null;
  let total = 0;
  for (const resource of resources) {
    const price = resource.price;
    if (!price || price.currency !== currency || price.period !== 'month' || !/^\d+(?:\.\d+)?$/.test(price.amount))
      return null;
    total += Number(price.amount);
  }
  if (!Number.isFinite(total)) return null;
  return { amount: total.toFixed(2), currency, period: 'month', estimated: true };
}
