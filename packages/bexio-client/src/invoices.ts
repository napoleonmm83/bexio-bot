// kb_invoice endpoints. The state machine drives these in order:
// createInvoiceFromOrder → issueInvoice → sendInvoice
//
// getInvoice is used for crash-recovery reconciliation: if we crashed after /send
// but before DB commit, we read bexio's `is_sent` field to decide retry vs no-op.

import { callBexio } from './http.ts';
import type { BexioInvoice, CreateInvoiceFromOrderInput, CreateInvoiceInput } from './types.ts';

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
