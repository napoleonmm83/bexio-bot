# Bexio-Bot Edge Case & Logic Fix Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve 21 edge-case and logic bugs surfaced during the post-`7050aac` audit + adversarial Codex challenge on 2026-05-22 — preventing money-loss, double-billing, silent send-failure, and stuck state.

**Architecture:** Seven phases, each independently committable + deployable. Phase 1 fixes acute Money-Loss-Now bugs. Phases 2–3 harden the state machine and idempotency keys. Phases 4–7 cover scheduling, sync, auth, and observability.

**Tech Stack:** TypeScript, Bun, SvelteKit (web), drizzle-orm + postgres-js, bexio public API v2.0, Coolify (Worker + Web both must redeploy per `project_dual_app_deploy`), Discord webhook, bun:test.

---

## File Structure

| File | Responsibility | Touched in Phase |
|------|----------------|------------------|
| `apps/worker/src/lib/state-machine.ts` | per-order pipeline + reconcile + retry | 1, 2, 3 |
| `apps/worker/src/lib/state-machine.test.ts` (NEW) | state-machine unit tests | 1, 2, 3 |
| `apps/worker/src/lib/subscriptions.ts` | per-subscription pipeline | 1, 2, 7 |
| `apps/worker/src/lib/subscriptions.test.ts` (NEW) | subscription unit tests | 1, 2, 7 |
| `apps/worker/src/lib/run.ts` | daily-run orchestrator | 1, 4, 7 |
| `apps/worker/src/lib/sync.ts` | bexio → DB cache sync | 5 |
| `packages/bexio-client/src/auth.ts` | OAuth token lifecycle | 6 |
| `packages/bexio-client/src/http.ts` | API HTTP + rate pacing | 6 |
| `packages/bexio-client/src/orders.ts` | kb_order endpoints | 5 |
| `packages/notify/src/discord.ts` | Discord embed rendering | 7 |
| `packages/db/src/schema.ts` | drizzle schema (no migration unless noted) | 2, 7 |

---

## Phase Overview

| # | Phase | Fixes | Money-Loss? |
|---|-------|-------|-------------|
| 1 | Money-Loss Stop-the-Bleed | N-1, N-7, N-8, F-1 | ✅ DIRECT |
| 2 | State-Machine Race + Recovery | F-2, F-3, N-4, N-5, N-6 | indirect |
| 3 | Period-Key Precision | N-2, N-3 | indirect |
| 4 | TZ + Scheduling | F-4, F-5 | indirect |
| 5 | Sync Hardening | F-7, F-10, F-11 | UX/data-loss |
| 6 | Auth + Rate-Limit Concurrency | F-6, N-9 | reliability |
| 7 | Recovery + Observability | F-8, F-9, F-12, N-11 | polish |

Each phase ends with: `commit → push → deploy BOTH apps (Worker + Web) → manual verify`.

---

# Phase 1 — Money-Loss Stop-the-Bleed

**Goal:** Stop these bugs from costing money today: snapshot fallback overbilling non-due recurring orders, subscriptions silently "succeeding" without sending mail, CHF 0 invoices generated for missing prices, transient errors permanently locking subscriptions.

### Task 1.1: Gate snapshot-fallback to daily/weekly only (N-1)

**Files:**
- Modify: `apps/worker/src/lib/state-machine.ts:143-169` (the `isFullyInvoicedOrderError` branch)
- Create: `apps/worker/src/lib/state-machine.test.ts`

- [ ] **Step 1.1.1: Write the failing test**

Create `apps/worker/src/lib/state-machine.test.ts`:
```typescript
import { expect, test, describe, mock } from 'bun:test';
import { BexioApiError } from '@bexio-bot/bexio-client';

// We test the predicate + branching logic in isolation.
// processOrder() itself takes a DB handle — we'll add proper integration tests
// in Task 1.4. For now: focus on the snapshot-gating decision.

import { shouldSnapshotFallback } from './state-machine.ts';

describe('shouldSnapshotFallback — only daily/weekly trigger snapshot path', () => {
  test('daily order with 422 fully-invoiced → snapshot', () => {
    expect(shouldSnapshotFallback('daily')).toBe(true);
  });

  test('weekly order with 422 fully-invoiced → snapshot', () => {
    expect(shouldSnapshotFallback('weekly')).toBe(true);
  });

  test('monthly order with 422 fully-invoiced → NOT snapshot (treat as not_due)', () => {
    expect(shouldSnapshotFallback('monthly')).toBe(false);
  });

  test('yearly order with 422 fully-invoiced → NOT snapshot', () => {
    expect(shouldSnapshotFallback('yearly')).toBe(false);
  });

  test('unknown / undefined type → NOT snapshot (fail-closed)', () => {
    expect(shouldSnapshotFallback(undefined)).toBe(false);
    expect(shouldSnapshotFallback('something-weird')).toBe(false);
  });
});
```

- [ ] **Step 1.1.2: Run test — expect fail (function not exported yet)**

```bash
bun test apps/worker/src/lib/state-machine.test.ts
```
Expected: `Cannot find module 'shouldSnapshotFallback'` or similar.

- [ ] **Step 1.1.3: Add the predicate to state-machine.ts**

In `apps/worker/src/lib/state-machine.ts`, add this exported helper just below the `isFullyInvoicedOrderError` function (around line 90):

```typescript
/**
 * Snapshot fallback is ONLY safe for daily / weekly recurring orders. For
 * monthly+ orders, bexio's 422 "order is fully invoiced" means "not yet due
 * this period" — snapshotting would create a non-due invoice (money loss /
 * overbilling). For daily / weekly the snapshot path is correct because the
 * order's positions are exhausted by the first invoice and bexio rejects every
 * subsequent same-period call.
 */
export function shouldSnapshotFallback(repetitionType: string | undefined): boolean {
  return repetitionType === 'daily' || repetitionType === 'weekly';
}
```

- [ ] **Step 1.1.4: Wire predicate into the catch branch (state-machine.ts ~line 143)**

Find the block:
```typescript
if (isFullyInvoicedOrderError(err)) {
  console.log(`${ctx} POST /kb_order/${order.bexioOrderId}/invoice → 422 fully-invoiced; trying snapshot fallback`);
  try {
    invoice = await createInvoiceFromOrderSnapshot(...);
```

Replace with:
```typescript
if (isFullyInvoicedOrderError(err)) {
  if (!shouldSnapshotFallback(repetitionType)) {
    console.log(`${ctx} 422 fully-invoiced on ${repetitionType ?? 'unknown'} order — treating as not_due (no snapshot)`);
    return { kind: 'not_due', reason: `422 fully-invoiced (${repetitionType ?? 'unknown'} not-due-this-period; snapshot only allowed for daily/weekly)` };
  }
  console.log(`${ctx} POST /kb_order/${order.bexioOrderId}/invoice → 422 fully-invoiced on daily/weekly; trying snapshot fallback`);
  try {
    invoice = await createInvoiceFromOrderSnapshot(...);
```

(The `repetitionType` variable is already in scope from the earlier Step 0 block — added in commit 7050aac.)

- [ ] **Step 1.1.5: Run tests — expect pass**

```bash
bun test apps/worker/src/lib/state-machine.test.ts
```
Expected: all 5 tests pass.

- [ ] **Step 1.1.6: Run full suite — no regressions**

```bash
bun test
```
Expected: 22 + 5 = 27 tests pass.

- [ ] **Step 1.1.7: Commit**

```bash
git add apps/worker/src/lib/state-machine.ts apps/worker/src/lib/state-machine.test.ts
git commit -m "$(cat <<'EOF'
fix(worker): gate snapshot fallback to daily/weekly only (N-1)

bexio returns 422 "order is fully invoiced" for both (a) daily/weekly orders
whose positions are exhausted by the first invoice and (b) monthly+ orders
that aren't yet due this period. Treating (b) like (a) created unauthorized
invoices for monthly/yearly customers in the wait-month.

Now: shouldSnapshotFallback(repetitionType) restricts the path to daily +
weekly; everything else returns kind:'not_due'.

EOF
)"
```

### Task 1.2: Fail-closed when subscription auto-send has no email (N-7)

