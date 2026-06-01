// Phase 1 schema. See ~/.gstack/projects/bexiobot/marcu-no-git-design-20260510-201917.md
// for the full design doc with all phases.
//
// ASCII state machine for invoice_runs.status:
//
//   pending → creating → created → issuing → issued → sending → sent (terminal, success)
//                ↓          ↓          ↓         ↓         ↓
//                └──────────┴──────────┴─────────┴─────────┘
//                              all errors → failed (terminal)
//
// Crash recovery: rows where status='sending' AND lock_acquired_at < now()-5min
// are reconciled against bexio's `is_sent` field via GET /kb_invoice/{id}.

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
import { sql } from 'drizzle-orm';

// ── Enums ─────────────────────────────────────────────────────

export const invoiceRunStatusEnum = pgEnum('invoice_run_status', [
  'pending',
  'creating',
  'created',
  'issuing',
  'issued',
  'sending',
  'sent',
  'failed',
]);

/**
 * Canonical billing interval for the bot. Bexio's native types are daily/weekly/
 * monthly/yearly; quarterly/semi_annual are bexio's monthly + interval=3 or 6.
 */
export const recurringIntervalEnum = pgEnum('recurring_interval', [
  'daily',
  'weekly',
  'monthly',
  'quarterly',
  'semi_annual',
  'yearly',
]);

/**
 * Mirrors bexio's kb_item_status_id (account-specific IDs) translated to a stable enum.
 * Marcus' bexio: 5=open, 6=done, 21=canceled. Others remain 'unknown' until observed.
 * Worker only processes orders where bexio_status IN ('open', 'partial').
 */
export const bexioStatusEnum = pgEnum('bexio_status', [
  'open',
  'partial',
  'done',
  'canceled',
  'unknown',
]);

// ── Tables ─────────────────────────────────────────────────────

/**
 * Cache of bexio recurring orders. Source-of-truth stays in bexio.
 * Sync rule: new orders inserted with enabled=false. Marcus opts in via dashboard.
 * Worker only processes rows where enabled=true.
 */
export const recurringOrders = pgTable(
  'recurring_orders',
  {
    bexioOrderId: integer('bexio_order_id').primaryKey(),
    customerId: integer('customer_id').notNull(),
    customerName: text('customer_name').notNull(),
    customerEmail: text('customer_email'),
    interval: recurringIntervalEnum('interval').notNull(),
    // Raw bexio repetition interval multiplier (e.g. monthly × 2 = bi-monthly).
    // The canonical `interval` enum only encodes 3/6/12; this keeps the true
    // multiplier for honest dashboard labels ("alle N Monate").
    intervalMultiplier: integer('interval_multiplier').notNull().default(1),
    expectedAmount: text('expected_amount').notNull(), // CHF stored as string for exact decimals
    nextBillingDate: timestamp('next_billing_date', { withTimezone: true }).notNull(),
    enabled: boolean('enabled').notNull().default(false),
    bexioStatus: bexioStatusEnum('bexio_status').notNull().default('unknown'),
    bexioStatusId: integer('bexio_status_id'), // raw kb_item_status_id for forensics
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Partial index: only enabled + processable rows. Worker scans this every cron run.
    nextBillingIdx: index('idx_recurring_orders_next_billing')
      .on(t.nextBillingDate)
      .where(sql`enabled = true AND bexio_status IN ('open', 'partial')`),
  }),
);

/**
 * Idempotency + state machine per (order_id, billing_period).
 * billing_period format (Europe/Zurich, picked by repetition type in
 * formatBillingPeriod):
 *   - 'YYYY-MM-DD' for daily orders
 *   - 'YYYY-Www'   for weekly orders (ISO-8601 week)
 *   - 'YYYY-MM'    for monthly / quarterly / semi-annual / yearly (and unknown)
 */
export const invoiceRuns = pgTable(
  'invoice_runs',
  {
    orderId: integer('order_id').notNull(),
    billingPeriod: text('billing_period').notNull(),
    invoiceId: integer('invoice_id'), // bexio kb_invoice id, set after 'created'
    status: invoiceRunStatusEnum('status').notNull().default('pending'),
    lockAcquiredAt: timestamp('lock_acquired_at', { withTimezone: true }),
    issuedAt: timestamp('issued_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    errorJsonb: jsonb('error_jsonb'),
    attempts: integer('attempts').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.orderId, t.billingPeriod] }),
    // Partial index for in-flight rows only — small, exactly the crash-recovery scan pattern.
    statusLockIdx: index('idx_invoice_runs_status_lock')
      .on(t.status, t.lockAcquiredAt)
      .where(sql`status IN ('creating', 'issuing', 'sending')`),
  }),
);

/**
 * Per run: starting time, finishing time, errors, counts.
 * One row per trigger. trigger_source distinguishes cron, on-demand HTTP
 * (e.g. Cowork), and manual CLI invocations.
 */
export const botRuns = pgTable(
  'bot_runs',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    triggerSource: text('trigger_source').notNull().default('cron'),
    errorsJsonb: jsonb('errors_jsonb'),
    createdInvoicesCount: integer('created_invoices_count').notNull().default(0),
    sentInvoicesCount: integer('sent_invoices_count').notNull().default(0),
    notes: text('notes'),
  },
  (t) => ({
    startedAtIdx: index('idx_bot_runs_started_at_desc').on(t.startedAt),
    inFlightIdx: index('idx_bot_runs_in_flight')
      .on(t.startedAt)
      .where(sql`finished_at IS NULL`),
  }),
);

/**
 * Plain-text storage of OAuth refresh token + access token cache.
 * Solo internal tool, private Coolify, strong Postgres password — no pgcrypto.
 */
export const secrets = pgTable('secrets', {
  key: text('key').primaryKey(), // e.g. 'bexio_refresh_token', 'bexio_access_token'
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }), // null for refresh token (long-lived)
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Generic user-editable application settings (key/value). Separate from `secrets`
 * (which holds OAuth tokens) so cosmetics aren't mixed with credentials.
 * The /settings web page writes these; the worker reads them via getSetting()
 * with an env fallback during migration. NEVER store deploy-time secrets here
 * (DATABASE_URL, BEXIO_CLIENT_SECRET, CF_ACCESS_*, COOLIFY_API_TOKEN, …).
 * The one exception is `discord_webhook_url`, which is a low-sensitivity URL the
 * worker reads at runtime; it is masked write-only in the UI.
 */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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
  qty: text('qty').notNull().default('1'),
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
    uniqRun: uniqueIndex('uniq_billing_runs_sub_date').on(t.subscriptionId, t.scheduledFor),
    statusIdx: index('idx_billing_runs_status').on(t.status, t.createdAt),
  }),
);
