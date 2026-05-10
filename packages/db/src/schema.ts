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
} from 'drizzle-orm/pg-core';

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

export const recurringIntervalEnum = pgEnum('recurring_interval', [
  'monthly',
  'quarterly',
  'semi_annual',
  'yearly',
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
    interval: recurringIntervalEnum('interval').notNull(),
    expectedAmount: text('expected_amount').notNull(), // CHF stored as string for exact decimals
    nextBillingDate: timestamp('next_billing_date', { withTimezone: true }).notNull(),
    enabled: boolean('enabled').notNull().default(false),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    nextBillingIdx: index('idx_recurring_orders_next_billing')
      .on(t.nextBillingDate)
      .where(t.enabled), // Partial index: only enabled rows
  }),
);

/**
 * Idempotency + state machine per (order_id, billing_period).
 * billing_period format: 'YYYY-MM' (monthly), 'YYYY-Q{1-4}' (quarterly),
 * 'YYYY-H{1-2}' (semi-annual), 'YYYY' (yearly), in Europe/Zurich.
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
    statusLockIdx: index('idx_invoice_runs_status_lock')
      .on(t.status, t.lockAcquiredAt)
      .where(t.status), // partial index for crash-recovery scans
  }),
);

/**
 * Per daily run: starting time, finishing time, errors, counts.
 * One row per cron trigger.
 */
export const botRuns = pgTable(
  'bot_runs',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    errorsJsonb: jsonb('errors_jsonb'),
    createdInvoicesCount: integer('created_invoices_count').notNull().default(0),
    sentInvoicesCount: integer('sent_invoices_count').notNull().default(0),
    notes: text('notes'),
  },
  (t) => ({
    startedAtIdx: index('idx_bot_runs_started_at_desc').on(t.startedAt),
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