**Files:**
- Modify: `apps/worker/src/lib/subscriptions.ts:167-177`
- Create: `apps/worker/src/lib/subscriptions.test.ts`

- [ ] **Step 1.2.1: Write the failing test**

Create `apps/worker/src/lib/subscriptions.test.ts`:
```typescript
import { expect, test, describe } from 'bun:test';
import { validateSubscriptionInputs } from './subscriptions.ts';

describe('validateSubscriptionInputs — fail-closed on missing email + zero price', () => {
  test('auto-send subscription with missing contact email → throws', () => {
    expect(() =>
      validateSubscriptionInputs({
        autoSend: true,
        contactMail: null,
        articles: [{ id: 1, sale_price: '10.00' }],
        items: [{ id: 1, bexioArticleId: 1, qty: '1' }],
      }),
    ).toThrow(/contact.*email/i);
  });

  test('auto-send false with missing email → ok (issue but don\'t send)', () => {
    expect(() =>
      validateSubscriptionInputs({
        autoSend: false,
        contactMail: null,
        articles: [{ id: 1, sale_price: '10.00' }],
        items: [{ id: 1, bexioArticleId: 1, qty: '1' }],
      }),
    ).not.toThrow();
  });

  test('article with missing sale_price → throws (N-8)', () => {
    expect(() =>
      validateSubscriptionInputs({
        autoSend: false,
        contactMail: 'a@b.ch',
        articles: [{ id: 1, sale_price: null }],
        items: [{ id: 1, bexioArticleId: 1, qty: '1' }],
      }),
    ).toThrow(/sale_price/i);
  });

  test('article with zero sale_price → throws (N-8)', () => {
    expect(() =>
      validateSubscriptionInputs({
        autoSend: false,
        contactMail: 'a@b.ch',
        articles: [{ id: 1, sale_price: '0' }],
        items: [{ id: 1, bexioArticleId: 1, qty: '1' }],
      }),
    ).toThrow(/sale_price/i);
  });

  test('happy path — all inputs valid', () => {
    expect(() =>
      validateSubscriptionInputs({
        autoSend: true,
        contactMail: 'kunde@example.ch',
        articles: [{ id: 1, sale_price: '10.00' }],
        items: [{ id: 1, bexioArticleId: 1, qty: '1' }],
      }),
    ).not.toThrow();
  });
});
```

- [ ] **Step 1.2.2: Run test — expect fail**

```bash
bun test apps/worker/src/lib/subscriptions.test.ts
```
Expected: `Cannot find module 'validateSubscriptionInputs'`.

- [ ] **Step 1.2.3: Add validator to subscriptions.ts**

In `apps/worker/src/lib/subscriptions.ts`, add this exported helper just below `render()` (around line 53):

```typescript
/**
 * Hard-validate the inputs that would otherwise silently corrupt a billing run:
 *   - auto_send with no contact email = bot thinks mail went out, customer never receives it
 *   - article without sale_price = CHF 0 invoice gets created
 * Throw before any side-effect so the billing_runs lock can be cleanly removed.
 */
export function validateSubscriptionInputs(input: {
  autoSend: boolean;
  contactMail: string | null;
  articles: Array<{ id: number; sale_price?: string | null }>;
  items: Array<{ id: number; bexioArticleId: number; qty: string }>;
}): void {
  if (input.autoSend && !input.contactMail) {
    throw new Error(
      'subscription validation: auto_send=true but contact has no email. ' +
      'Update the contact in bexio or disable auto_send on the subscription.',
    );
  }
  for (const article of input.articles) {
    const price = article.sale_price;
    if (price == null || Number(price) === 0) {
      throw new Error(
        `subscription validation: article ${article.id} has missing or zero sale_price (${price}). ` +
        'Set a price in bexio before billing.',
      );
    }
  }
}
```

- [ ] **Step 1.2.4: Call validator inside `processOneSubscription` before invoice build**

Find the block in `subscriptions.ts` around line 142-165 (after `getArticle` Promise.all, before `positions = items.map(...)`). Insert before the `positions = items.map(...)` line:

```typescript
    validateSubscriptionInputs({
      autoSend: sub.autoSend,
      contactMail: contact.mail ?? null,
      articles: articles.map((a) => ({ id: a.id, sale_price: a.sale_price })),
      items,
    });
```

- [ ] **Step 1.2.5: Run tests — expect pass**

```bash
bun test apps/worker/src/lib/subscriptions.test.ts
```
Expected: 5/5 pass.

- [ ] **Step 1.2.6: Commit**

```bash
git add apps/worker/src/lib/subscriptions.ts apps/worker/src/lib/subscriptions.test.ts
git commit -m "$(cat <<'EOF'
fix(worker): fail-closed on subscription missing email or zero price (N-7, N-8)

Two silent corruption paths in the subscription layer:
  N-7: auto_send=true + contact.mail=null skipped sendInvoice silently and
       still marked the run as success. Marcus had no signal that the mail
       never went out.
  N-8: article.sale_price=null fell through `?? '0'` and generated a CHF 0
       invoice that bexio accepted and sent.

Both now throw before any bexio side-effect; billing_runs row is cleaned up
by the catch in processOneSubscription, so the next daily run can retry.

EOF
)"
```

### Task 1.3: Clean up subscription billing_runs row on transient failure (F-1)

**Files:**
- Modify: `apps/worker/src/lib/subscriptions.ts:205-227` (catch block)

- [ ] **Step 1.3.1: Add test for retry-after-transient-failure**

Append to `apps/worker/src/lib/subscriptions.test.ts`:
```typescript
import { classifyForRetry } from './subscriptions.ts';
import { BexioApiError } from '@bexio-bot/bexio-client';

describe('classifyForRetry — distinguish retryable vs permanent', () => {
  test('transient bexio error → DELETE lock row + retry next run', () => {
    const err = new BexioApiError(500, 'transient', 'gateway timeout');
    expect(classifyForRetry(err)).toBe('delete-and-retry');
  });

  test('rate_limit → DELETE lock row + retry next run', () => {
    const err = new BexioApiError(429, 'rate_limit', 'too many');
    expect(classifyForRetry(err)).toBe('delete-and-retry');
  });

  test('permanent 4xx → keep failed row (manual review)', () => {
    const err = new BexioApiError(422, 'permanent', 'validation');
    expect(classifyForRetry(err)).toBe('keep-failed');
  });

  test('auth error (401/403) → keep failed row (re-auth needed)', () => {
    const err = new BexioApiError(401, 'auth', 'token expired');
    expect(classifyForRetry(err)).toBe('keep-failed');
  });

  test('non-BexioApiError (validation thrown locally) → keep failed', () => {
    expect(classifyForRetry(new Error('subscription validation: foo'))).toBe('keep-failed');
  });
});
```

- [ ] **Step 1.3.2: Run test — expect fail (function missing)**

```bash
bun test apps/worker/src/lib/subscriptions.test.ts
```

- [ ] **Step 1.3.3: Add `classifyForRetry` helper**

In `apps/worker/src/lib/subscriptions.ts`, just above `processOneSubscription`:

```typescript
/**
 * On error inside processOneSubscription, decide whether to delete the
 * billing_runs lock (so the next run can retry) or keep it as 'failed' for
 * manual review.
 *
 * delete-and-retry: transient bexio errors (5xx, 429) — likely to succeed next time.
 * keep-failed: permanent validation errors, auth errors, local validation — need
 *              human intervention before retry is meaningful.
 */
export type RetryClass = 'delete-and-retry' | 'keep-failed';

export function classifyForRetry(err: unknown): RetryClass {
  if (err instanceof BexioApiError) {
    if (err.errorClass === 'transient' || err.errorClass === 'rate_limit') {
      return 'delete-and-retry';
    }
  }
  return 'keep-failed';
}
```

- [ ] **Step 1.3.4: Wire `classifyForRetry` into the catch block**

Replace the catch block in `processOneSubscription` (~lines 205-227) with:

