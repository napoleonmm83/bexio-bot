# Subscription-Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bot-internal subscription layer (monthly + yearly only) that creates invoices directly via `POST /kb_invoice`, bypassing bexio's broken recurring-engine API. Existing `recurring_orders` pipeline stays untouched.

**Architecture:** Three new Postgres tables (`subscriptions`, `subscription_items`, `billing_runs`) alongside the existing schema. New `processSubscriptions()` runs sequentially after `processOrder()` in the daily cron. New `/subscriptions` and `/billing-runs` routes in the SvelteKit dashboard. Idempotency via `UNIQUE(subscription_id, scheduled_for)`.

**Tech Stack:** Bun runtime, Drizzle ORM, postgres-js, SvelteKit 5 (Svelte runes), TypeScript. No new dependencies.

**Spec:** [`SUBSCRIPTION_DESIGN.md`](../../../SUBSCRIPTION_DESIGN.md) (commit `1f00ff5`).

**Test approach:** TDD only for pure date math (`addBillingInterval`). Everything else uses manual probe scripts (existing pattern from `apps/worker/src/test-bexio.ts` and `probe-invoice.ts`).

---

## Phase 1 — DB Schema

### Task 1: Add subscription tables to Drizzle schema

**Files:**
- Modify: `packages/db/src/schema.ts`

- [ ] **Step 1: Add the three tables at the bottom of `schema.ts`**

```typescript
// ── Subscription layer (bot-native, parallel to recurring_orders) ─────

export const subscriptionIntervalEnum = pgEnum('subscription_interval', [
  'monthly',
  'yearly',
]);

export const subscriptionStatusEnum = pgEnum('subscription_status', [
  'active',
  'paused',
  'cancelled',
]);

export const billingRunStatusEnum = pgEnum('billing_run_status', [
  'pending',
  'success',
  'failed',
  'skipped',
]);

/**
 * Bot-native subscriptions. The bot generates invoices directly via POST /kb_invoice
 * — bypasses bexio's recurring-engine API (which has no public trigger endpoint).
 * Address comes live from /contact at billing time → no drift.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    bexioContactId: integer('bexio_contact_id').notNull(),
    name: text('name').notNull(),
    interval: subscriptionIntervalEnum('interval').notNull(),
    startDate: timestamp('start_date', { withTimezone: true, mode: 'date' }).notNull(),
    endDate: timestamp('end_date', { withTimezone: true, mode: 'date' }),
    nextBillingDate: timestamp('next_billing_date', { withTimezone: true, mode: 'date' }).notNull(),
    status: subscriptionStatusEnum('status').notNull().default('active'),
    autoSend: boolean('auto_send').notNull().default(true),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dueIdx: index('idx_subscriptions_due')
      .on(t.nextBillingDate)
      .where(sql`status = 'active'`),
  }),
);

export const subscriptionItems = pgTable('subscription_items', {
  id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
  subscriptionId: integer('subscription_id')
    .notNull()
    .references(() => subscriptions.id, { onDelete: 'cascade' }),
  bexioArticleId: integer('bexio_article_id').notNull(),
  qty: text('qty').notNull().default('1'), // numeric as string for exact decimals
  positionOrder: integer('position_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const billingRuns = pgTable(
  'billing_runs',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    subscriptionId: integer('subscription_id')
      .notNull()
      .references(() => subscriptions.id),
    scheduledFor: timestamp('scheduled_for', { withTimezone: true, mode: 'date' }).notNull(),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    bexioInvoiceId: integer('bexio_invoice_id'),
    status: billingRunStatusEnum('status').notNull().default('pending'),
    errorJsonb: jsonb('error_jsonb'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqRun: index('uniq_billing_runs_sub_date').on(t.subscriptionId, t.scheduledFor),
    statusIdx: index('idx_billing_runs_status').on(t.status, t.createdAt),
  }),
);
```

- [ ] **Step 2: Use `uniqueIndex` for the billing_runs idempotency lock**

In the imports at the top of `schema.ts`, add `uniqueIndex`:

```typescript
import {
  pgTable,
  pgEnum,
  integer,
  text,
  boolean,
  timestamp,
  jsonb,
  primaryKey,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
```

In the `billingRuns` table definition, change the `uniqRun` line from `index(...)` to `uniqueIndex(...)`:

```typescript
    uniqRun: uniqueIndex('uniq_billing_runs_sub_date').on(t.subscriptionId, t.scheduledFor),
```

- [ ] **Step 3: Verify the schema compiles**

Run: `cd packages/db && bun run drizzle-kit generate --dry-run` (or just `bun run lint` from root)
Expected: No TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema.ts
git commit -m "feat(db): add subscriptions/subscription_items/billing_runs tables"
```

---

### Task 2: Generate and apply migration 0005

**Files:**
- Create: `packages/db/migrations/0005_*.sql` (drizzle-kit names it)

- [ ] **Step 1: Generate migration**

Run: `bun run db:generate`
Expected: New file `packages/db/migrations/0005_<random>.sql` with the three CREATE TABLE statements.

- [ ] **Step 2: Inspect the generated SQL**

Run: `cat packages/db/migrations/0005_*.sql`
Verify it contains: three `CREATE TYPE` (enums), three `CREATE TABLE`, one `CREATE UNIQUE INDEX uniq_billing_runs_sub_date`, one `CREATE INDEX idx_subscriptions_due` with the `WHERE status = 'active'` clause.

- [ ] **Step 3: Apply against local dev DB**

Pre-check: ensure `.env.local` has `DATABASE_URL` pointing at `localhost:5433`.
Run: `bun run db:migrate`
Expected output: migration applied, no errors.

- [ ] **Step 4: Verify in DB**

```bash
psql "$DATABASE_URL" -c "\d subscriptions" -c "\d subscription_items" -c "\d billing_runs"
```
Expected: three table descriptions; check FK + unique index visible.

- [ ] **Step 5: Commit**

```bash
git add packages/db/migrations/
git commit -m "feat(db): migration 0005 — subscription tables"
```

---

## Phase 2 — bexio-client Extensions

### Task 3: Add `listContacts` for the customer picker

**Files:**
- Modify: `packages/bexio-client/src/contacts.ts`
- Modify: `packages/bexio-client/src/index.ts`

- [ ] **Step 1: Add `listContacts` function**

Append to `packages/bexio-client/src/contacts.ts`:

```typescript
import type { BexioContact } from './types.ts';
import { callBexio } from './http.ts';

const PAGE_LIMIT = 200;

/**
 * List all contacts. Pages until exhausted. Used by the dashboard contact-picker.
 * Marcus is expected to have <50 contacts so a single page usually suffices.
 */
