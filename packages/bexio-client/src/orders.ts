// kb_order endpoints. Recurring orders are the source for the daily worker run.

import { callBexio } from './http.ts';
import type { BexioOrder } from './types.ts';

const PAGE_LIMIT = 200;

/**
 * List recurring orders (is_recurring=true). Pages until empty.
 * Bexio's pagination uses limit + offset on /kb_order.
 */
export async function listRecurringOrders(accessToken: string): Promise<BexioOrder[]> {
  const all: BexioOrder[] = [];
  let offset = 0;

  while (true) {
    const page = await callBexio<BexioOrder[]>('/kb_order', {
      accessToken,
      query: { limit: PAGE_LIMIT, offset },
    });

    // Filter to is_recurring=true client-side; bexio's API has no native filter param
    all.push(...page.filter((o) => o.is_recurring));

    if (page.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;

    // Hard cap to avoid infinite loops if bexio behavior changes
    if (offset > 5000) {
      throw new Error('listRecurringOrders: > 5000 orders, refusing to page further');
    }
  }

  return all;
}

/**
 * Full detail for a single order. Use this to read repetition config before billing.
 */
export async function getOrder(accessToken: string, orderId: number): Promise<BexioOrder> {
  return callBexio<BexioOrder>(`/kb_order/${orderId}`, { accessToken });
}
