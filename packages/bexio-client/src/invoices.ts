// kb_invoice endpoints. The state machine drives these in order:
// createInvoiceFromOrder → issueInvoice → sendInvoice
//
// getInvoice is used for crash-recovery reconciliation: if we crashed after /send
// but before DB commit, we read bexio's `is_sent` field to decide retry vs no-op.

import { callBexio } from './http.ts';
import type {
  BexioInvoice,
  BexioOrder,
  BexioOrderPosition,
  CreateInvoiceFromOrderInput,
  CreateInvoiceInput,
  BexioInvoicePositionInput,
} from './types.ts';

/**
 * Create an invoice from an existing order.
 * Endpoint: POST /kb_order/{id}/invoice — verified live 2026-05-10.
 *
 * IMPORTANT: do NOT send a JSON body. bexio's parser returns 415 "Could not parse
 * the data" if Content-Type is application/json with anything except an empty
 * payload. The right call is POST with no body and no Content-Type.
 *
 * Status semantics:
 *   200/201 → invoice created, returns BexioInvoice
 *   422 "order is fully invoiced" → caller should treat as not_due
 *                                   (bexio refuses because the next billing
 *                                    period hasn't arrived yet, OR because
 *                                    Marcus created the first invoice manually
 *                                    when setting up the recurring order)
 *
 * Bexio decides "due or not" itself based on the order's repetition config. The
 * bot polls daily and lets bexio be the source-of-truth for billing periods.
 */
export async function createInvoiceFromOrder(
  accessToken: string,
  input: CreateInvoiceFromOrderInput,
): Promise<BexioInvoice> {
  return callBexio<BexioInvoice>(`/kb_order/${input.order_id}/invoice`, {
    accessToken,
    method: 'POST',
    // No body — bexio's parser is strict here. callBexio() omits Content-Type
    // when body is undefined.
  });
}

export type CreateInvoiceFromOrderSnapshotInput = {
  orderId: number;
  isValidFrom: string;
  apiReference?: string;
};

/**
 * Fallback for recurring orders whose source positions are already marked as
 * fully invoiced by bexio. There is no public "run recurring engine now" API, so
 * we copy the order snapshot into a fresh invoice via POST /kb_invoice.
 */
export async function createInvoiceFromOrderSnapshot(
  accessToken: string,
  input: CreateInvoiceFromOrderSnapshotInput,
): Promise<BexioInvoice> {
  const order = await callBexio<BexioOrder>(`/kb_order/${input.orderId}`, { accessToken });
  return createInvoice(
    accessToken,
    buildCreateInvoiceInputFromOrder(order, input.isValidFrom, input.apiReference),
  );
}

// Bexio's POST /kb_invoice form requires a non-null `tax_id` on every position
// even when the source order/position has tax_id=null (mwst_type=2 "Ohne MWST").
// With mwst_type=2 the engine zeros out the tax math regardless of which active
// sales_tax id we pass — verified live 2026-05-20: a CHF 1.00 line stayed at
// total_taxes=0.0000 with tax_id=28. Account-specific id (UN81 8.1%, active).
const NEUTRAL_TAX_ID_FALLBACK = 28;

export function buildCreateInvoiceInputFromOrder(
  order: BexioOrder,
  isValidFrom: string,
  apiReference?: string,
): CreateInvoiceInput {
  const positions = (order.positions ?? [])
    .filter((p) => p.is_optional !== true)
    .map(mapOrderPositionToInvoicePosition)
    .filter((p): p is BexioInvoicePositionInput => p !== null);

  if (positions.length === 0) {
    throw new Error(`Order ${order.document_nr} has no invoiceable positions`);
  }

  if (order.user_id == null) {
    throw new Error(`Order ${order.document_nr} has no user_id — POST /kb_invoice requires it`);
  }

  return stripUndefined({
    contact_id: order.contact_id,
    user_id: order.user_id,
    title: order.title?.trim() || `Auftrag ${order.document_nr}`,
    is_valid_from: isValidFrom,
    mwst_type: order.mwst_type,
    mwst_is_net: order.mwst_is_net,
    api_reference: apiReference,
    positions,
  });
}