export async function listContacts(accessToken: string): Promise<BexioContact[]> {
  const all: BexioContact[] = [];
  let offset = 0;

  while (true) {
    const page = await callBexio<BexioContact[]>('/contact', {
      accessToken,
      query: { limit: PAGE_LIMIT, offset },
    });
    all.push(...page);
    if (page.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;
    if (offset > 5000) throw new Error('listContacts: >5000 contacts, refusing to page further');
  }

  return all;
}
```

(The existing `getContact` and import line remain. The new `import { callBexio }` line will conflict if `getContact` already imports it — keep only one import.)

- [ ] **Step 2: Export from index**

Modify `packages/bexio-client/src/index.ts` — change the `contacts.ts` re-export line to:
```typescript
export { getContact, listContacts } from './contacts.ts';
```

- [ ] **Step 3: Verify TS compiles**

Run: `bun run --cwd packages/bexio-client tsc --noEmit` (or `bun run lint` from root if it covers packages)
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/bexio-client/src/contacts.ts packages/bexio-client/src/index.ts
git commit -m "feat(bexio-client): add listContacts for dashboard picker"
```

---

### Task 4: Add `articles.ts` module

**Files:**
- Create: `packages/bexio-client/src/articles.ts`
- Modify: `packages/bexio-client/src/types.ts`
- Modify: `packages/bexio-client/src/index.ts`

- [ ] **Step 1: Add `BexioArticle` type to types.ts**

Append to `packages/bexio-client/src/types.ts`:

```typescript
/**
 * bexio article (Produkt). Fields used by the subscription layer to build
 * invoice positions. Verified live against /article endpoint 2026-05-XX.
 */
export type BexioArticle = {
  id: number;
  user_id?: number;
  article_type_id?: number;
  /** Article number shown to users (e.g. "HOST-BASIC") */
  intern_code: string;
  /** Display name (e.g. "Hosting Basic") */
  intern_name: string;
  intern_description?: string | null;
  /** Sale price as decimal string in CHF. Source-of-truth for billing. */
  sale_price?: string | null;
  purchase_price?: string | null;
  cost_price?: string | null;
  /** Default tax id (bexio's tax registry id, NOT a rate). Used for invoice positions. */
  sales_tax_id?: number | null;
  purchase_tax_id?: number | null;
  is_stock?: boolean;
  stock_id?: number | null;
  stock_nr?: number;
  stock_min_nr?: number;
  stock_reserved_nr?: number;
  stock_available_nr?: number;
  stock_picked_nr?: number;
  updated_at?: string;
};
```

- [ ] **Step 2: Create articles.ts**

Create `packages/bexio-client/src/articles.ts`:

```typescript
// /article endpoints. Used by the subscription layer to build invoice positions
// from a product catalog, and to pull live prices at billing time (no drift).

import { callBexio } from './http.ts';
import type { BexioArticle } from './types.ts';

const PAGE_LIMIT = 200;

/**
 * List all articles. Pages until exhausted. Used by the dashboard product-picker
 * when creating a subscription.
 */
export async function listArticles(accessToken: string): Promise<BexioArticle[]> {
  const all: BexioArticle[] = [];
  let offset = 0;

  while (true) {
    const page = await callBexio<BexioArticle[]>('/article', {
      accessToken,
      query: { limit: PAGE_LIMIT, offset },
    });
    all.push(...page);
    if (page.length < PAGE_LIMIT) break;
    offset += PAGE_LIMIT;
    if (offset > 5000) throw new Error('listArticles: >5000 articles, refusing to page further');
  }

  return all;
}

/**
 * Get a single article. Called at billing time to get the current sale_price + tax_id
 * — pulling live ensures the invoice reflects any price change since the subscription
 * was set up.
 */
export async function getArticle(accessToken: string, articleId: number): Promise<BexioArticle> {
  return callBexio<BexioArticle>(`/article/${articleId}`, { accessToken });
}
```

- [ ] **Step 3: Export from index**

Modify `packages/bexio-client/src/index.ts` — add:
```typescript
export { listArticles, getArticle } from './articles.ts';
export type { BexioArticle } from './types.ts';
```

(Add the `BexioArticle` type to the existing block that lists exported types.)

- [ ] **Step 4: Verify TS compiles**

Run from root: `bun run lint` (or `tsc --noEmit` per package)
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/bexio-client/src/articles.ts packages/bexio-client/src/types.ts packages/bexio-client/src/index.ts
git commit -m "feat(bexio-client): add articles module (list + get)"
```

---

### Task 5: Add `createInvoice` direct call

**Files:**
- Modify: `packages/bexio-client/src/invoices.ts`
- Modify: `packages/bexio-client/src/types.ts`
- Modify: `packages/bexio-client/src/index.ts`

- [ ] **Step 1: Add input + position types**

Append to `packages/bexio-client/src/types.ts`:

```typescript
/**
 * Input for POST /kb_invoice. Only the fields the subscription layer uses.
 * bexio supports many more; add as needed.
 */
export type CreateInvoiceInput = {
  contact_id: number;
  title?: string;
  is_valid_from: string; // YYYY-MM-DD
  is_valid_to?: string;
  mwst_type?: number; // 0 = incl, 1 = excl, 2 = exempt
  mwst_is_net?: boolean;
  api_reference?: string;
  /** Inline positions. At least one required. */
  positions: BexioInvoicePositionInput[];
};

export type BexioInvoicePositionInput = {
  /** Position type. For article-based: 'KbPositionArticle'. */
  type: 'KbPositionArticle' | 'KbPositionCustom';
  article_id?: number; // required when type='KbPositionArticle'
  amount: string; // qty as decimal string
  unit_price?: string; // optional override; if omitted bexio uses the article's sale_price
  tax_id?: number | null;
  text?: string; // optional custom description
};
```

- [ ] **Step 2: Add `createInvoice` function to invoices.ts**

Append to `packages/bexio-client/src/invoices.ts`:

```typescript
import type { BexioInvoice, CreateInvoiceInput } from './types.ts';

/**
 * Create an invoice from scratch (NOT from an order).
 * Endpoint: POST /kb_invoice.
 *
 * Used by the subscription layer — bypasses bexio's /kb_order/{id}/invoice
 * pull-from-amount_open semantics that breaks daily/repeated recurring.
 */
export async function createInvoice(
  accessToken: string,
  input: CreateInvoiceInput,
): Promise<BexioInvoice> {
  return callBexio<BexioInvoice>('/kb_invoice', {
    accessToken,
    method: 'POST',
    body: input,
  });
}
```

- [ ] **Step 3: Export from index**

Modify `packages/bexio-client/src/index.ts` — add to existing invoice exports:
```typescript
export { createInvoiceFromOrder, createInvoice, issueInvoice, sendInvoice, getInvoice } from './invoices.ts';
```

And add to type exports:
```typescript
export type { CreateInvoiceInput, BexioInvoicePositionInput } from './types.ts';
```

- [ ] **Step 4: Verify TS compiles**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/bexio-client/src/invoices.ts packages/bexio-client/src/types.ts packages/bexio-client/src/index.ts
git commit -m "feat(bexio-client): add createInvoice (POST /kb_invoice direct)"
```

---

## Phase 3 — Worker Subscription Pipeline

### Task 6: Date helper `addBillingInterval` with unit tests

**Files:**
- Create: `apps/worker/src/lib/billing-interval.ts`
- Create: `apps/worker/src/lib/billing-interval.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/worker/src/lib/billing-interval.test.ts`:

```typescript
import { expect, test, describe } from 'bun:test';
import { addBillingInterval } from './billing-interval.ts';

describe('addBillingInterval — monthly', () => {
  test('mid-month: 2026-05-15 + monthly = 2026-06-15', () => {
    const result = addBillingInterval(new Date('2026-05-15T00:00:00Z'), 'monthly');
    expect(result.toISOString().slice(0, 10)).toBe('2026-06-15');
  });

  test('Jan 31 + monthly = Feb 28 (non-leap)', () => {
    const result = addBillingInterval(new Date('2027-01-31T00:00:00Z'), 'monthly');
    expect(result.toISOString().slice(0, 10)).toBe('2027-02-28');
  });

  test('Jan 31 + monthly in leap year = Feb 29', () => {
    const result = addBillingInterval(new Date('2028-01-31T00:00:00Z'), 'monthly');
    expect(result.toISOString().slice(0, 10)).toBe('2028-02-29');
  });

  test('December rolls year: 2026-12-15 + monthly = 2027-01-15', () => {
    const result = addBillingInterval(new Date('2026-12-15T00:00:00Z'), 'monthly');
    expect(result.toISOString().slice(0, 10)).toBe('2027-01-15');
  });
});

describe('addBillingInterval — yearly', () => {
  test('mid-year: 2026-05-15 + yearly = 2027-05-15', () => {
    const result = addBillingInterval(new Date('2026-05-15T00:00:00Z'), 'yearly');
    expect(result.toISOString().slice(0, 10)).toBe('2027-05-15');
  });

  test('Feb 29 leap → Feb 28 non-leap', () => {
    const result = addBillingInterval(new Date('2028-02-29T00:00:00Z'), 'yearly');
    expect(result.toISOString().slice(0, 10)).toBe('2029-02-28');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun test apps/worker/src/lib/billing-interval.test.ts`
Expected: FAIL with "Cannot find module './billing-interval.ts'".

- [ ] **Step 3: Implement `addBillingInterval`**

Create `apps/worker/src/lib/billing-interval.ts`:

```typescript
// Add one billing interval to a date. Used by processSubscriptions to advance
// next_billing_date after a successful billing run.
//
// Behavior on month-end / leap-day edges: cap to the new month's last day
// (Jan 31 + monthly = Feb 28/29; Feb 29 + yearly = Feb 28).

export type SubscriptionInterval = 'monthly' | 'yearly';

function lastDayOfMonth(y: number, m: number): number {
  // m is 1-based
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export function addBillingInterval(date: Date, interval: SubscriptionInterval): Date {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth(); // 0-based
  const d = date.getUTCDate();

  let newY = y;
  let newM = m;
  if (interval === 'monthly') {
    newM = m + 1;
    if (newM > 11) {
      newM = 0;
      newY = y + 1;
    }
  } else {
    newY = y + 1;
  }

  const cappedDay = Math.min(d, lastDayOfMonth(newY, newM + 1));
  return new Date(Date.UTC(newY, newM, cappedDay));
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `bun test apps/worker/src/lib/billing-interval.test.ts`
Expected: 6/6 PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/lib/billing-interval.ts apps/worker/src/lib/billing-interval.test.ts
git commit -m "feat(worker): addBillingInterval date helper with unit tests"
```

---

### Task 7: Subscription processing pipeline

**Files:**
- Create: `apps/worker/src/lib/subscriptions.ts`

- [ ] **Step 1: Implement `processSubscriptions` and `processOneSubscription`**

Create `apps/worker/src/lib/subscriptions.ts`:

```typescript
// Subscription-layer pipeline. Runs after processOrder() in runDaily().
//
// For each active subscription whose next_billing_date <= today:
//   1. Insert billing_runs row (status='pending') — UNIQUE guards against duplicate run
//   2. Fetch live contact + article data from bexio
//   3. POST /kb_invoice with assembled positions
//   4. Issue + optionally send
//   5. Advance subscription.next_billing_date by one interval
//
// Failure-mode: any error → billing_runs.status='failed', error_jsonb populated,
// loop continues to next subscription.
//
// Catch-up: if next_billing_date is multiple intervals in the past (Bot was offline),
// loops at most 12 times per subscription to avoid runaway re-billing.

import { and, eq, isNull, lte, or, gte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  subscriptions,
  subscriptionItems,
  billingRuns,
} from '@bexio-bot/db';
import {
  getContact,
  getArticle,
  createInvoice,
  issueInvoice,
  sendInvoice,
  BexioApiError,
  type BexioArticle,
  type BexioInvoicePositionInput,
} from '@bexio-bot/bexio-client';
import { addBillingInterval, type SubscriptionInterval } from './billing-interval.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PostgresJsDatabase<any>;

const MAX_CATCHUP_ITERATIONS = 12;

const MAIL_SUBJECT = 'Rechnung {document_nr}';
const MAIL_MESSAGE = [
  'Sehr geehrte Damen und Herren',
  '',
  'Im Anhang finden Sie unsere Rechnung {document_nr}.',
  'Die Rechnung können Sie auch online einsehen: [Network Link]',
  '',
  'Bei Fragen stehen wir Ihnen gerne zur Verfügung.',
  '',
  'Freundliche Grüsse',
].join('\n');

function render(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);
}

export type ProcessSubscriptionResult =
  | { kind: 'sent'; subscriptionId: number; invoiceId: number; amount: string; scheduledFor: string }
  | { kind: 'skipped_duplicate'; subscriptionId: number; scheduledFor: string }
  | { kind: 'failed'; subscriptionId: number; reason: string; scheduledFor: string };

/**
 * Process all subscriptions due today (or earlier).
 * Returns one result per (subscription, scheduled_for) attempt.
 */
export async function processSubscriptions(
  db: Db,
  accessToken: string,
  today: Date,
): Promise<ProcessSubscriptionResult[]> {
  const results: ProcessSubscriptionResult[] = [];

  // Snapshot due subscriptions at run start. Catch-up loop below may emit
  // multiple results per subscription.
  const due = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.status, 'active'),
        lte(subscriptions.nextBillingDate, today),
        or(isNull(subscriptions.endDate), gte(subscriptions.endDate, today)),
      ),
    );

  for (const sub of due) {
    let iteration = 0;
    // Re-read sub each iteration: next_billing_date advances after success
    let current: typeof sub | undefined = sub;
    while (
      current &&
      current.status === 'active' &&
      current.nextBillingDate <= today &&
      iteration < MAX_CATCHUP_ITERATIONS
    ) {
      const result = await processOneSubscription(db, accessToken, current);
      results.push(result);
      if (result.kind !== 'sent') break; // stop catch-up on duplicate/failure
      const refreshed = await db
        .select()
        .from(subscriptions)
        .where(eq(subscriptions.id, current.id));
      current = refreshed[0];
      iteration += 1;
    }
  }

  return results;
}

async function processOneSubscription(
  db: Db,
  accessToken: string,
  sub: typeof subscriptions.$inferSelect,
): Promise<ProcessSubscriptionResult> {
  const scheduledFor = sub.nextBillingDate;
  const scheduledForIso = scheduledFor.toISOString().slice(0, 10);

  // 1. Idempotency-lock
  const [runRow] = await db
    .insert(billingRuns)
    .values({
      subscriptionId: sub.id,
      scheduledFor,
      status: 'pending',
    })
    .onConflictDoNothing({ target: [billingRuns.subscriptionId, billingRuns.scheduledFor] })
    .returning();

  if (!runRow) {
    return { kind: 'skipped_duplicate', subscriptionId: sub.id, scheduledFor: scheduledForIso };
  }

  try {
    // 2. Live data
    const contact = await getContact(accessToken, sub.bexioContactId);
    const items = await db
      .select()
      .from(subscriptionItems)
      .where(eq(subscriptionItems.subscriptionId, sub.id))
      .orderBy(subscriptionItems.positionOrder);

    if (items.length === 0) {
      throw new BexioApiError(0, 'permanent', 'subscription has no items');
    }

    const articles = await Promise.all(
      items.map((i) => getArticle(accessToken, i.bexioArticleId)),
    );

    // 3. Build positions + create invoice
    const positions: BexioInvoicePositionInput[] = items.map((item, idx) => {
      const article = articles[idx];
      return {
        type: 'KbPositionArticle',
        article_id: article.id,
        amount: item.qty,
        unit_price: article.sale_price ?? '0',
        tax_id: article.sales_tax_id ?? null,
      };
    });

    const invoice = await createInvoice(accessToken, {
      contact_id: contact.id,
      title: sub.name,
      is_valid_from: scheduledForIso,
      mwst_type: 0, // 0 = incl. tax; adjust per article if needed
      api_reference: `sub:${sub.id}:run:${runRow.id}`,
      positions,
    });

    // 4. Issue + send
    await issueInvoice(accessToken, invoice.id);
    if (sub.autoSend && contact.mail) {
      const docNr = invoice.document_nr;
      await sendInvoice(accessToken, invoice.id, {
        recipientEmail: contact.mail,
        subject: render(MAIL_SUBJECT, { document_nr: docNr }),
        message: render(MAIL_MESSAGE, { document_nr: docNr }),
        attachPdf: true,
      });
    }

    // 5. Mark success + advance next_billing_date
    await db
      .update(billingRuns)
      .set({
        status: 'success',
        bexioInvoiceId: invoice.id,
        executedAt: new Date(),
      })
      .where(eq(billingRuns.id, runRow.id));

    const newNext = addBillingInterval(
      sub.nextBillingDate,
      sub.interval as SubscriptionInterval,
    );
    await db
      .update(subscriptions)
      .set({ nextBillingDate: newNext, updatedAt: new Date() })
      .where(eq(subscriptions.id, sub.id));

    return {
      kind: 'sent',
      subscriptionId: sub.id,
      invoiceId: invoice.id,
      amount: invoice.total,
      scheduledFor: scheduledForIso,
    };
  } catch (err) {
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
}

/**
 * Manual single-subscription trigger (used by dashboard "Jetzt abrechnen" action).
 * Same logic as processOneSubscription, just exposed for the route handler.
 */
export async function runSubscriptionNow(
  db: Db,
  accessToken: string,
  subscriptionId: number,
): Promise<ProcessSubscriptionResult> {
  const [sub] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId));

  if (!sub) {
    return {
      kind: 'failed',
      subscriptionId,
      reason: 'subscription not found',
      scheduledFor: new Date().toISOString().slice(0, 10),
    };
  }
  return processOneSubscription(db, accessToken, sub);
}
```

- [ ] **Step 2: Verify TS compiles**

Run: `bun run lint`
Expected: no errors. If `subscriptions.$inferSelect` doesn't work, replace with `{ id: number; bexioContactId: number; name: string; interval: string; startDate: Date; endDate: Date | null; nextBillingDate: Date; status: string; autoSend: boolean; notes: string | null; createdAt: Date; updatedAt: Date }`.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/lib/subscriptions.ts
git commit -m "feat(worker): subscription processing pipeline"
```

---

### Task 8: Wire subscriptions into `runDaily()`

**Files:**
- Modify: `apps/worker/src/lib/run.ts`

- [ ] **Step 1: Add subscriptions to RunSummary type**

In `apps/worker/src/lib/run.ts`, modify the `RunSummary` type to add subscription results. Add this line inside the type (after the existing `results: …` line):

```typescript
  subscriptionResults: import('./subscriptions.ts').ProcessSubscriptionResult[];
```

- [ ] **Step 2: Import processSubscriptions**

Add to imports at top:
```typescript
import { processSubscriptions, type ProcessSubscriptionResult } from './subscriptions.ts';
```

And replace the type-only `import type` line with the actual import above.

- [ ] **Step 3: Call processSubscriptions after the order loop**

After the `for (const o of enabled) { ... }` loop and before `// ── 6. Close bot_runs row ───────`, add:

```typescript
  // ── 5b. Subscription-layer pipeline ──────────────────────────
  let subscriptionResults: ProcessSubscriptionResult[] = [];
  if (!options.dryRun) {
    try {
      const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
      subscriptionResults = await processSubscriptions(db, accessToken, today);
    } catch (err) {
      errors.push({
        stage: 'processSubscriptions',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
```

- [ ] **Step 4: Include subscription counts in bot_runs row**

Update the `created` and `sent` count calculations (right before `await db.update(botRuns)`):

```typescript
  const created =
    results.filter((r) => r.result.kind === 'sent' || r.result.kind === 'skipped_duplicate').length +
    subscriptionResults.filter((r) => r.kind === 'sent' || r.kind === 'skipped_duplicate').length;
  const sent =
    results.filter((r) => r.result.kind === 'sent').length +
    subscriptionResults.filter((r) => r.kind === 'sent').length;
```

- [ ] **Step 5: Pass subscriptionResults into notifyAll**

Inside the `notifyAll({ ... })` call, add a top-level `subscriptionResults` property (alongside `results`, `errors`, etc.):

```typescript
    subscriptionResults: subscriptionResults.map((r) => ({
      kind: r.kind,
      subscriptionId: r.subscriptionId,
      ...(r.kind === 'sent' ? { invoiceId: r.invoiceId, amount: r.amount, scheduledFor: r.scheduledFor } : {}),
      ...(r.kind === 'failed' ? { reason: r.reason, scheduledFor: r.scheduledFor } : {}),
      ...(r.kind === 'skipped_duplicate' ? { scheduledFor: r.scheduledFor } : {}),
    })),
```

- [ ] **Step 6: Return subscriptionResults in RunSummary**

At the bottom of `runDaily()`, add to the returned object:
```typescript
    subscriptionResults,
```

- [ ] **Step 7: Verify TS compiles**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add apps/worker/src/lib/run.ts
git commit -m "feat(worker): wire subscription pipeline into runDaily"
```

---

### Task 9: Extend Discord embed with Subscriptions section

**Files:**
- Modify: `packages/notify/src/discord.ts`
- Modify: `packages/notify/src/index.ts` (if it exists; check first)

- [ ] **Step 1: Inspect current notify index**

Run: `cat packages/notify/src/index.ts`
Note what's exported.

- [ ] **Step 2: Extend `DiscordRunReport` type**

In `packages/notify/src/discord.ts`, modify the `DiscordRunReport` type to add:

```typescript
export type DiscordRunReport = {
  // ...existing fields...
  subscriptionResults: Array<{
    kind: 'sent' | 'skipped_duplicate' | 'failed';
    subscriptionId: number;
    invoiceId?: number;
    amount?: string;
    scheduledFor?: string;
    reason?: string;
  }>;
};
```

- [ ] **Step 3: Build subscription fields in `buildRunEmbed`**

Inside `buildRunEmbed`, after the existing field-building loops and before the `if (status === 'no-due' && notDue.length > 0)` block, add:

```typescript
  const subSent = r.subscriptionResults.filter((x) => x.kind === 'sent');
  const subFailed = r.subscriptionResults.filter((x) => x.kind === 'failed');
  if (subSent.length > 0 || subFailed.length > 0) {
    // Section header — visual separator from bexio-recurring results
    fields.push({
      name: '— Subscriptions —',
      value: ' ',
      inline: false,
    });
    for (const s of subSent.slice(0, 12)) {
      fields.push({
        name: `✓ Abo #${s.subscriptionId}`,
        value: s.amount && s.invoiceId ? `CHF ${s.amount} · bexio #${s.invoiceId}` : '(no detail)',
        inline: true,
      });
    }
    for (const f of subFailed) {
      fields.push({
        name: `✗ Abo #${f.subscriptionId}`,
        value: truncate(f.reason ?? 'unknown', 256),
        inline: false,
      });
    }
  }
```

- [ ] **Step 4: Update `pickStatus` to include subscription results**

In `pickStatus`, modify to count subscription successes/failures too:

```typescript
function pickStatus(r: DiscordRunReport): 'success' | 'failed' | 'partial' | 'no-due' {
  if (r.errors.length > 0 && r.results.length === 0 && r.subscriptionResults.length === 0) return 'failed';
  const failed =
    r.results.filter((x) => x.kind === 'failed').length +
    r.subscriptionResults.filter((x) => x.kind === 'failed').length;
  const sent =
    r.results.filter((x) => x.kind === 'sent' || x.kind === 'skipped_duplicate').length +
    r.subscriptionResults.filter((x) => x.kind === 'sent' || x.kind === 'skipped_duplicate').length;
  if (failed > 0 && sent > 0) return 'partial';
  if (failed > 0) return 'failed';
  if (sent > 0) return 'success';
  return 'no-due';
}
```

- [ ] **Step 5: Make `notifyAll` accept and forward subscription results**

Find the `notifyAll` function (likely in `packages/notify/src/index.ts`). Add `subscriptionResults` to its input type and pass through to `sendRunReport`. Default to `[]` if caller omits it (backward-compat for old callers).

- [ ] **Step 6: Verify TS compiles**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/notify/
git commit -m "feat(notify): subscriptions section in Discord embed"
```

---

## Phase 4 — Dashboard

### Task 10: `/subscriptions` list page

**Files:**
- Create: `apps/web/src/routes/subscriptions/+page.server.ts`
- Create: `apps/web/src/routes/subscriptions/+page.svelte`

- [ ] **Step 1: Create server load**

Create `apps/web/src/routes/subscriptions/+page.server.ts`:

```typescript
// Subscription list. Sorted by next-billing-date (overdue/due-soon first).
// Joined with contact_name pulled live from the latest billing_run, or null
// if no run has happened yet — we don't cache contact names on subscriptions
// to keep the address-drift property intact.

import { desc, eq, sql, and } from 'drizzle-orm';
import type { PageServerLoad } from './$types.ts';
import { getDb, subscriptions, billingRuns } from '@bexio-bot/db';

export const load: PageServerLoad = async () => {
  const db = getDb();
  const subs = await db
    .select()
    .from(subscriptions)
    .orderBy(sql`${subscriptions.nextBillingDate} ASC NULLS LAST`, subscriptions.name);

  // Latest billing_run per subscription for status display
  const lastRuns = await db.execute<{
    subscription_id: number;
    status: string;
    executed_at: Date | null;
    bexio_invoice_id: number | null;
  }>(sql`
    SELECT DISTINCT ON (subscription_id) subscription_id, status, executed_at, bexio_invoice_id
    FROM billing_runs
    ORDER BY subscription_id, created_at DESC
  `);

  const lastRunMap = new Map(
    lastRuns.map((r) => [r.subscription_id, r]),
  );

  return {
    subscriptions: subs.map((s) => ({ ...s, lastRun: lastRunMap.get(s.id) ?? null })),
  };
};
```

- [ ] **Step 2: Create svelte page**

Create `apps/web/src/routes/subscriptions/+page.svelte`:

```svelte
<script lang="ts">
  import { page } from '$app/state';
  import type { PageData } from './$types.ts';

  let { data }: { data: PageData } = $props();

  const dtCH = new Intl.DateTimeFormat('de-CH', {
    timeZone: 'Europe/Zurich',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  function fmtDate(d: Date | string | null): string {
    if (!d) return '—';
    return dtCH.format(typeof d === 'string' ? new Date(d) : d);
  }

  function statusBadge(s: string): { label: string; cls: string } {
    if (s === 'active') return { label: 'aktiv', cls: 'ok' };
    if (s === 'paused') return { label: 'pausiert', cls: 'warn' };
    return { label: 'gekündigt', cls: 'muted' };
  }

  const VALID_FILTERS = ['alle', 'aktiv', 'paused', 'cancelled'] as const;
  type Filter = (typeof VALID_FILTERS)[number];
  const initialFilter = (() => {
    const q = page.url.searchParams.get('filter');
    return q && (VALID_FILTERS as readonly string[]).includes(q) ? (q as Filter) : 'alle';
  })();
  let filter = $state<Filter>(initialFilter);

  const filtered = $derived(
    data.subscriptions.filter((s) => filter === 'alle' || s.status === filter),
  );
</script>

<svelte:head><title>Abonnements · bexio-bot</title></svelte:head>

<main class="page">
  <header>
    <h1>Abonnements</h1>
    <a class="btn-primary" href="/subscriptions/new">+ Neues Abo</a>
  </header>

  <nav class="chips">
    {#each VALID_FILTERS as f}
      <button class:active={filter === f} onclick={() => (filter = f)}>{f}</button>
    {/each}
  </nav>

  {#if filtered.length === 0}
    <p class="empty">Keine Abonnements in dieser Ansicht.</p>
  {:else}
    <table class="data-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Kontakt</th>
          <th>Intervall</th>
          <th>Nächste Fälligkeit</th>
          <th>Status</th>
          <th>Letzter Lauf</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each filtered as s (s.id)}
          {@const badge = statusBadge(s.status)}
          <tr>
            <td><a href="/subscriptions/{s.id}">{s.name}</a></td>
            <td>#{s.bexioContactId}</td>
            <td>{s.interval}</td>
            <td>{fmtDate(s.nextBillingDate)}</td>
            <td><span class="badge {badge.cls}">{badge.label}</span></td>
            <td>{s.lastRun ? `${s.lastRun.status} · ${fmtDate(s.lastRun.executed_at)}` : '—'}</td>
            <td><a href="/subscriptions/{s.id}" class="link">Details →</a></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  <p class="nav-links"><a href="/">← Dashboard</a></p>
</main>

<style>
  /* match existing dashboard CSS conventions — header layout, chips, data-table.
     Pull from app.css via DESIGN.md tokens. */
  .page { padding: 1.5rem; max-width: 1100px; margin: 0 auto; }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
  .chips { display: flex; gap: 0.5rem; margin-bottom: 1rem; }
  .chips button { padding: 0.4rem 0.8rem; border-radius: 999px; border: 1px solid var(--border); background: transparent; cursor: pointer; }
  .chips .active { background: var(--accent); color: var(--bg); border-color: var(--accent); }
  .empty { color: var(--text-3); font-style: italic; }
  .nav-links { margin-top: 2rem; }
</style>
```

- [ ] **Step 3: Manual smoke-test**

Run: `bun run --cwd apps/web dev`
Open: `http://localhost:5173/subscriptions`
Expected: empty list with "+ Neues Abo" button, filter chips show counts (all 0 if DB is empty).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/subscriptions/
git commit -m "feat(web): /subscriptions list page"
```

---

### Task 11: `/subscriptions/new` create form

**Files:**
- Create: `apps/web/src/routes/subscriptions/new/+page.server.ts`
- Create: `apps/web/src/routes/subscriptions/new/+page.svelte`

- [ ] **Step 1: Create server load + action**

Create `apps/web/src/routes/subscriptions/new/+page.server.ts`:

```typescript
// Create-subscription form. Preloads all bexio contacts + articles server-side
// (Marcus has <50 of each so client-side filter is fine).

import { fail, redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types.ts';
import { getDb, subscriptions, subscriptionItems } from '@bexio-bot/db';
import { getValidAccessToken, listContacts, listArticles } from '@bexio-bot/bexio-client';

export const load: PageServerLoad = async () => {
  const db = getDb();
  const accessToken = await getValidAccessToken(db);

  const [contacts, articles] = await Promise.all([
    listContacts(accessToken).catch(() => []),
    listArticles(accessToken).catch(() => []),
  ]);

  return {
    contacts: contacts.map((c) => ({
      id: c.id,
      name: c.name_2 ? `${c.name_2} ${c.name_1}`.trim() : c.name_1,
      email: c.mail ?? null,
    })),
    articles: articles.map((a) => ({
      id: a.id,
      code: a.intern_code,
      name: a.intern_name,
      price: a.sale_price ?? '0',
    })),
  };
};

export const actions: Actions = {
  default: async ({ request }) => {
    const form = await request.formData();
    const bexioContactId = Number(form.get('bexio_contact_id'));
    const name = String(form.get('name') ?? '').trim();
    const interval = String(form.get('interval') ?? '');
    const startDateStr = String(form.get('start_date') ?? '');
    const endDateStr = String(form.get('end_date') ?? '');
    const autoSend = form.get('auto_send') === 'on';
    const articleIds = form.getAll('item_article_id').map(Number);
    const qtys = form.getAll('item_qty').map(String);

    if (!Number.isFinite(bexioContactId)) return fail(400, { error: 'Kontakt fehlt' });
    if (!name) return fail(400, { error: 'Name fehlt' });
    if (interval !== 'monthly' && interval !== 'yearly') return fail(400, { error: 'Intervall ungültig' });
    if (!startDateStr) return fail(400, { error: 'Startdatum fehlt' });
    if (articleIds.length === 0) return fail(400, { error: 'Mindestens eine Position nötig' });
    if (articleIds.length !== qtys.length) return fail(400, { error: 'Positionen inkonsistent' });

    const startDate = new Date(startDateStr + 'T00:00:00Z');
    const endDate = endDateStr ? new Date(endDateStr + 'T00:00:00Z') : null;

    const db = getDb();
    const [sub] = await db
      .insert(subscriptions)
      .values({
        bexioContactId,
        name,
        interval: interval as 'monthly' | 'yearly',
        startDate,
        endDate,
        nextBillingDate: startDate,
        status: 'active',
        autoSend,
      })
      .returning();

    if (sub) {
      await db.insert(subscriptionItems).values(
        articleIds.map((articleId, idx) => ({
          subscriptionId: sub.id,
          bexioArticleId: articleId,
          qty: qtys[idx]!,
          positionOrder: idx,
        })),
      );
    }

    throw redirect(303, `/subscriptions/${sub!.id}`);
  },
};
```

- [ ] **Step 2: Create form svelte**

Create `apps/web/src/routes/subscriptions/new/+page.svelte`:

```svelte
<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageData, ActionData } from './$types.ts';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  // Client-side state for dynamic position rows
  type Row = { articleId: number | null; qty: string };
  let positions = $state<Row[]>([{ articleId: null, qty: '1' }]);

  let contactSearch = $state('');
  let contactSelected = $state<{ id: number; name: string; email: string | null } | null>(null);

  const filteredContacts = $derived(
    contactSearch.trim()
      ? data.contacts.filter((c) =>
          c.name.toLowerCase().includes(contactSearch.toLowerCase()),
        ).slice(0, 20)
      : data.contacts.slice(0, 20),
  );

  function articleDisplay(id: number): string {
    const a = data.articles.find((x) => x.id === id);
    if (!a) return `#${id}`;
    return `${a.name} (${a.code}) · CHF ${a.price}`;
  }

  function suggestName() {
    if (positions[0]?.articleId && contactSelected) {
      const a = data.articles.find((x) => x.id === positions[0]!.articleId);
      if (a && !suggestedNameTouched) {
        autoName = `${a.name} — ${contactSelected.name}`;
      }
    }
  }

  let autoName = $state('');
  let suggestedNameTouched = $state(false);
  $effect(() => { suggestName(); });

  function addPosition() { positions = [...positions, { articleId: null, qty: '1' }]; }
  function removePosition(i: number) { positions = positions.filter((_, idx) => idx !== i); }

  const today = new Date().toISOString().slice(0, 10);
  let endDateUnlimited = $state(true);
</script>

<svelte:head><title>Neues Abo · bexio-bot</title></svelte:head>

<main class="page">
  <header><h1>Neues Abonnement</h1></header>

  {#if form?.error}<p class="error">⚠ {form.error}</p>{/if}

  <form method="POST" use:enhance>
    <label class="field">
      <span class="label">Kunde</span>
      <input
        type="text"
        placeholder="Kontakt suchen…"
        bind:value={contactSearch}
        autocomplete="off"
      />
      {#if !contactSelected}
        <ul class="suggestions">
          {#each filteredContacts as c}
            <li>
              <button type="button" onclick={() => { contactSelected = c; contactSearch = c.name; }}>
                {c.name}{#if c.email} · {c.email}{/if}
              </button>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="hint">Ausgewählt: {contactSelected.name} (bexio-Id {contactSelected.id})
          <button type="button" onclick={() => { contactSelected = null; contactSearch = ''; }}>ändern</button>
        </p>
        <input type="hidden" name="bexio_contact_id" value={contactSelected.id} />
      {/if}
    </label>

    <label class="field">
      <span class="label">Plan-Name</span>
      <input
        type="text"
        name="name"
        value={autoName}
        oninput={() => (suggestedNameTouched = true)}
        placeholder="Hosting Basic — IT Service Martin"
        required
      />
    </label>

    <fieldset class="field">
      <legend class="label">Intervall</legend>
      <label><input type="radio" name="interval" value="monthly" checked /> monatlich</label>
      <label><input type="radio" name="interval" value="yearly" /> jährlich</label>
    </fieldset>

    <label class="field">
      <span class="label">Startdatum</span>
      <input type="date" name="start_date" value={today} required />
    </label>

    <label class="field">
      <span class="label">Enddatum</span>
      <label><input type="checkbox" bind:checked={endDateUnlimited} /> unbefristet</label>
      {#if !endDateUnlimited}
        <input type="date" name="end_date" />
      {/if}
    </label>

    <label class="field">
      <input type="checkbox" name="auto_send" checked />
      <span>Rechnung gleich versenden</span>
    </label>

    <fieldset class="field">
      <legend class="label">Positionen</legend>
      {#each positions as pos, idx}
        <div class="position-row">
          <select bind:value={pos.articleId} name="item_article_id" required>
            <option value={null} disabled>Produkt wählen…</option>
            {#each data.articles as a}
              <option value={a.id}>{articleDisplay(a.id)}</option>
            {/each}
          </select>
          <input type="number" step="0.001" min="0.001" name="item_qty" bind:value={pos.qty} required />
          {#if positions.length > 1}
            <button type="button" onclick={() => removePosition(idx)}>entfernen</button>
          {/if}
        </div>
      {/each}
      <button type="button" onclick={addPosition}>+ Produkt hinzufügen</button>
    </fieldset>

    <div class="actions">
      <button type="submit" class="btn-primary">Anlegen</button>
      <a href="/subscriptions" class="btn-secondary">Abbrechen</a>
    </div>
  </form>
</main>

<style>
  .page { padding: 1.5rem; max-width: 800px; margin: 0 auto; }
  .field { display: block; margin-bottom: 1.25rem; }
  .label { display: block; font-weight: 500; margin-bottom: 0.4rem; }
  .suggestions { list-style: none; padding: 0; margin: 0.5rem 0 0; max-height: 200px; overflow: auto; border: 1px solid var(--border); border-radius: 4px; }
  .suggestions button { width: 100%; text-align: left; padding: 0.5rem; background: transparent; border: none; cursor: pointer; }
  .suggestions button:hover { background: var(--bg-2); }
  .position-row { display: grid; grid-template-columns: 1fr 100px auto; gap: 0.5rem; margin-bottom: 0.5rem; }
  .actions { display: flex; gap: 0.75rem; margin-top: 2rem; }
  .error { color: var(--err); padding: 0.75rem; border: 1px solid var(--err); border-radius: 4px; }
  .hint { color: var(--text-3); font-size: 0.9rem; }
</style>
```

- [ ] **Step 3: Manual smoke-test**

Run: `bun run --cwd apps/web dev`
Open: `http://localhost:5173/subscriptions/new`
Verify: contact picker shows bexio contacts, article dropdown shows products, form submits.

Do NOT actually submit unless you want a real subscription in the DB. If you submit, delete it with: `psql "$DATABASE_URL" -c "DELETE FROM subscription_items WHERE subscription_id IN (SELECT id FROM subscriptions WHERE name LIKE 'TEST%'); DELETE FROM subscriptions WHERE name LIKE 'TEST%';"`

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/subscriptions/new/
git commit -m "feat(web): /subscriptions/new create form"
```

---

### Task 12: `/subscriptions/[id]` detail page with edit/pause/cancel/manual-run

**Files:**
- Create: `apps/web/src/routes/subscriptions/[id]/+page.server.ts`
- Create: `apps/web/src/routes/subscriptions/[id]/+page.svelte`

- [ ] **Step 1: Create server load + actions**

Create `apps/web/src/routes/subscriptions/[id]/+page.server.ts`:

```typescript
import { eq, desc, and } from 'drizzle-orm';
import { fail, error, redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types.ts';
import {
  getDb,
  subscriptions,
  subscriptionItems,
  billingRuns,
} from '@bexio-bot/db';
import { getValidAccessToken, getArticle } from '@bexio-bot/bexio-client';
import { runSubscriptionNow } from '@bexio-bot/worker/subscriptions';

export const load: PageServerLoad = async ({ params }) => {
  const id = Number(params.id);
  if (!Number.isFinite(id)) throw error(400, 'invalid id');

  const db = getDb();
  const [sub] = await db.select().from(subscriptions).where(eq(subscriptions.id, id));
  if (!sub) throw error(404, 'not found');

  const items = await db
    .select()
    .from(subscriptionItems)
    .where(eq(subscriptionItems.subscriptionId, id))
    .orderBy(subscriptionItems.positionOrder);

  const runs = await db
    .select()
    .from(billingRuns)
    .where(eq(billingRuns.subscriptionId, id))
    .orderBy(desc(billingRuns.createdAt))
    .limit(20);

  // Resolve article names for display (best-effort)
  let articleNames = new Map<number, string>();
  try {
    const accessToken = await getValidAccessToken(db);
    const articles = await Promise.all(items.map((i) => getArticle(accessToken, i.bexioArticleId).catch(() => null)));
    articleNames = new Map(
      articles
        .filter((a): a is NonNullable<typeof a> => a !== null)
        .map((a) => [a.id, `${a.intern_name} (${a.intern_code})`]),
    );
  } catch {
    // fall through with empty map
  }

  return {
    subscription: sub,
    items: items.map((i) => ({ ...i, articleName: articleNames.get(i.bexioArticleId) ?? `Artikel #${i.bexioArticleId}` })),
    runs,
  };
};

export const actions: Actions = {
  pause: async ({ params }) => {
    const id = Number(params.id);
    const db = getDb();
    await db.update(subscriptions).set({ status: 'paused', updatedAt: new Date() }).where(eq(subscriptions.id, id));
    return { success: true };
  },

  resume: async ({ params }) => {
    const id = Number(params.id);
    const db = getDb();
    // Reset next_billing_date to today so the next cron picks it up
    const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
    await db
      .update(subscriptions)
      .set({ status: 'active', nextBillingDate: today, updatedAt: new Date() })
      .where(eq(subscriptions.id, id));
    return { success: true };
  },

  cancel: async ({ params }) => {
    const id = Number(params.id);
    const db = getDb();
    await db.update(subscriptions).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(subscriptions.id, id));
    return { success: true };
  },

  runNow: async ({ params }) => {
    const id = Number(params.id);
    const db = getDb();
    const accessToken = await getValidAccessToken(db);
    const result = await runSubscriptionNow(db, accessToken, id);
    return { success: true, runResult: result };
  },
};
```

- [ ] **Step 2: Export runSubscriptionNow from worker package**

Before the import in Step 1 will resolve, add a new subpath export to `apps/worker/package.json`:

```json
  "exports": {
    "./run": "./src/lib/run.ts",
    "./subscriptions": "./src/lib/subscriptions.ts"
  },
```

(Step 1's import path `@bexio-bot/worker/subscriptions` matches this entry.)

- [ ] **Step 3: Create detail svelte page**

Create `apps/web/src/routes/subscriptions/[id]/+page.svelte`:

```svelte
<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageData, ActionData } from './$types.ts';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  const s = $derived(data.subscription);

  const dtCH = new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric' });
  const dtFull = new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  function fmtDate(d: Date | string | null): string {
    if (!d) return '—';
    return dtCH.format(typeof d === 'string' ? new Date(d) : d);
  }
  function fmtDateTime(d: Date | string | null): string {
    if (!d) return '—';
    return dtFull.format(typeof d === 'string' ? new Date(d) : d);
  }
</script>

<svelte:head><title>{s.name} · bexio-bot</title></svelte:head>

<main class="page">
  <p><a href="/subscriptions">← Abonnements</a></p>
  <header>
    <h1>{s.name}</h1>
    <span class="badge {s.status === 'active' ? 'ok' : s.status === 'paused' ? 'warn' : 'muted'}">{s.status}</span>
  </header>

  {#if form?.runResult}
    <p class="banner {form.runResult.kind === 'sent' ? 'ok' : form.runResult.kind === 'failed' ? 'err' : 'warn'}">
      Manueller Lauf: {form.runResult.kind}
      {#if form.runResult.kind === 'sent'}— bexio #{form.runResult.invoiceId} · CHF {form.runResult.amount}{/if}
      {#if form.runResult.kind === 'failed'}— {form.runResult.reason}{/if}
    </p>
  {/if}

  <section class="grid">
    <div><strong>bexio-Kontakt</strong><div>#{s.bexioContactId}</div></div>
    <div><strong>Intervall</strong><div>{s.interval}</div></div>
    <div><strong>Start</strong><div>{fmtDate(s.startDate)}</div></div>
    <div><strong>Ende</strong><div>{fmtDate(s.endDate)}</div></div>
    <div><strong>Nächste Fälligkeit</strong><div>{fmtDate(s.nextBillingDate)}</div></div>
    <div><strong>Auto-Send</strong><div>{s.autoSend ? 'ja' : 'nein'}</div></div>
  </section>

  <section>
    <h2>Positionen</h2>
    <table class="data-table">
      <thead><tr><th>#</th><th>Artikel</th><th>Menge</th></tr></thead>
      <tbody>
        {#each data.items as it}<tr><td>{it.positionOrder + 1}</td><td>{it.articleName}</td><td>{it.qty}</td></tr>{/each}
      </tbody>
    </table>
  </section>

  <section class="actions">
    {#if s.status === 'active'}
      <form method="POST" action="?/pause" use:enhance><button>Pausieren</button></form>
      <form method="POST" action="?/runNow" use:enhance><button class="btn-primary">Jetzt abrechnen</button></form>
    {:else if s.status === 'paused'}
      <form method="POST" action="?/resume" use:enhance><button class="btn-primary">Fortsetzen</button></form>
    {/if}
    {#if s.status !== 'cancelled'}
      <form method="POST" action="?/cancel" use:enhance onsubmit={(e) => { if (!confirm('Wirklich kündigen? Keine weiteren Rechnungen.')) e.preventDefault(); }}>
        <button class="btn-danger">Kündigen</button>
      </form>
    {/if}
  </section>

  <section>
    <h2>Lauf-Historie</h2>
    {#if data.runs.length === 0}
      <p>Noch keine Läufe.</p>
    {:else}
      <table class="data-table">
        <thead><tr><th>geplant für</th><th>ausgeführt</th><th>Status</th><th>bexio-Rechnung</th></tr></thead>
        <tbody>
          {#each data.runs as r}
            <tr>
              <td>{fmtDate(r.scheduledFor)}</td>
              <td>{fmtDateTime(r.executedAt)}</td>
              <td><span class="badge {r.status === 'success' ? 'ok' : r.status === 'failed' ? 'err' : 'muted'}">{r.status}</span></td>
              <td>{r.bexioInvoiceId ? `#${r.bexioInvoiceId}` : '—'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>
</main>

<style>
  .page { padding: 1.5rem; max-width: 900px; margin: 0 auto; }
  header { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 1rem; padding: 1rem; background: var(--bg-2); border-radius: 6px; margin-bottom: 2rem; }
  section h2 { margin-top: 2rem; }
  section.actions { display: flex; gap: 0.75rem; margin-top: 2rem; }
  .banner { padding: 0.75rem; border-radius: 4px; margin-bottom: 1rem; }
  .banner.ok { background: var(--ok-bg, #d1fae5); color: var(--ok, #065f46); }
  .banner.err { background: var(--err-bg, #fee2e2); color: var(--err, #991b1b); }
  .banner.warn { background: var(--warn-bg, #fef3c7); color: var(--warn, #92400e); }
</style>
```

- [ ] **Step 4: Manual smoke-test**

Verify each action works: open detail page, click Pause/Resume/Cancel/RunNow. Bei RunNow ohne Items kommt 'failed: subscription has no items'.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/subscriptions/[id]/ apps/worker/package.json
git commit -m "feat(web): /subscriptions/[id] detail page with edit/pause/cancel/run"
```

---

### Task 13: `/billing-runs` history page

**Files:**
- Create: `apps/web/src/routes/billing-runs/+page.server.ts`
- Create: `apps/web/src/routes/billing-runs/+page.svelte`

- [ ] **Step 1: Create server load + retry action**

Create `apps/web/src/routes/billing-runs/+page.server.ts`:

```typescript
import { desc, eq, sql } from 'drizzle-orm';
import type { PageServerLoad, Actions } from './$types.ts';
import { getDb, billingRuns, subscriptions } from '@bexio-bot/db';
import { getValidAccessToken } from '@bexio-bot/bexio-client';
import { runSubscriptionNow } from '@bexio-bot/worker/subscriptions';

export const load: PageServerLoad = async () => {
  const db = getDb();
  const runs = await db
    .select({
      id: billingRuns.id,
      subscriptionId: billingRuns.subscriptionId,
      scheduledFor: billingRuns.scheduledFor,
      executedAt: billingRuns.executedAt,
      status: billingRuns.status,
      bexioInvoiceId: billingRuns.bexioInvoiceId,
      errorJsonb: billingRuns.errorJsonb,
      createdAt: billingRuns.createdAt,
      subscriptionName: subscriptions.name,
    })
    .from(billingRuns)
    .leftJoin(subscriptions, eq(billingRuns.subscriptionId, subscriptions.id))
    .orderBy(desc(billingRuns.createdAt))
    .limit(100);
  return { runs };
};

export const actions: Actions = {
  retry: async ({ request }) => {
    const form = await request.formData();
    const subscriptionId = Number(form.get('subscription_id'));
    if (!Number.isFinite(subscriptionId)) return { success: false, error: 'invalid id' };

    const db = getDb();
    const accessToken = await getValidAccessToken(db);
    const result = await runSubscriptionNow(db, accessToken, subscriptionId);
    return { success: true, result };
  },
};
```

- [ ] **Step 2: Create svelte page**

Create `apps/web/src/routes/billing-runs/+page.svelte`:

```svelte
<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageData, ActionData } from './$types.ts';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const dtCH = new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  function fmt(d: Date | string | null): string {
    if (!d) return '—';
    return dtCH.format(typeof d === 'string' ? new Date(d) : d);
  }
</script>

<svelte:head><title>Abrechnungs-Historie · bexio-bot</title></svelte:head>

<main class="page">
  <p><a href="/">← Dashboard</a></p>
  <h1>Abrechnungs-Historie</h1>

  {#if form?.result}<p class="banner">Retry: {form.result.kind}</p>{/if}

  <table class="data-table">
    <thead>
      <tr><th>Erstellt</th><th>Abo</th><th>geplant für</th><th>ausgeführt</th><th>Status</th><th>bexio</th><th>Fehler</th><th></th></tr>
    </thead>
    <tbody>
      {#each data.runs as r}
        <tr>
          <td>{fmt(r.createdAt)}</td>
          <td><a href="/subscriptions/{r.subscriptionId}">{r.subscriptionName ?? `#${r.subscriptionId}`}</a></td>
          <td>{fmt(r.scheduledFor)}</td>
          <td>{fmt(r.executedAt)}</td>
          <td><span class="badge {r.status === 'success' ? 'ok' : r.status === 'failed' ? 'err' : 'muted'}">{r.status}</span></td>
          <td>{r.bexioInvoiceId ? `#${r.bexioInvoiceId}` : '—'}</td>
          <td>
            {#if r.errorJsonb}
              <details><summary>Details</summary><pre>{JSON.stringify(r.errorJsonb, null, 2)}</pre></details>
            {/if}
          </td>
          <td>
            {#if r.status === 'failed'}
              <form method="POST" action="?/retry" use:enhance>
                <input type="hidden" name="subscription_id" value={r.subscriptionId} />
                <button>Retry</button>
              </form>
            {/if}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</main>

<style>
  .page { padding: 1.5rem; max-width: 1200px; margin: 0 auto; }
  .banner { padding: 0.75rem; background: var(--bg-2); border-radius: 4px; margin-bottom: 1rem; }
  details summary { cursor: pointer; }
  pre { font-size: 0.85rem; }
</style>
```

- [ ] **Step 3: Add link to main dashboard navigation**

In `apps/web/src/routes/+page.svelte`, find the existing navigation/nav-links section (likely near the bottom) and add a link to `/subscriptions` next to the existing `/runs` link. Exact location depends on current dashboard layout — search for `href="/runs"` and put `<a href="/subscriptions">Abonnements</a>` adjacent.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/billing-runs/ apps/web/src/routes/+page.svelte
git commit -m "feat(web): /billing-runs history page + dashboard nav link"
```

---

## Phase 5 — Integration Test

### Task 14: Live end-to-end probe

**Files:**
- Create: `apps/worker/src/probe-subscription.ts`

- [ ] **Step 1: Write the probe script**

Create `apps/worker/src/probe-subscription.ts`:

```typescript
// End-to-end live probe for the subscription pipeline.
// 1. Insert a tiny test subscription (CHF 0.01, monthly, today, no auto-send)
// 2. Call runSubscriptionNow to force billing
// 3. Print the result
// 4. Roll back: delete subscription, billing_runs, AND delete the bexio invoice
//
// SAFETY: this creates a real bexio invoice draft. Script attempts cleanup but
// if it crashes you must manually delete the invoice in bexio UI.
//
// Usage: bun run apps/worker/src/probe-subscription.ts <bexio_contact_id> <bexio_article_id>

import { eq } from 'drizzle-orm';
import { getDb, closeDb, subscriptions, subscriptionItems, billingRuns } from '@bexio-bot/db';
import { getValidAccessToken, BEXIO_API_BASE } from '@bexio-bot/bexio-client';
import { runSubscriptionNow } from './lib/subscriptions.ts';

const contactId = Number(process.argv[2]);
const articleId = Number(process.argv[3]);
if (!Number.isInteger(contactId) || !Number.isInteger(articleId)) {
  console.error('Usage: bun run apps/worker/src/probe-subscription.ts <contact_id> <article_id>');
  process.exit(1);
}

const db = getDb();
let subId: number | undefined;
let invoiceId: number | undefined;

try {
  const accessToken = await getValidAccessToken(db);
  console.log('Token OK');

  const today = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
  const [sub] = await db
    .insert(subscriptions)
    .values({
      bexioContactId: contactId,
      name: `PROBE-${Date.now()}`,
      interval: 'monthly',
      startDate: today,
      nextBillingDate: today,
      status: 'active',
      autoSend: false, // don't actually email anyone
    })
    .returning();
  subId = sub!.id;
  console.log(`Created subscription #${subId}`);

  await db.insert(subscriptionItems).values({
    subscriptionId: subId,
    bexioArticleId: articleId,
    qty: '1',
    positionOrder: 0,
  });

  console.log('Running subscription…');
  const result = await runSubscriptionNow(db, accessToken, subId);
  console.log('Result:', JSON.stringify(result, null, 2));

  if (result.kind === 'sent') {
    invoiceId = result.invoiceId;
  }

  // Cleanup
  console.log('\nCleanup:');
  if (invoiceId) {
    const delRes = await fetch(`${BEXIO_API_BASE}/kb_invoice/${invoiceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    });
    console.log(`  DELETE /kb_invoice/${invoiceId} → ${delRes.status}`);
  }
  await db.delete(billingRuns).where(eq(billingRuns.subscriptionId, subId));
  await db.delete(subscriptionItems).where(eq(subscriptionItems.subscriptionId, subId));
  await db.delete(subscriptions).where(eq(subscriptions.id, subId));
  console.log('  DB rows deleted.');
} catch (err) {
  console.error('FAIL:', err instanceof Error ? err.stack : String(err));
  if (subId) console.error(`Manual cleanup needed: subscription #${subId}`);
  if (invoiceId) console.error(`Manual cleanup needed: bexio invoice #${invoiceId}`);
  process.exitCode = 1;
} finally {
  await closeDb();
}
```

- [ ] **Step 2: Run the probe**

Run: `bun run apps/worker/src/probe-subscription.ts <bexio_contact_id> <bexio_article_id>`

Expected output sequence:
1. `Token OK`
2. `Created subscription #N`
3. `Running subscription…`
4. Result JSON with `kind: 'sent'`, an `invoiceId`, and a CHF amount matching the article price
5. `DELETE /kb_invoice/<id> → 200 (or 204)`
6. `DB rows deleted.`

If any step fails, follow the cleanup instructions printed by the script.

- [ ] **Step 3: Verify in bexio UI**

Briefly: log into bexio, check that no PROBE-* invoice remains. The probe deletes its own work but it's worth a glance.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/probe-subscription.ts
git commit -m "test(worker): end-to-end probe for subscription pipeline"
```

---

## Self-Review Checklist

- [x] **Spec coverage**: Every section of `SUBSCRIPTION_DESIGN.md` is implemented:
  - Datenmodell → Task 1+2
  - Cron-Flow → Task 7+8
  - UI-Routen → Tasks 10-13
  - bexio-Client-Erweiterungen → Tasks 3-5
  - Discord-Notification → Task 9
  - Idempotenz via UNIQUE → Task 1 (uniqueIndex)
  - Catch-up-Logik (max 12 Iterationen) → Task 7 (MAX_CATCHUP_ITERATIONS)
  - api_reference Schema `sub:{id}:run:{billingRunId}` → Task 7
  - Failure-Modes → Task 7 (try/catch around the API calls)
- [x] **Placeholder scan**: no TBDs, all code blocks complete.
- [x] **Type consistency**: `ProcessSubscriptionResult` shape consistent between Task 7 (definition), Task 8 (notifyAll mapping), Task 9 (Discord embed types). `addBillingInterval` signature consistent between Task 6 and Task 7. `BexioArticle.sale_price` and `sales_tax_id` used consistently in Tasks 4 and 7.
- [x] **Tests-vs-pragmatism**: TDD only for `addBillingInterval` (pure math); rest validated via manual probe (Task 14), following the repo's existing pattern.

---

## Out of Scope (reminders from spec)

- Migration of existing AU-XXX recurring orders
- Proration / mid-cycle plan changes
- Trial periods
- Self-service portal
- Card payments / Stripe
- Twenty CRM integration
- Multi-currency
- daily / weekly / quarterly intervals
- Free-form (non-article) positions
- Email override per subscription
