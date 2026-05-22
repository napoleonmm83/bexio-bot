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

import { and, eq, isNull, lte, or, gte } from 'drizzle-orm';
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

/**
 * Hard-validate inputs that would otherwise silently corrupt a billing run:
 *   - auto_send with no contact email = bot thinks mail went out, customer never receives it (N-7)
 *   - article without sale_price = CHF 0 invoice gets created + sent (N-8)
 * Throws before any side-effect so the billing_runs lock can be cleanly removed by the catch in processOneSubscription.
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

/**
 * On error inside processOneSubscription, decide whether to delete the
 * billing_runs lock (so the next daily run can retry) or keep it as 'failed'
 * for manual review.
 *
 * delete-and-retry: transient (5xx, 429) — likely to succeed next time.
 * keep-failed: permanent validation, auth, local validation — needs human intervention.
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
    let current: typeof sub | undefined = sub;
    while (
      current &&
      current.status === 'active' &&
      current.nextBillingDate <= today &&
      iteration < MAX_CATCHUP_ITERATIONS
    ) {
      const result = await processOneSubscription(db, accessToken, current);
      results.push(result);
      if (result.kind !== 'sent') break;
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

    validateSubscriptionInputs({
      autoSend: sub.autoSend,
      contactMail: contact.mail ?? null,
      articles: articles.map((a) => ({ id: a.id, sale_price: a.sale_price })),
      items,
    });

    // 3. Build positions + create invoice
    const positions: BexioInvoicePositionInput[] = items.map((item, idx) => {
      const article = articles[idx]!;
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
      mwst_type: 0,
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

    // 5. Mark success + advance next_billing_date — ATOMIC (N-6)
    // A crash between the two writes used to leave the subscription as
    // forever-due with an idempotency-locked billing_runs row that blocked
    // every future attempt.
    const newNext = addBillingInterval(
      sub.nextBillingDate,
      sub.interval as SubscriptionInterval,
    );
    await db.transaction(async (tx) => {
      await tx
        .update(billingRuns)
        .set({
          status: 'success',
          bexioInvoiceId: invoice.id,
          executedAt: new Date(),
        })
        .where(eq(billingRuns.id, runRow.id));
      await tx
        .update(subscriptions)
        .set({ nextBillingDate: newNext, updatedAt: new Date() })
        .where(eq(subscriptions.id, sub.id));
    });

    return {
      kind: 'sent',
      subscriptionId: sub.id,
      invoiceId: invoice.id,
      amount: invoice.total,
      scheduledFor: scheduledForIso,
    };
  } catch (err) {
    const retryClass = classifyForRetry(err);

    if (retryClass === 'delete-and-retry') {
      // Transient failure — clear the lock so next daily run can retry. The
      // billing_runs row is REMOVED, not marked failed; subscription's
      // next_billing_date stays as-is (still due). (F-1)
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
}

/**
 * Manual single-subscription trigger (used by dashboard "Jetzt abrechnen" action).
 * Uses the same internal logic; idempotency-lock still applies.
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