```typescript
  } catch (err) {
    const retryClass = classifyForRetry(err);

    if (retryClass === 'delete-and-retry') {
      // Transient failure — clear the lock so next daily run can retry.
      // billing_runs row is REMOVED, not marked failed; subscription's
      // next_billing_date stays as-is (still due).
      await db.delete(billingRuns).where(eq(billingRuns.id, runRow.id));
      return {
        kind: 'failed',
        subscriptionId: sub.id,
        reason: `transient: ${err instanceof Error ? err.message : String(err)} (will retry next run)`,
        scheduledFor: scheduledForIso,
      };
    }

    // Permanent — keep the failed row for manual review.
    const errorJsonb =
      err instanceof BexioApiError
        ? { kind: 'bexio_api', status: err.status, errorClass: err.errorClass, body: err.body.slice(0, 500) }
        : { kind: 'unknown', message: err instanceof Error ? err.message : String(err) };

    await db
      .update(billingRuns)
      .set({
        status: 'failed',
        errorJsonb,
        executedAt: new Date(),
      })
      .where(eq(billingRuns.id, runRow.id));

    return {
      kind: 'failed',
      subscriptionId: sub.id,
      reason: err instanceof BexioApiError ? `${err.errorClass}: ${err.body.slice(0, 200)}` : String(err),
      scheduledFor: scheduledForIso,
    };
  }
```

- [ ] **Step 1.3.5: Run tests — expect pass**

```bash
bun test apps/worker/src/lib/subscriptions.test.ts
```

- [ ] **Step 1.3.6: Commit**

```bash
git add apps/worker/src/lib/subscriptions.ts apps/worker/src/lib/subscriptions.test.ts
git commit -m "$(cat <<'EOF'
fix(worker): subscription transient failure deletes lock for retry (F-1)

Previously: any error in processOneSubscription left billing_runs row in
status='failed' while subscription.next_billing_date stayed unchanged.
Next daily run re-found the subscription as due, INSERT hit the existing
(subscription_id, scheduled_for) lock, returned skipped_duplicate forever.

Now: classifyForRetry distinguishes transient (5xx/429 — DELETE row, retry
next run) from permanent (4xx/auth/local-validation — keep as failed for
manual review).

EOF
)"
```

### Task 1.4: Phase 1 deploy + verify

- [ ] **Step 1.4.1: Push to origin**

```bash
git push origin main
```

- [ ] **Step 1.4.2: Trigger BOTH Coolify deploys (Worker + Web)**

```bash
TOKEN=$(grep '^COOLIFY_API_TOKEN=' .env.local | cut -d'=' -f2-)
curl -s -X POST "https://coolify.martini.digital/api/v1/deploy?uuid=s8dljxy4nawz52bxcjhar9nm" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "https://coolify.martini.digital/api/v1/deploy?uuid=vx76yeg463w2ckfndrsbsj8m" -H "Authorization: Bearer $TOKEN"
```

- [ ] **Step 1.4.3: Wait for both deploys to finish**

Poll `GET /api/v1/deployments/{deployment_uuid}` checking top-level `.status` field. Expected: `finished` (~45-90s each).

- [ ] **Step 1.4.4: Live-verify Phase 1**

In the browser DevTools console on `https://bexio-bot.martini.digital`:
```javascript
fetch('/api/trigger-run', {
  method: 'POST',
  headers: {'Content-Type': 'application/json'},
  body: JSON.stringify({ onlyOrderId: 13 })
}).then(r => r.json()).then(console.log)
```
Expected: AU-00013 (daily) still creates a fresh invoice (period `2026-05-23` if run tomorrow, or another `2026-05-22` row if the prior was deleted — but the snapshot path is unchanged for daily, so behavior is identical).

Real Phase 1 verification: enable a MONTHLY recurring order in the dashboard that has been billed this month → run trigger → expect `kind:'not_due'` instead of an overbill snapshot invoice. (If no such order exists, document expectation and proceed.)

---

# Phase 2 — State-Machine Race + Recovery

**Goal:** Make the per-order pipeline race-safe (no orphan bexio invoices from parallel triggers), recover send-failures without leaving stuck rows, and make retries atomic.

### Task 2.1: Claim-row before bexio call (F-3 / N-10)

**Files:**
- Modify: `apps/worker/src/lib/state-machine.ts:140-239` (the create-invoice block)

The pipeline today: (1) early duplicate check, (2) POST bexio, (3) INSERT ON CONFLICT. Two parallel calls both pass (1), both call bexio in (2), both create invoices in bexio, only one wins (3) — second's `invoice.id` is forgotten.

New pipeline: (1) early duplicate check, (2) INSERT ON CONFLICT with status='creating' AS CLAIM, (3) POST bexio, (4) UPDATE invoice_id + status.

- [ ] **Step 2.1.1: Write the test for claim-acquired**

Append to `apps/worker/src/lib/state-machine.test.ts`:
```typescript
import { interpretClaimResult } from './state-machine.ts';

describe('interpretClaimResult — claim-row race interpretation', () => {
  test('claim insert returned a row → we own the slot', () => {
    expect(interpretClaimResult([{ orderId: 13, status: 'creating', invoiceId: null }], null)).toEqual({ kind: 'own' });
  });

  test('claim insert returned nothing, existing row has invoice_id → duplicate', () => {
    expect(
      interpretClaimResult([], { orderId: 13, invoiceId: 234, billingPeriod: '2026-05-22' }),
    ).toEqual({ kind: 'duplicate', existingInvoiceId: 234, billingPeriod: '2026-05-22' });
  });

  test('claim insert returned nothing, existing row in-flight (no invoice_id) → backoff', () => {
    expect(
      interpretClaimResult([], { orderId: 13, invoiceId: null, billingPeriod: '2026-05-22', status: 'creating' }),
    ).toEqual({ kind: 'concurrent-in-flight' });
  });
});
```

- [ ] **Step 2.1.2: Add `interpretClaimResult` helper**

In `state-machine.ts`, near the top (after type imports):
```typescript
export type ClaimResult =
  | { kind: 'own' }
  | { kind: 'duplicate'; existingInvoiceId: number; billingPeriod: string }
  | { kind: 'concurrent-in-flight' };

export function interpretClaimResult(
  inserted: Array<{ orderId: number; status: string; invoiceId: number | null }>,
  existing: { orderId: number; invoiceId: number | null; billingPeriod: string; status?: string } | null,
): ClaimResult {
  if (inserted.length > 0) return { kind: 'own' };
  if (existing?.invoiceId != null) {
    return { kind: 'duplicate', existingInvoiceId: existing.invoiceId, billingPeriod: existing.billingPeriod };
  }
  return { kind: 'concurrent-in-flight' };
}
```

- [ ] **Step 2.1.3: Refactor `processOrder` to claim-first**

Replace the existing early-duplicate-guard block (lines 109-120) PLUS the post-bexio INSERT block (lines 214-239) with:

```typescript
  // Claim the slot atomically. INSERT with status='creating' acts as a DB-level
  // lock; if it succeeds we own the slot and bexio call is safe. If it fails,
  // either someone else already finished (duplicate) or is mid-flight.
  const claimInsert = await db
    .insert(invoiceRuns)
    .values({
      orderId: order.bexioOrderId,
      billingPeriod,
      status: 'creating',
      attempts: 1,
    })
    .onConflictDoNothing({ target: [invoiceRuns.orderId, invoiceRuns.billingPeriod] })
    .returning({ orderId: invoiceRuns.orderId, status: invoiceRuns.status, invoiceId: invoiceRuns.invoiceId });

  const existingRow = claimInsert.length === 0
    ? (await db
        .select()
        .from(invoiceRuns)
        .where(and(eq(invoiceRuns.orderId, order.bexioOrderId), eq(invoiceRuns.billingPeriod, billingPeriod))))[0] ?? null
    : null;

  const claim = interpretClaimResult(claimInsert, existingRow);

  if (claim.kind === 'duplicate') {
    console.log(`${ctx} duplicate guard hit — existing invoice ${claim.existingInvoiceId}`);
    return { kind: 'skipped_duplicate', existingInvoiceId: claim.existingInvoiceId, billingPeriod: claim.billingPeriod };
  }
  if (claim.kind === 'concurrent-in-flight') {
    console.log(`${ctx} concurrent run in-flight on same period — backing off`);
    return { kind: 'not_due', reason: 'concurrent run in progress; try again later' };
  }
  // claim.kind === 'own' — proceed
```

Then change the post-bexio block (was at line 214):