function mapOrderPositionToInvoicePosition(
  position: BexioOrderPosition,
): BexioInvoicePositionInput | null {
  if (position.type !== 'KbPositionCustom' && position.type !== 'KbPositionArticle') {
    return null;
  }

  const amount = String(position.amount ?? '1');
  const taxId = position.tax_id ?? NEUTRAL_TAX_ID_FALLBACK;

  if (position.type === 'KbPositionArticle') {
    return stripUndefined({
      type: 'KbPositionArticle',
      article_id: position.article_id ?? undefined,
      amount,
      unit_price: position.unit_price != null ? String(position.unit_price) : undefined,
      tax_id: taxId,
      text: position.text ?? undefined,
      discount_in_percent:
        position.discount_in_percent != null ? String(position.discount_in_percent) : undefined,
    }) as BexioInvoicePositionInput;
  }

  // KbPositionCustom: unit_name and tax_value are read-only (server-derived).
  // POST /kb_invoice rejects them as "Unexpected extra form field" — verified
  // live 2026-05-20.
  return stripUndefined({
    type: 'KbPositionCustom',
    amount,
    account_id: position.account_id ?? undefined,
    unit_id: position.unit_id ?? undefined,
    tax_id: taxId,
    text: position.text ?? '',
    unit_price: position.unit_price != null ? String(position.unit_price) : '0',
    discount_in_percent:
      position.discount_in_percent != null ? String(position.discount_in_percent) : undefined,
  }) as BexioInvoicePositionInput;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}

/**
 * Issue (festschreiben) — moves invoice from draft to permanent record.
 * Endpoint: POST /kb_invoice/{id}/issue. Returns 204 No Content on success.
 */
export async function issueInvoice(accessToken: string, invoiceId: number): Promise<void> {
  await callBexio<void>(`/kb_invoice/${invoiceId}/issue`, {
    accessToken,
    method: 'POST',
  });
}

export type SendInvoiceInput = {
  recipientEmail: string;
  subject: string;
  /** Must contain the literal `[Network Link]` token — bexio refuses (422) otherwise.
   *  The token is replaced server-side with a link to the invoice in bexio's customer portal. */
  message: string;
  attachPdf?: boolean;
};

const NETWORK_LINK_TOKEN = '[Network Link]';

/**
 * Send invoice to customer via bexio's mail system.
 * Endpoint: POST /kb_invoice/{id}/send. Verified live 2026-05-11.
 *
 * Required body fields (per official bexio API docs):
 *   recipient_email, subject, message (must contain [Network Link]).
 * Optional: mark_as_open (track opens), attach_pdf (attach the PDF directly).
 *
 * Returns 200 {"success":true}. Note: GET /kb_invoice/{id} after send may STILL
 * show is_sent=undefined and kb_item_status_id=8 — that's a bexio read-back quirk.
 * The actual send DID happen; verify in bexio UI or via mail receipt.
 */
export async function sendInvoice(
  accessToken: string,
  invoiceId: number,
  input: SendInvoiceInput,
): Promise<void> {
  // Defensive: ensure the [Network Link] token is in the message. If caller forgot,
  // append it so the email is still valid and the link to the invoice is reachable.
  const message = input.message.includes(NETWORK_LINK_TOKEN)
    ? input.message
    : `${input.message}\n\n${NETWORK_LINK_TOKEN}`;

  await callBexio<void>(`/kb_invoice/${invoiceId}/send`, {
    accessToken,
    method: 'POST',
    body: {
      recipient_email: input.recipientEmail,
      subject: input.subject,
      message,
      mark_as_open: true,
      attach_pdf: input.attachPdf ?? true,
    },
  });
}

/**
 * Get full invoice detail. Used by crash-recovery to reconcile is_sent / mail_sent_at.
 */
export async function getInvoice(accessToken: string, invoiceId: number): Promise<BexioInvoice> {
  return callBexio<BexioInvoice>(`/kb_invoice/${invoiceId}`, { accessToken });
}

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
