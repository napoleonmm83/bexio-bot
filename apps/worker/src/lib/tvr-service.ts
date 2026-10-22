// TV-Rheintal billing — I/O layer around the pure rules in tvr-billing.ts.
// Called by the MCP endpoint (apps/web/src/routes/mcp). Every tool function
// (tvrStatus/tvrAdd/tvrSend/tvrRemovePosition) writes one audit row to tvr_tool_calls;
// tvrPendingReminder (runDaily) does not.

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  addCustomPosition,
  createInvoice,
  deleteCustomPosition,
  getContact,
  getInvoice,
  getValidAccessToken,
  issueInvoice,
  NEUTRAL_TAX_ID_FALLBACK,
  searchInvoices,
  sendInvoice,
  type BexioInvoice,
} from '@bexio-bot/bexio-client';
import { tvrToolCalls } from '@bexio-bot/db';
import { getZurichParts } from './billing-period.ts';
import { loadWorkerSettings } from './settings.ts';
import { renderTemplate } from './state-machine.ts';
import {
  dueDateFor,
  htmlToText,
  planAdd,
  positionText,
  sendDueFor,
  targetFor,
  type TvrInvoice,
  type Ymd,
} from './tvr-billing.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PostgresJsDatabase<any>;

/** bexio kb_item_status_id for "Entwurf" (verified on RE-00284, 2026-10-22). */
export const BEXIO_STATUS_DRAFT = 7;
const TVR_LOCK_KEY = 0x7476_7200; // 'tvr\0' — serializes tvr_add_beitrag across processes
const TVR_SEND_LOCK_KEY = 0x7476_7201; // serializes tvr_send_invoice
const LOOKBACK_MONTHS = 2;

export type TvrConfig = {
  contactId: number;
  unitPrice: string;
  accountId: number;
  unitId: number;
  taxId: number;
  templateInvoiceId: number;
  paymentDays: number;
};

function envInt(name: string, fallback?: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  if (n === undefined || !Number.isInteger(n) || n <= 0) throw new Error(`${name} missing or invalid`);
  return n;
}

export function loadTvrConfig(): TvrConfig {
  return {
    // Contact id is mandatory on purpose — never resolved by name (spec §2).
    contactId: envInt('TVR_CONTACT_ID'),
    unitPrice: process.env.TVR_UNIT_PRICE || '330.00',
    accountId: envInt('TVR_ACCOUNT_ID', 148),
    unitId: envInt('TVR_UNIT_ID', 1),
    // bexio rejects null tax_id on create; with mwst_type=2 the tax is zeroed anyway.
    taxId: envInt('TVR_TAX_ID', NEUTRAL_TAX_ID_FALLBACK),
    templateInvoiceId: envInt('TVR_TEMPLATE_INVOICE_ID', 284),
    paymentDays: envInt('TVR_PAYMENT_DAYS', 30),
  };
}

const todayZurich = (): Ymd => {
  const p = getZurichParts(new Date());
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day) };
};

const MAX_COMPLETION_AGE_MONTHS = 3;

/** Parses completion_date; rejects future dates and anything older than MAX_COMPLETION_AGE_MONTHS. */
export function parseCompletionDate(s: string | undefined, today: Ymd = todayZurich()): Ymd {
  if (!s) return today;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error(`completion_date must be YYYY-MM-DD, got "${s}"`);
  const ymd = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
  const check = new Date(Date.UTC(ymd.year, ymd.month - 1, ymd.day));
  if (check.getUTCMonth() !== ymd.month - 1 || check.getUTCDate() !== ymd.day) {
    throw new Error(`completion_date is not a real date: "${s}"`);
  }
  if (s > ymdIso(today)) throw new Error(`completion_date ${s} liegt in der Zukunft`);
  if (s < ymdIso(monthsBack(today, MAX_COMPLETION_AGE_MONTHS))) {
    throw new Error(`completion_date ${s} ist älter als ${MAX_COMPLETION_AGE_MONTHS} Monate — bitte manuell in bexio buchen`);
  }
  return ymd;
}