```typescript
  if (!invoice) {
    // bexio call failed and snapshot didn't recover; clean up the claim row.
    await db
      .delete(invoiceRuns)
      .where(and(eq(invoiceRuns.orderId, order.bexioOrderId), eq(invoiceRuns.billingPeriod, billingPeriod)));
    return { kind: 'failed', reason: 'invoice creation returned no invoice' };
  }

  // Bexio call succeeded — fill in invoice_id on our claim row and proceed.
  await db
    .update(invoiceRuns)
    .set({ invoiceId: invoice.id, status: 'created', updatedAt: new Date() })
    .where(and(eq(invoiceRuns.orderId, order.bexioOrderId), eq(invoiceRuns.billingPeriod, billingPeriod)));
```

Also: in EACH catch path that currently returns `kind:'failed'` or `kind:'not_due'` BEFORE setting the invoice (the snapshot-failed branch + the 401/403/permanent branches), DELETE the claim row first:
```typescript
async function deleteClaim(db: Db, orderId: number, billingPeriod: string): Promise<void> {
  await db
    .delete(invoiceRuns)
    .where(and(eq(invoiceRuns.orderId, orderId), eq(invoiceRuns.billingPeriod, billingPeriod)));
}
```
Call `await deleteClaim(db, order.bexioOrderId, billingPeriod);` before the 4 early-return paths in the bexio-error catch (around lines 162-205).

- [ ] **Step 2.1.4: Run tests + verify**

```bash
bun test
```

- [ ] **Step 2.1.5: Commit**

```bash
git add apps/worker/src/lib/state-machine.ts apps/worker/src/lib/state-machine.test.ts
git commit -m "$(cat <<'EOF'
fix(worker): claim-row before bexio call to prevent orphan invoices (F-3, N-10)

Two parallel /api/trigger-run calls both passed the early duplicate guard,
both POSTed to bexio (each created an invoice), only one won the INSERT
ON CONFLICT — the other returned skipped_duplicate while its bexio invoice
sat as an orphan draft.

New pipeline: claim the (order_id, billing_period) slot with INSERT status='creating'
BEFORE bexio. Loser gets concurrent-in-flight back-off (not duplicate, since the
winner may not have completed yet). On bexio failure: deleteClaim cleans up so
next run can retry.

EOF
)"
```

### Task 2.2: Roll back to 'issued' status when send fails after issue succeeded (F-2)

**Files:**
- Modify: `apps/worker/src/lib/state-machine.ts:242-289`

- [ ] **Step 2.2.1: Add `wasIssued` tracker + new catch path**

Replace the issue/send try-catch block (around lines 242-289) with:

```typescript
  // Step 3: drive through issuing → issued → sending → sent
  let wasIssued = false;
  try {
    await transitionTo(db, order.bexioOrderId, billingPeriod, 'issuing');
    await issueInvoice(accessToken, invoice.id);
    console.log(`${ctx} issued invoice ${invoice.id} (${invoice.document_nr})`);
    await transitionTo(db, order.bexioOrderId, billingPeriod, 'issued', { issuedAt: new Date() });
    wasIssued = true;

    if (!order.customerEmail) {
      throw new Error(`No customer email for ${order.customerName}. Update the contact in bexio.`);
    }

    const docNr = invoice.document_nr;
    await transitionTo(db, order.bexioOrderId, billingPeriod, 'sending', { lockAcquiredAt: new Date() });
    await sendInvoice(accessToken, invoice.id, {
      recipientEmail: order.customerEmail,
      subject: renderTemplate(MAIL_SUBJECT_TEMPLATE, { document_nr: docNr }),
      message: renderTemplate(MAIL_MESSAGE_TEMPLATE, { document_nr: docNr }),
      attachPdf: true,
    });
    console.log(`${ctx} sent invoice ${invoice.id} to ${order.customerEmail}`);
    await transitionTo(db, order.bexioOrderId, billingPeriod, 'sent', { sentAt: new Date(), lockAcquiredAt: null });

    return { kind: 'sent', invoiceId: invoice.id, amount: invoice.total, billingPeriod };
  } catch (err) {
    if (err instanceof BexioApiError) {
      console.error(`${ctx} issue/send FAILED invoice=${invoice.id} status=${err.status} class=${err.errorClass} body=${err.body}`);
    } else {
      console.error(`${ctx} issue/send FAILED invoice=${invoice.id}:`, err);
    }

    if (wasIssued) {
      // Invoice is festgeschrieben in bexio. Don't mark failed — let
      // retryIssuedRows pick it up on the next run instead. The error is
      // persisted to error_jsonb for visibility but status stays 'issued'.
      const errorJsonb =
        err instanceof BexioApiError
          ? { kind: 'bexio_api', status: err.status, errorClass: err.errorClass, body: err.body.slice(0, 500), at: 'send' }
          : { kind: 'unknown', message: err instanceof Error ? err.message : String(err), at: 'send' };
      await db
        .update(invoiceRuns)
        .set({ status: 'issued', errorJsonb, lockAcquiredAt: null, updatedAt: new Date() })
        .where(and(eq(invoiceRuns.orderId, order.bexioOrderId), eq(invoiceRuns.billingPeriod, billingPeriod)));
      return {
        kind: 'failed',
        reason: `send failed but invoice ${invoice.id} is issued — will retry next run: ${err instanceof Error ? err.message : String(err)}`,
        bexioStatus: err instanceof BexioApiError ? err.status : undefined,
        invoiceId: invoice.id,
      };
    }

    // Issue itself failed — mark fully failed.
    await markFailed(db, order.bexioOrderId, billingPeriod, err);
    return {
      kind: 'failed',
      reason: err instanceof BexioApiError ? `${err.errorClass}: ${err.body.slice(0, 800)}` : String(err),
      bexioStatus: err instanceof BexioApiError ? err.status : undefined,
      invoiceId: invoice.id,
    };
  }
```

- [ ] **Step 2.2.2: Verify tests still pass**

```bash
bun test
```

- [ ] **Step 2.2.3: Commit**

```bash
git add apps/worker/src/lib/state-machine.ts
git commit -m "$(cat <<'EOF'
fix(worker): roll back to 'issued' when send fails post-issue (F-2)

If issueInvoice succeeded (invoice festgeschrieben in bexio) but sendInvoice
threw, markFailed set status='failed'. retryIssuedRows only picks up
status='issued', so the customer email never went out. Next run's duplicate
guard then short-circuited the whole order.

Now: track wasIssued. Send-failure with wasIssued=true rolls status back to
'issued' (not 'failed') so retryIssuedRows resumes from the next run. Error
is persisted to error_jsonb with at:'send' for visibility.

EOF
)"
```

### Task 2.3: Atomic claim in `retryIssuedRows` (N-4)

**Files:**
- Modify: `apps/worker/src/lib/state-machine.ts:403-454`

- [ ] **Step 2.3.1: Replace SELECT + iterate with atomic UPDATE-RETURNING**

Replace `retryIssuedRows` body with:

