// kb_order endpoints. Recurring orders are the source for the daily worker run.

import { callBexio } from './http.ts';
import type { BexioOrder, BexioOrderRepetition } from './types.ts';

const PAGE_LIMIT = 200;

export type ListRecurringOrdersResult = {
  orders: BexioOrder[];
  /** True if pagination hit the 5000 safety cap — the list is PARTIAL, so the
   *  caller must NOT treat absent orders as deleted (would wipe past-cap rows). */
  truncated: boolean;
};

/**
 * List recurring orders (is_recurring=true). Pages until empty or the safety cap.
 * Bexio's pagination uses limit + offset on /kb_order. Returns `truncated` so the
 * sync's orphan cleanup can refuse to run on a partial list (EDGE-1).
 */
export async function listRecurringOrders(accessToken: string): Promise<ListRecurringOrdersResult> {
  const all: BexioOrder[] = [];
  let offset = 0;
  let truncated = false;

  while (true) {
    const page = await callBexio<BexioOrder[]>('/kb_order', {
      accessToken,
      query: { limit: PAGE_LIMIT, offset },
    });

    // Filter to is_recurring=true client-side; bexio's API has no native filter param
    all.push(...page.filter((o) => o.is_recurring));

    if (page.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;

    // Hard cap to avoid infinite loops if bexio behavior changes — degrade
    // gracefully (flag + break) rather than throwing, which would abort the
    // entire daily run before any orders get processed. (F-11) The `truncated`
    // flag tells the caller the list is incomplete so it can skip orphan
    // cleanup instead of deleting every order past the cap. (EDGE-1)
    if (offset > 5000) {
      console.warn('listRecurringOrders: > 5000 orders, capping at 5000 — list is PARTIAL, orphan cleanup will be skipped');
      truncated = true;
      break;
    }
  }

  return { orders: all, truncated };
}

/**
 * Full detail for a single order. Note: does NOT include repetition config —
 * bexio exposes that on a separate endpoint (see getOrderRepetition).
 */
export async function getOrder(accessToken: string, orderId: number): Promise<BexioOrder> {
  return callBexio<BexioOrder>(`/kb_order/${orderId}`, { accessToken });
}

/**
 * Get the repetition (recurring-billing) config for an order.
 * Returns { start, repetition: { type, interval, schedule } }.
 * Use mapRepetitionToInterval() to translate to our canonical enum.
 */
export async function getOrderRepetition(
  accessToken: string,
  orderId: number,
): Promise<BexioOrderRepetition> {
  return callBexio<BexioOrderRepetition>(`/kb_order/${orderId}/repetition`, { accessToken });
}

/** One search criterion for POST /kb_order/search. */
export type OrderSearchCriterion = {
  field: string;
  value: string | number | boolean;
  /** Default 'like' if omitted. NOTE: is_recurring is NOT a searchable field
   *  (bexio returns 400) — filter it client-side. updated_at IS searchable. */
  criteria?:
    | '=' | '!=' | '>' | '<' | '>=' | '<='
    | 'like' | 'not_like' | 'is_null' | 'not_null'
    | 'in' | 'not_in' | 'greater_than' | 'less_than';
};

/**
 * Server-side order search. Body is an array of {field, value, criteria}.
 * Searchable fields include id, kb_item_status_id, document_nr, title,
 * contact_id, is_valid_from, updated_at. (is_recurring is NOT searchable.)
 */
export async function searchOrders(
  accessToken: string,
  criteria: OrderSearchCriterion[],
  opts: { limit?: number; offset?: number } = {},
): Promise<BexioOrder[]> {
  return callBexio<BexioOrder[]>('/kb_order/search', {
    accessToken,
    method: 'POST',
    query: { limit: opts.limit ?? 500, offset: opts.offset ?? 0 },
    body: criteria,
  });
}

/**
 * Incremental recurring-order list: orders changed since `sinceIso`
 * ('YYYY-MM-DD HH:mm:ss'). bexio can't filter is_recurring server-side, so we
 * search by updated_at and filter is_recurring client-side. Pages to a 5000 cap.
 */
export async function listRecurringOrdersSince(
  accessToken: string,
  sinceIso: string,
): Promise<BexioOrder[]> {
  const all: BexioOrder[] = [];
  let offset = 0;
  const LIMIT = 500;

  while (true) {
    const page = await searchOrders(
      accessToken,
      [{ field: 'updated_at', value: sinceIso, criteria: 'greater_than' }],
      { limit: LIMIT, offset },
    );
    all.push(...page.filter((o) => o.is_recurring));
    if (page.length < LIMIT) break;
    offset += LIMIT;
    if (offset > 5000) {
      console.warn('listRecurringOrdersSince: > 5000 changed orders, capping at 5000');
      break;
    }
  }

  return all;
}