const isoDate = (s: string) => s.slice(0, 10);
const ymdIso = (d: Ymd) => `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
/** 1st of the month `n` months before `d` (Date.UTC normalizes month underflow across years). */
const monthsBack = (d: Ymd, n: number): Ymd => {
  const x = new Date(Date.UTC(d.year, d.month - 1 - n, 1));
  return { year: x.getUTCFullYear(), month: x.getUTCMonth() + 1, day: 1 };
};

/**
 * All TV-Rheintal invoices from LOOKBACK_MONTHS before the EARLIER of today and the
 * completion date on, with positions — so the target invoice and every recent
 * duplicate candidate are always in view.
 */
async function loadRecent(token: string, cfg: TvrConfig, today: Ymd, completion: Ymd = today): Promise<BexioInvoice[]> {
  const anchor = ymdIso(completion) < ymdIso(today) ? completion : today;
  const from = ymdIso(monthsBack(anchor, LOOKBACK_MONTHS));
  const hits = await searchInvoices(token, [{ field: 'contact_id', value: cfg.contactId, criteria: '=' }], 2000);
  const recent = hits.filter((h) => h.contact_id === cfg.contactId && isoDate(h.is_valid_from) >= from);
  // Search results have no positions — fetch each (a handful per month).
  const full: BexioInvoice[] = [];
  for (const h of recent) full.push(await getInvoice(token, h.id));
  return full;
}

const toTvr = (inv: BexioInvoice): TvrInvoice => ({
  id: inv.id,
  isDraft: inv.kb_item_status_id === BEXIO_STATUS_DRAFT,
  invoiceDate: isoDate(inv.is_valid_from),
  positionTexts: (inv.positions ?? []).map((p) => p.text ?? ''),
});

function summarize(inv: BexioInvoice, today: Ymd) {
  const positions = (inv.positions ?? []).filter((p) => p.type !== 'KbPositionText');
  return {
    invoice_id: inv.id,
    invoice_nr: inv.document_nr,
    invoice_status: inv.kb_item_status_id === BEXIO_STATUS_DRAFT ? 'draft' : `status_${inv.kb_item_status_id}`,
    invoice_date: isoDate(inv.is_valid_from),
    due_date: isoDate(inv.is_valid_to),
    positions: positions.map((p) => ({
      position_id: p.id,
      text: htmlToText(p.text ?? '').replace(/ /g, ' ').trim(),
      amount: p.position_total,
    })),
    position_count: positions.length,
    total: inv.total,
    send_due: sendDueFor(toTvr(inv), today),
  };
}

async function audit(db: Db, tool: string, caller: string | undefined, input: unknown, run: () => Promise<unknown>) {
  try {
    const result = await run();
    // The bexio write already happened — a failing audit insert must not report it as failed.
    await db
      .insert(tvrToolCalls)
      .values({ tool, caller, inputJsonb: input ?? {}, resultJsonb: result })
      .catch((e) => console.error('[tvr] audit insert failed after success', tool, e));
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .insert(tvrToolCalls)
      .values({ tool, caller, inputJsonb: input ?? {}, error: message })
      .catch((e) => console.error('[tvr] audit insert failed', e));
    throw err;
  }
}

/** Day of month (Zurich) on which runDaily nags about a still-unsent previous-month invoice. */
export const TVR_REMINDER_DAY = 6;

/**
 * Safety net (spec §6): without a contribution in the 1–8 window nothing would
 * prompt sending last month's invoice. Returns a message when it is still a draft
 * on the reminder day, else null. No-op when TVR_CONTACT_ID is not configured.
 */
export async function tvrPendingReminder(token: string, today: Ymd = todayZurich()): Promise<string | null> {
  if (today.day !== TVR_REMINDER_DAY || !process.env.TVR_CONTACT_ID) return null;
  const cfg = loadTvrConfig();
  const firstOfMonth = `${today.year}-${String(today.month).padStart(2, '0')}-01`;
  const hits = await searchInvoices(token, [{ field: 'contact_id', value: cfg.contactId, criteria: '=' }], 2000);
  const pending = hits.find(
    (h) =>
      h.contact_id === cfg.contactId &&
      isoDate(h.is_valid_from) === firstOfMonth &&
      h.kb_item_status_id === BEXIO_STATUS_DRAFT,
  );
  return pending
    ? `TV-Rheintal-Rechnung ${pending.document_nr} (Total CHF ${pending.total}) ist noch nicht versendet — Versandfenster endet am 8.`
    : null;
}

// ─── tools ──────────────────────────────────────────────────

export async function tvrStatus(db: Db, input: { completion_date?: string }, caller?: string) {
  return audit(db, 'tvr_billing_status', caller, input, async () => {
    const cfg = loadTvrConfig();
    const completion = parseCompletionDate(input.completion_date);
    const today = todayZurich();
    const token = await getValidAccessToken(db);
    const recent = await loadRecent(token, cfg, today, completion);
    const { invoiceDate, note } = targetFor(completion, recent.map(toTvr));
    const target = recent.find((i) => isoDate(i.is_valid_from) === invoiceDate);
    return {
      billing_invoice_date: invoiceDate,
      invoice: target ? summarize(target, today) : null,
      send_due: target ? sendDueFor(toTvr(target), today) : false,
      note: note ?? (target ? undefined : 'Noch keine Rechnung für diesen Abrechnungsmonat'),
    };
  });
}

export async function tvrAdd(
  db: Db,
  input: { title: string; completion_date?: string; dry_run?: boolean },
  caller?: string,
) {
  return audit(db, 'tvr_add_beitrag', caller, input, async () => {
    const title = input.title?.trim();
    if (!title) throw new Error('title is required');
    if (title.length > 200) throw new Error('title too long (max 200)');
    const cfg = loadTvrConfig();
    const completion = parseCompletionDate(input.completion_date);
    const token = await getValidAccessToken(db);

    return db.transaction(async (tx) => {
      // Serialize concurrent adds: two parallel calls must not both create the month's invoice.
      if (!input.dry_run) await tx.execute(sql`SELECT pg_advisory_xact_lock(${TVR_LOCK_KEY})`);
      const today = todayZurich();
      const recent = await loadRecent(token, cfg, today, completion);
      const plan = planAdd({ title, completion, today, invoices: recent.map(toTvr) });
      const text = positionText(title);

      if (plan.action === 'already_exists') {
        const inv = recent.find((i) => i.id === plan.invoiceId)!;
        return { status: 'already_exists', ...summarize(inv, today), note: plan.note };
      }
      if (input.dry_run) {
        const inv = plan.action === 'add' ? recent.find((i) => i.id === plan.invoiceId) : undefined;
        return {
          status: 'dry_run',
          would: plan.action === 'add' ? 'add_position' : 'create_invoice',
          position_text: text,
          invoice_date: plan.invoiceDate,
          due_date: dueDateFor(plan.invoiceDate, cfg.paymentDays),
          invoice: inv ? summarize(inv, today) : null,
          send_due: plan.sendDue,
          note: plan.note,
        };
      }

      const position = {
        amount: '1',
        unit_id: cfg.unitId,
        account_id: cfg.accountId,
        tax_id: cfg.taxId,
        text,
        unit_price: cfg.unitPrice,
      };
      let invoiceId: number;
      if (plan.action === 'add') {
        await addCustomPosition(token, plan.invoiceId, position);
        invoiceId = plan.invoiceId;
      } else {
        const tpl = await getInvoice(token, cfg.templateInvoiceId);
        if (tpl.contact_id !== cfg.contactId) {
          throw new Error(`Template invoice ${cfg.templateInvoiceId} belongs to another contact`);
        }
        const created = await createInvoice(token, {
          contact_id: cfg.contactId,
          is_valid_from: plan.invoiceDate,
          is_valid_to: dueDateFor(plan.invoiceDate, cfg.paymentDays),
          mwst_type: tpl.mwst_type,
          mwst_is_net: tpl.mwst_is_net,
          user_id: tpl.user_id,
          language_id: tpl.language_id,
          bank_account_id: tpl.bank_account_id,
          currency_id: tpl.currency_id,
          payment_type_id: tpl.payment_type_id,
          logopaper_id: tpl.logopaper_id,
          template_slug: tpl.template_slug,
          header: tpl.header,
          footer: tpl.footer,
          contact_address: tpl.contact_address,
          positions: [{ type: 'KbPositionCustom', ...position, amount: '1' }],
        });
        invoiceId = created.id;
      }
      const after = await getInvoice(token, invoiceId);
      return { status: 'added', ...summarize(after, today), note: plan.note };
    });
  });
}

async function loadOwnDraft(token: string, cfg: TvrConfig, invoiceId: number): Promise<BexioInvoice> {
  const inv = await getInvoice(token, invoiceId);
  if (inv.contact_id !== cfg.contactId) throw new Error(`Invoice ${invoiceId} is not a TV-Rheintal invoice`);
  if (inv.kb_item_status_id !== BEXIO_STATUS_DRAFT) {
    throw new Error(`Invoice ${inv.document_nr} is not a draft (status ${inv.kb_item_status_id})`);
  }
  return inv;
}

export async function tvrSend(db: Db, input: { invoice_id: number; confirm: boolean }, caller?: string) {
  return audit(db, 'tvr_send_invoice', caller, input, async () => {
    if (input.confirm !== true) throw new Error('confirm must be true');
    const cfg = loadTvrConfig();
    const token = await getValidAccessToken(db);
    const settings = await loadWorkerSettings(db);

    // Idempotency: under the lock the draft check is the claim. A second (parallel or
    // retried) call sees the issued invoice as non-draft and is refused — never a 2nd mail.
    return db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${TVR_SEND_LOCK_KEY})`);
      const inv = await loadOwnDraft(token, cfg, input.invoice_id);
      const contact = await getContact(token, cfg.contactId);
      if (!contact.mail) throw new Error('TV Rheintal contact has no e-mail address in bexio');

      await issueInvoice(token, inv.id);
      try {
        await sendInvoice(token, inv.id, {
          recipientEmail: contact.mail,
          subject: renderTemplate(settings.mailSubject, { document_nr: inv.document_nr }),
          message: renderTemplate(settings.mailMessage, { document_nr: inv.document_nr }),
        });
      } catch (err) {
        // No automatic retry: bexio's sent flag is unreliable on read-back, a retry could double-mail.
        const why = err instanceof Error ? err.message : String(err);
        throw new Error(
          `${inv.document_nr} wurde ausgestellt, der Mailversand ist aber fehlgeschlagen (${why}). ` +
            'Bitte in bexio prüfen und ggf. manuell per E-Mail versenden.',
        );
      }
      const after = await getInvoice(token, inv.id);
      return {
        invoice_nr: after.document_nr,
        status: `status_${after.kb_item_status_id}`,
        recipient: contact.mail,
        sent_at: new Date().toISOString(),
        total: after.total,
      };
    });
  });
}

export async function tvrRemovePosition(
  db: Db,
  input: { invoice_id: number; position_id: number },
  caller?: string,
) {
  return audit(db, 'tvr_remove_position', caller, input, async () => {
    const cfg = loadTvrConfig();
    const token = await getValidAccessToken(db);
    const inv = await loadOwnDraft(token, cfg, input.invoice_id);
    const pos = (inv.positions ?? []).find((p) => p.id === input.position_id);
    if (!pos) throw new Error(`Position ${input.position_id} not found on ${inv.document_nr}`);
    if (pos.type !== 'KbPositionCustom') throw new Error(`Position ${input.position_id} is not a custom position`);
    await deleteCustomPosition(token, inv.id, pos.id);
    const after = await getInvoice(token, inv.id);
    return { status: 'removed', removed_text: htmlToText(pos.text ?? '').trim(), ...summarize(after, todayZurich()) };
  });
}