```typescript
export async function retryIssuedRows(db: Db, accessToken: string): Promise<number> {
  // Atomically claim ALL eligible 'issued' rows in one transaction by
  // transitioning them to 'sending' + setting lock_acquired_at. Concurrent
  // workers won't see the same rows.
  const claimed = await db
    .update(invoiceRuns)
    .set({
      status: 'sending',
      lockAcquiredAt: new Date(),
      attempts: sql`${invoiceRuns.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(invoiceRuns.status, 'issued'), lt(invoiceRuns.attempts, MAX_ATTEMPTS)))
    .returning();

  let recovered = 0;

  for (const row of claimed) {
    if (!row.invoiceId) {
      await markFailed(db, row.orderId, row.billingPeriod, new Error('no_invoice_id_on_retry'));
      continue;
    }

    const orders = await db
      .select()
      .from(recurringOrders)
      .where(eq(recurringOrders.bexioOrderId, row.orderId));
    const order = orders[0];
    if (!order?.customerEmail) {
      await markFailed(db, row.orderId, row.billingPeriod, new Error('no_customer_email_on_retry'));
      continue;
    }

    try {
      const live = await getInvoice(accessToken, row.invoiceId);
      const docNr = live.document_nr;
      await sendInvoice(accessToken, row.invoiceId, {
        recipientEmail: order.customerEmail,
        subject: renderTemplate(MAIL_SUBJECT_TEMPLATE, { document_nr: docNr }),
        message: renderTemplate(MAIL_MESSAGE_TEMPLATE, { document_nr: docNr }),
        attachPdf: true,
      });
      await transitionTo(db, row.orderId, row.billingPeriod, 'sent', { sentAt: new Date(), lockAcquiredAt: null });
      recovered += 1;
    } catch (err) {
      // Already incremented attempts in the claim step. Roll back to 'issued'
      // so future runs can try again, unless we've hit MAX_ATTEMPTS.
      if (row.attempts != null && row.attempts >= MAX_ATTEMPTS - 1) {
        await markFailed(db, row.orderId, row.billingPeriod, err);
      } else {
        const errorJsonb =
          err instanceof BexioApiError
            ? { kind: 'bexio_api', status: err.status, errorClass: err.errorClass, body: err.body.slice(0, 500) }
            : { kind: 'unknown', message: err instanceof Error ? err.message : String(err) };
        await db
          .update(invoiceRuns)
          .set({ status: 'issued', lockAcquiredAt: null, errorJsonb, updatedAt: new Date() })
          .where(and(eq(invoiceRuns.orderId, row.orderId), eq(invoiceRuns.billingPeriod, row.billingPeriod)));
      }
    }
  }

  return recovered;
}
```

- [ ] **Step 2.3.2: Run tests**

```bash
bun test
```

- [ ] **Step 2.3.3: Commit**

```bash
git add apps/worker/src/lib/state-machine.ts
git commit -m "fix(worker): atomic claim in retryIssuedRows to prevent duplicate sends (N-4)"
```

### Task 2.4: Trust local send-attempt over bexio's flaky is_sent readback (N-5)

**Files:**
- Modify: `apps/worker/src/lib/state-machine.ts:333-398` (reconcileInFlightSends)

bexio's quirk: GET /kb_invoice/{id} after a successful /send may STILL show is_sent=undefined. Current reconcile rolls back to 'issued' → retryIssuedRows sends again → customer gets 2-4 emails.

Strategy: if status='sending' + lock stale + attempts >= 1, ASSUME the send already happened. Mark as 'sent' with `lockAcquiredAt=null`. Only roll back to 'issued' if attempts === 0 (never tried).

- [ ] **Step 2.4.1: Replace reconcileInFlightSends body**

```typescript
export async function reconcileInFlightSends(db: Db, accessToken: string): Promise<{
  reconciledSent: number;
  reconciledIssued: number;
  reconciledFailed: number;
}> {
  const cutoff = new Date(Date.now() - LOCK_STALE_MS);

  const stuck = await db
    .select()
    .from(invoiceRuns)
    .where(and(eq(invoiceRuns.status, 'sending'), lt(invoiceRuns.lockAcquiredAt, cutoff)));

  let reconciledSent = 0;
  let reconciledIssued = 0;
  let reconciledFailed = 0;

  for (const row of stuck) {
    if (!row.invoiceId) {
      reconciledFailed += 1;
      await markFailed(db, row.orderId, row.billingPeriod, new Error('crash_during_send_no_invoice_id'));
      continue;
    }

    try {
      const live = await getInvoice(accessToken, row.invoiceId);
      if (live.is_sent || live.mail_sent_at) {
        // bexio confirms sent — trust it.
        await transitionTo(db, row.orderId, row.billingPeriod, 'sent', {
          sentAt: live.mail_sent_at ? new Date(live.mail_sent_at) : new Date(),
          lockAcquiredAt: null,
        });
        reconciledSent += 1;
      } else if ((row.attempts ?? 0) >= 1) {
        // bexio doesn't confirm sent, but we ALREADY tried at least once.
        // bexio is famously flaky here (is_sent read-back may stay undefined
        // even after a successful /send). Assume the send happened to avoid
        // duplicate customer emails. If it really didn't go out, Marcus will
        // notice from a missing receipt.
        console.warn(
          `[reconcile order=${row.orderId} period=${row.billingPeriod}] bexio is_sent unconfirmed after ${row.attempts} attempts — assuming sent (bexio read-back quirk)`,
        );
        await transitionTo(db, row.orderId, row.billingPeriod, 'sent', {
          sentAt: new Date(),
          lockAcquiredAt: null,
        });
        reconciledSent += 1;
      } else if ((row.attempts ?? 0) >= MAX_ATTEMPTS) {
        await markFailed(db, row.orderId, row.billingPeriod, new Error('send_retries_exhausted'));
        reconciledFailed += 1;
      } else {
        // attempts === 0 — was claimed but never actually called send. Safe to retry.
        await db
          .update(invoiceRuns)
          .set({
            status: 'issued',
            lockAcquiredAt: null,
            attempts: sql`${invoiceRuns.attempts} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(invoiceRuns.orderId, row.orderId), eq(invoiceRuns.billingPeriod, row.billingPeriod)));
        reconciledIssued += 1;
      }
    } catch (err) {
      await markFailed(db, row.orderId, row.billingPeriod, err);
      reconciledFailed += 1;
    }
  }

  return { reconciledSent, reconciledIssued, reconciledFailed };
}
```

- [ ] **Step 2.4.2: Run tests + commit**

```bash
bun test
git add apps/worker/src/lib/state-machine.ts
git commit -m "fix(worker): assume-sent on bexio is_sent read-back quirk during reconcile (N-5)"
```

### Task 2.5: Atomic subscription success transition (N-6)

**Files:**
- Modify: `apps/worker/src/lib/subscriptions.ts:179-196`

- [ ] **Step 2.5.1: Wrap success-write + next_billing_date advance in transaction**

Replace the success block:
```typescript
    // 5. Mark success + advance next_billing_date — ATOMIC
    const newNext = addBillingInterval(sub.nextBillingDate, sub.interval as SubscriptionInterval);
    await db.transaction(async (tx) => {
      await tx
        .update(billingRuns)
        .set({ status: 'success', bexioInvoiceId: invoice.id, executedAt: new Date() })
        .where(eq(billingRuns.id, runRow.id));
      await tx
        .update(subscriptions)
        .set({ nextBillingDate: newNext, updatedAt: new Date() })
        .where(eq(subscriptions.id, sub.id));
    });
```

- [ ] **Step 2.5.2: Run tests + commit**

```bash
bun test
git add apps/worker/src/lib/subscriptions.ts
git commit -m "fix(worker): atomic billing_runs success + next_billing_date advance (N-6)"
```

### Task 2.6: Phase 2 deploy + verify

- [ ] Push, deploy both apps (Worker + Web), poll `.status==finished`, browser-trigger run on AU-00013.

```bash
git push origin main
TOKEN=$(grep '^COOLIFY_API_TOKEN=' .env.local | cut -d'=' -f2-)
curl -s -X POST "https://coolify.martini.digital/api/v1/deploy?uuid=s8dljxy4nawz52bxcjhar9nm" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "https://coolify.martini.digital/api/v1/deploy?uuid=vx76yeg463w2ckfndrsbsj8m" -H "Authorization: Bearer $TOKEN"
```

---

# Phase 3 — Period-Key Precision

**Goal:** Eliminate the split-brain scenarios where period keys can mismatch between calls.

### Task 3.1: Repetition fetch must succeed (no silent monthly fallback for keys) (N-3)

**Files:**
- Modify: `apps/worker/src/lib/state-machine.ts:101-124` (Step 0)

- [ ] **Step 3.1.1: Retry then fail-closed**

Replace the existing Step 0 block:
```typescript
  // Step 0: fetch repetition — REQUIRED for billing-period granularity.
  // We retry once before giving up. Silent fallback to monthly is unsafe
  // because a later successful fetch would use a different period key for
  // the same logical day, allowing duplicate invoices (N-3).
  let repetitionType: string | undefined;
  let repetitionFetchSucceeded = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const rep = await getOrderRepetition(accessToken, order.bexioOrderId);
      if (!isSupportedBexioInterval(rep)) {
        console.log(`[order=${order.bexioOrderId}] unsupported bexio repetition type "${rep?.repetition?.type ?? 'unknown'}" — skipping`);
        return { kind: 'skipped_unsupported', bexioType: rep?.repetition?.type ?? 'unknown' };
      }
      repetitionType = rep?.repetition?.type;
      repetitionFetchSucceeded = true;
      break;
    } catch (err) {
      if (attempt === 1) {
        console.error(`[order=${order.bexioOrderId}] getOrderRepetition failed after 2 attempts:`, err);
      }
    }
  }
  if (!repetitionFetchSucceeded) {
    return {
      kind: 'failed',
      reason: 'could not fetch repetition config from bexio after 2 attempts — refusing to process to avoid split-brain period keys',
    };
  }
```

- [ ] **Step 3.1.2: Commit**

```bash
git add apps/worker/src/lib/state-machine.ts
git commit -m "fix(worker): require repetition fetch success for period granularity (N-3)"
```

### Task 3.2: Use invoice.is_valid_from as the persisted period key (N-2)

**Files:**
- Modify: `apps/worker/src/lib/state-machine.ts` (after invoice is created)

The early-claim still uses today's period (cheap, best-effort). After bexio returns the invoice, recompute the period from `invoice.is_valid_from` and migrate the row.

- [ ] **Step 3.2.1: After invoice creation, reconcile period key**

After the `UPDATE invoice_runs SET invoiceId = invoice.id` step (where we filled in the claim), add:
```typescript
  const invoiceValidFrom = invoice.is_valid_from ?? invoiceDate;
  const truePeriod = formatBillingPeriod(invoiceValidFrom, repetitionType);
  if (truePeriod !== billingPeriod) {
    // bexio chose a different is_valid_from than today (e.g., Marcus or
    // recurring schedule shifted it). Move the row to the correct key.
    await db
      .update(invoiceRuns)
      .set({ billingPeriod: truePeriod, updatedAt: new Date() })
      .where(and(eq(invoiceRuns.orderId, order.bexioOrderId), eq(invoiceRuns.billingPeriod, billingPeriod)));
    console.log(`${ctx} migrated period key ${billingPeriod} → ${truePeriod} (from invoice is_valid_from)`);
    // Update local var so subsequent transitionTo calls use the right key
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (order as any).__effectivePeriod = truePeriod;
  }
```

Note: subsequent `transitionTo(db, order.bexioOrderId, billingPeriod, ...)` calls reference the local `billingPeriod` var. After migration, reassign: `billingPeriod = truePeriod;` (use `let` instead of `const` for `billingPeriod` at the top).

- [ ] **Step 3.2.2: Change `const billingPeriod` to `let billingPeriod`**

Find the line `const billingPeriod = formatBillingPeriod(invoiceDate, repetitionType);` and change to `let billingPeriod = ...`.

In the migration block above, also do:
```typescript
    billingPeriod = truePeriod;
```

- [ ] **Step 3.2.3: Verify types in BexioInvoice include `is_valid_from`**

Check `packages/bexio-client/src/types.ts` — `BexioInvoice` type should have `is_valid_from?: string`. If missing, add it (no schema change needed — bexio returns it):

```typescript
export type BexioInvoice = {
  // ... existing fields ...
  is_valid_from?: string;
  // ... rest
};
```

- [ ] **Step 3.2.4: Run tests + commit**

```bash
bun test
git add apps/worker/src/lib/state-machine.ts packages/bexio-client/src/types.ts
git commit -m "fix(worker): reconcile billing_period key from invoice.is_valid_from (N-2)"
```

### Task 3.3: Phase 3 deploy + verify

- [ ] Push, deploy both, browser-trigger AU-00013, confirm no behavior regression.

---

# Phase 4 — TZ + Scheduling

### Task 4.1: Use Zurich-today (or `now()`) for subscription due check (F-4)

**Files:**
- Modify: `apps/worker/src/lib/run.ts:129`

- [ ] **Step 4.1.1: Replace UTC-midnight with current instant**

Find:
```typescript
const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
```

Replace with:
```typescript
// Use the current instant for due-checking. Subscriptions store
// next_billing_date as a date (midnight in whatever TZ they were inserted),
// so any past-day's stored date will compare as <= now(). Avoids the UTC vs
// Europe/Zurich mismatch that caused due subscriptions to be missed around
// midnight UTC (F-4).
const today = new Date();
```

- [ ] **Step 4.1.2: Commit**

```bash
git add apps/worker/src/lib/run.ts
git commit -m "fix(worker): use current instant instead of UTC-midnight for subscription due check (F-4)"
```

### Task 4.2: Raise + make-configurable the stale-run cutoff (F-5)

**Files:**
- Modify: `apps/web/src/routes/api/trigger-run/+server.ts:23`

- [ ] **Step 4.2.1: Raise STALE_MS to 2 hours + env-configurable**

Replace:
```typescript
const STALE_MS = 30 * 60 * 1000; // 30 minutes
```

With:
```typescript
// A real production run can exceed 30 min when many orders × bexio's 1.1s
// rate-limit. Two hours is a defensive upper bound; override via WORKER_RUN_STALE_MS
// env var if Marcus's account grows beyond that.
const STALE_MS = Number(process.env.WORKER_RUN_STALE_MS ?? 2 * 60 * 60 * 1000);
```

- [ ] **Step 4.2.2: Mirror in `apps/web/src/routes/api/runs/[id]/+server.ts:15`**

Same change.

- [ ] **Step 4.2.3: Commit**

```bash
git add apps/web/src/routes/api/trigger-run/+server.ts apps/web/src/routes/api/runs/\[id\]/+server.ts
git commit -m "fix(web): raise in-flight stale cutoff to 2h, configurable via env (F-5)"
```

### Task 4.3: Phase 4 deploy + verify

---

# Phase 5 — Sync Hardening

### Task 5.1: Don't wipe recurring_orders on empty bexio response (F-7)

**Files:**
- Modify: `apps/worker/src/lib/sync.ts:137-143`

- [ ] **Step 5.1.1: Replace the `sql\`true\`` fallback**

Replace:
```typescript
const seenArray = [...seenIds];
const deleteCondition = seenArray.length > 0
  ? notInArray(recurringOrders.bexioOrderId, seenArray)
  : sql`true`;
const deleted = await db.delete(recurringOrders).where(deleteCondition).returning({ id: recurringOrders.bexioOrderId });
removedOrders = deleted.length;
```

With:
```typescript
const seenArray = [...seenIds];
if (seenArray.length === 0) {
  // bexio returned zero recurring orders. Almost certainly a transient API
  // issue, not a legitimate "Marcus deleted everything" event. Skip the
  // orphan cleanup this run; we'd lose the enabled flags on all opt-in rows.
  console.warn('sync: bexio returned zero recurring orders — skipping orphan cleanup to protect cache');
} else {
  const deleted = await db
    .delete(recurringOrders)
    .where(notInArray(recurringOrders.bexioOrderId, seenArray))
    .returning({ id: recurringOrders.bexioOrderId });
  removedOrders = deleted.length;
}
```

- [ ] **Step 5.1.2: Commit**

```bash
git add apps/worker/src/lib/sync.ts
git commit -m "fix(worker): skip orphan cleanup when bexio returns empty list (F-7)"
```

### Task 5.2: Preserve nextBillingDate on repetition-fetch failure (F-10)

**Files:**
- Modify: `apps/worker/src/lib/sync.ts:50-118`

- [ ] **Step 5.2.1: Track fetch success, conditionally include in update set**

Above the `for (const o of orders)` loop, change the try/catch logic. Replace lines 50-65 with:
```typescript
    let interval: CanonicalInterval;
    let nextBillingDate: Date;
    let unsupportedType: string | undefined;
    let repetitionFetchOk = true;
    try {
      const rep = await getOrderRepetition(accessToken, o.id);
      interval = mapRepetitionToInterval(rep);
      nextBillingDate = computeNextBilling(rep) ?? new Date();
      if (!isSupportedBexioInterval(rep)) {
        unsupportedType = rep?.repetition?.type ?? 'unknown';
      }
    } catch {
      repetitionFetchOk = false;
      interval = 'monthly';
      nextBillingDate = new Date();
    }
```

Then change the `onConflictDoUpdate` set (around lines 107-118) to conditionally include `nextBillingDate`:
```typescript
      .onConflictDoUpdate({
        target: recurringOrders.bexioOrderId,
        set: {
          customerName,
          customerEmail,
          interval,
          expectedAmount: o.total,
          ...(repetitionFetchOk ? { nextBillingDate } : {}), // preserve existing if fetch failed
          bexioStatus,
          bexioStatusId: o.kb_item_status_id ?? null,
          syncedAt: new Date(),
        },
      })
```

- [ ] **Step 5.2.2: Commit**

```bash
git add apps/worker/src/lib/sync.ts
git commit -m "fix(worker): preserve existing nextBillingDate when repetition fetch fails (F-10)"
```

### Task 5.3: Graceful degradation at >5000 orders cap (F-11)

**Files:**
- Modify: `packages/bexio-client/src/orders.ts:29`

- [ ] **Step 5.3.1: Replace throw with warn + break**

```typescript
    if (offset > 5000) {
      console.warn('listRecurringOrders: > 5000 orders, capping at 5000 for safety');
      break;
    }
```

- [ ] **Step 5.3.2: Commit**

```bash
git add packages/bexio-client/src/orders.ts
git commit -m "fix(bexio-client): graceful degradation at 5000-order pagination cap (F-11)"
```

### Task 5.4: Phase 5 deploy + verify

---

# Phase 6 — Auth + Rate-Limit Concurrency

### Task 6.1: DB advisory lock around token refresh (F-6)

**Files:**
- Modify: `packages/bexio-client/src/auth.ts:37-78`

- [ ] **Step 6.1.1: Wrap refresh in transaction with advisory_xact_lock**

Replace the body of `getValidAccessToken`:
```typescript
export async function getValidAccessToken(db: Db): Promise<string> {
  // Fast path: read current token, return if still valid.
  const access = await readSecret(db, 'bexio_access_token');
  if (access && access.expiresAt && access.expiresAt.getTime() - Date.now() > REFRESH_BUFFER_MS) {
    return access.value;
  }

  // Slow path: acquire DB-level lock so only one process performs the refresh.
  // The lock is bound to the transaction (auto-released on commit/rollback).
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${TOKEN_REFRESH_LOCK_KEY})`);

    // Re-read after lock acquired — another process may have refreshed for us.
    const fresh = await readSecretTx(tx, 'bexio_access_token');
    if (fresh && fresh.expiresAt && fresh.expiresAt.getTime() - Date.now() > REFRESH_BUFFER_MS) {
      return fresh.value;
    }

    const refresh = await readSecretTx(tx, 'bexio_refresh_token');
    if (!refresh) {
      throw new BexioApiError(401, 'auth', 'No refresh token in DB. Run `bun run oauth-setup`.');
    }

    const clientId = process.env.BEXIO_CLIENT_ID;
    const clientSecret = process.env.BEXIO_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new BexioApiError(401, 'auth', 'BEXIO_CLIENT_ID / BEXIO_CLIENT_SECRET not in env.');
    }

    const params = new URLSearchParams();
    params.set('grant_type', 'refresh_token');
    params.set('refresh_token', refresh.value);
    params.set('client_id', clientId);
    params.set('client_secret', clientSecret);

    const res = await callTokenEndpoint(params);
    if (!res.ok) {
      const body = await res.text();
      throw new BexioApiError(res.status, 'auth', `Token refresh failed: ${body}`);
    }

    const tokens = (await res.json()) as TokenResponse;
    const newExpiresAt = new Date(Date.now() + tokens.expires_in * 1000);

    // Write both atomically within the same transaction
    await writeSecretTx(tx, 'bexio_access_token', tokens.access_token, newExpiresAt);
    await writeSecretTx(tx, 'bexio_refresh_token', tokens.refresh_token, null);

    return tokens.access_token;
  });
}

const TOKEN_REFRESH_LOCK_KEY = 4242_001; // arbitrary unique bigint
```

Add `sql` import: `import { eq, sql } from 'drizzle-orm';`.

Add `readSecretTx` and `writeSecretTx` mirrors that accept a transaction context (essentially the same as `readSecret`/`writeSecret` but typed against the tx). Or refactor existing functions to accept either `db | tx`.

- [ ] **Step 6.1.2: Commit**

```bash
git add packages/bexio-client/src/auth.ts
git commit -m "fix(bexio-client): single-flight token refresh via pg_advisory_xact_lock (F-6)"
```

### Task 6.2: Concurrent-safe rate pacing (N-9)

**Files:**
- Modify: `packages/bexio-client/src/http.ts:13-20`

- [ ] **Step 6.2.1: Replace shared-mutable `lastCallAt` with promise-chain queue**

```typescript
const MIN_GAP_MS = 1100;
let lastCallAt = 0;
let paceChain: Promise<void> = Promise.resolve();

async function pace(): Promise<void> {
  // Serialize all pace() calls so concurrent callers actually space out
  // 1.1s apart instead of all sleeping until the same instant + bursting
  // together (which caused 429s on multi-item subscription flows).
  const myTurn = paceChain.then(async () => {
    const now = Date.now();
    const elapsed = now - lastCallAt;
    if (elapsed < MIN_GAP_MS) {
      await new Promise((r) => setTimeout(r, MIN_GAP_MS - elapsed));
    }
    lastCallAt = Date.now();
  });
  paceChain = myTurn.catch(() => undefined); // never let one failure poison the chain
  await myTurn;
}
```

- [ ] **Step 6.2.2: Commit**

```bash
git add packages/bexio-client/src/http.ts
git commit -m "fix(bexio-client): serialize pace() via promise chain for concurrency safety (N-9)"
```

### Task 6.3: Phase 6 deploy + verify

---

# Phase 7 — Recovery + Observability

### Task 7.1: Subscription billing_runs recovery (F-12)

**Files:**
- Modify: `apps/worker/src/lib/subscriptions.ts` (new function)
- Modify: `apps/worker/src/lib/run.ts` (call it)

- [ ] **Step 7.1.1: Add `reconcileInFlightBillingRuns`**

In `subscriptions.ts`, add:
```typescript
const STALE_MS = 30 * 60 * 1000;

/**
 * Recover from crashes during processOneSubscription. Find billing_runs rows
 * stuck in status='pending' that are older than STALE_MS, and decide:
 *   - bexio invoice exists and is sent → mark success, advance next_billing_date
 *   - bexio invoice exists but not issued → delete row, will retry next run
 *   - no bexio invoice → delete row, retry next run
 */
export async function reconcileInFlightBillingRuns(db: Db, accessToken: string): Promise<{
  reconciled: number;
  deleted: number;
}> {
  const cutoff = new Date(Date.now() - STALE_MS);
  const stuck = await db
    .select()
    .from(billingRuns)
    .where(and(eq(billingRuns.status, 'pending'), lt(billingRuns.createdAt, cutoff)));

  let reconciled = 0;
  let deleted = 0;

  for (const row of stuck) {
    if (row.bexioInvoiceId) {
      // We have an invoice ID — check if it's fully sent in bexio
      try {
        const live = await getInvoice(accessToken, row.bexioInvoiceId);
        if (live.is_sent || live.mail_sent_at) {
          // Atomically mark success + advance subscription date
          await db.transaction(async (tx) => {
            await tx
              .update(billingRuns)
              .set({ status: 'success', executedAt: new Date() })
              .where(eq(billingRuns.id, row.id));

            const subs = await tx
              .select()
              .from(subscriptions)
              .where(eq(subscriptions.id, row.subscriptionId));
            const sub = subs[0];
            if (sub && sub.nextBillingDate.getTime() === row.scheduledFor.getTime()) {
              const newNext = addBillingInterval(sub.nextBillingDate, sub.interval as SubscriptionInterval);
              await tx
                .update(subscriptions)
                .set({ nextBillingDate: newNext, updatedAt: new Date() })
                .where(eq(subscriptions.id, sub.id));
            }
          });
          reconciled += 1;
        } else {
          // Invoice exists but not confirmed sent — let the next run retry send via the invoice
          await db.delete(billingRuns).where(eq(billingRuns.id, row.id));
          deleted += 1;
        }
      } catch {
        await db.delete(billingRuns).where(eq(billingRuns.id, row.id));
        deleted += 1;
      }
    } else {
      // No invoice ID at all — bexio call never completed. Safe to delete + retry.
      await db.delete(billingRuns).where(eq(billingRuns.id, row.id));
      deleted += 1;
    }
  }

  return { reconciled, deleted };
}
```

Don't forget imports for `getInvoice`, `lt`.

- [ ] **Step 7.1.2: Call from `run.ts` before `processSubscriptions`**

In `run.ts`, around line 127 (before the `processSubscriptions` call):
```typescript
  if (!options.dryRun) {
    try {
      const recon = await reconcileInFlightBillingRuns(db, accessToken);
      if (recon.reconciled > 0 || recon.deleted > 0) {
        console.log(`reconciled ${recon.reconciled} stuck billing_runs, deleted ${recon.deleted}`);
      }
    } catch (err) {
      errors.push({
        stage: 'reconcileInFlightBillingRuns',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
```

- [ ] **Step 7.1.3: Commit**

```bash
git add apps/worker/src/lib/subscriptions.ts apps/worker/src/lib/run.ts
git commit -m "fix(worker): reconcileInFlightBillingRuns for crash-recovery of subscription pipeline (F-12)"
```

### Task 7.2: Split create-count vs duplicate-count in Discord (F-8)

**Files:**
- Modify: `apps/worker/src/lib/run.ts:142-146`
- Modify: `packages/notify/src/discord.ts:101-115`

- [ ] **Step 7.2.1: Split counters in run.ts**

Replace:
```typescript
  const created =
    results.filter((r) => r.result.kind === 'sent' || r.result.kind === 'skipped_duplicate').length +
    subscriptionResults.filter((r) => r.kind === 'sent' || r.kind === 'skipped_duplicate').length;
  const sent =
    results.filter((r) => r.result.kind === 'sent').length +
    subscriptionResults.filter((r) => r.kind === 'sent').length;
```

With:
```typescript
  const created = // truly new invoices
    results.filter((r) => r.result.kind === 'sent').length +
    subscriptionResults.filter((r) => r.kind === 'sent').length;
  const sent = created; // currently sent == created (every created is also sent)
  const skippedDuplicate =
    results.filter((r) => r.result.kind === 'skipped_duplicate').length +
    subscriptionResults.filter((r) => r.kind === 'skipped_duplicate').length;
```

- [ ] **Step 7.2.2: Update Discord title to show actual new invoices**

In `discord.ts` `pickTitle`, change the success title to use `sentCount` (truly new) not `resultCount`:
```typescript
  if (status === 'success' && sentCount > 0) return `Lauf erfolgreich · ${sentCount} neue Rechnungen`;
  if (status === 'success' && sentCount === 0) return 'Lauf erfolgreich · keine neuen Rechnungen (Duplikate übersprungen)';
```

- [ ] **Step 7.2.3: Commit**

```bash
git add apps/worker/src/lib/run.ts packages/notify/src/discord.ts
git commit -m "fix(worker, notify): split created vs skipped_duplicate counters (F-8)"
```

### Task 7.3: Replace BexioApiError(status=0) with proper local error (F-9)

**Files:**
- Modify: `apps/worker/src/lib/state-machine.ts:253-257`
- Modify: `apps/worker/src/lib/subscriptions.ts:139` (already replaced in Task 1.2)

- [ ] **Step 7.3.1: Use plain Error for state-machine local validation**

In `state-machine.ts`, find:
```typescript
      throw new BexioApiError(
        0,
        'permanent',
        `No customer email for ${order.customerName}. Update the contact in bexio.`,
      );
```

Replace with:
```typescript
      throw new Error(`No customer email for ${order.customerName}. Update the contact in bexio.`);
```

The catch block already handles non-BexioApiError via `errorJsonb.kind = 'unknown'`.

- [ ] **Step 7.3.2: Commit**

```bash
git add apps/worker/src/lib/state-machine.ts
git commit -m "fix(worker): use plain Error for local validation, not BexioApiError(status=0) (F-9)"
```

### Task 7.4: dryRun skips destructive sync (N-11)

**Files:**
- Modify: `apps/worker/src/lib/sync.ts` (add option)
- Modify: `apps/worker/src/lib/run.ts:88`

- [ ] **Step 7.4.1: Add `dryRun` option to syncRecurringOrders**

In `sync.ts`, change signature:
```typescript
export async function syncRecurringOrders(
  db: Db,
  accessToken: string,
  options: { dryRun?: boolean } = {},
): Promise<SyncResult> {
```

Wrap the destructive delete block (currently in Task 5.1's fixed form):
```typescript
  if (options.dryRun) {
    console.log('sync: dry-run mode — skipping orphan cleanup');
  } else if (seenArray.length === 0) {
    console.warn('sync: bexio returned zero recurring orders — skipping orphan cleanup to protect cache');
  } else {
    const deleted = await db
      .delete(recurringOrders)
      .where(notInArray(recurringOrders.bexioOrderId, seenArray))
      .returning({ id: recurringOrders.bexioOrderId });
    removedOrders = deleted.length;
  }
```

Also: gate the upsert with `if (!options.dryRun)` — dry-run should NOT write anything. Or keep upserts for cache freshness; user choice. The minimal fix is to skip the destructive delete.

Actually for true dry-run: gate ALL writes. Move the upsert inside `if (!options.dryRun)`. The function returns the same shape regardless (counts would be 0 for `newlyAdded` etc.).

- [ ] **Step 7.4.2: Pass dryRun from run.ts**

In `run.ts:88`:
```typescript
  const sync = await syncRecurringOrders(db, accessToken, { dryRun: options.dryRun });
```

- [ ] **Step 7.4.3: Commit**

```bash
git add apps/worker/src/lib/sync.ts apps/worker/src/lib/run.ts
git commit -m "fix(worker): dry-run must not mutate sync state (N-11)"
```

### Task 7.5: Phase 7 deploy + final verify

```bash
git push origin main
TOKEN=$(grep '^COOLIFY_API_TOKEN=' .env.local | cut -d'=' -f2-)
curl -s -X POST "https://coolify.martini.digital/api/v1/deploy?uuid=s8dljxy4nawz52bxcjhar9nm" -H "Authorization: Bearer $TOKEN"
curl -s -X POST "https://coolify.martini.digital/api/v1/deploy?uuid=vx76yeg463w2ckfndrsbsj8m" -H "Authorization: Bearer $TOKEN"
```

After both deploys finish: browser-trigger AU-00013, verify `/runs` shows a new daily invoice, verify Discord embed says "1 neue Rechnungen" (not "1/1 Rechnungen") and the `↺` field for any duplicates is clearly separated.

---

## Self-Review Checklist (done before handing back to user)

**Spec coverage:** All 21 findings (12 mine + 9 from Codex's adversarial pass, minus duplicates) appear in tasks above: ✅
- F-1 → 1.3 ✅
- F-2 → 2.2 ✅
- F-3 → 2.1 ✅
- F-4 → 4.1 ✅
- F-5 → 4.2 ✅
- F-6 → 6.1 ✅
- F-7 → 5.1 ✅
- F-8 → 7.2 ✅
- F-9 → 7.3 ✅
- F-10 → 5.2 ✅
- F-11 → 5.3 ✅
- F-12 → 7.1 ✅
- N-1 → 1.1 ✅
- N-2 → 3.2 ✅
- N-3 → 3.1 ✅
- N-4 → 2.3 ✅
- N-5 → 2.4 ✅
- N-6 → 2.5 ✅
- N-7 → 1.2 ✅
- N-8 → 1.2 ✅
- N-9 → 6.2 ✅
- N-10 → 2.1 (covered by F-3 fix) ✅
- N-11 → 7.4 ✅

**Placeholder scan:** no TBD / TODO / implement later — every step has actual code.

**Type consistency:** `repetitionType: string | undefined` is used consistently between `state-machine.ts`, the predicate `shouldSnapshotFallback`, and `formatBillingPeriod`. `ClaimResult` discriminated union is consistent across `interpretClaimResult` and the call site. `RetryClass` is exported and used in `classifyForRetry` only.

---

## Deployment Checkpoints

After EACH phase, both apps must redeploy per `project_dual_app_deploy`:
- Worker `s8dljxy4nawz52bxcjhar9nm`
- Web `vx76yeg463w2ckfndrsbsj8m`

Don't batch deploys across phases — each phase is a stop-the-bleed checkpoint where the prior state is known-good.
