// kb_invoice endpoints. The state machine drives these in order:
// createInvoiceFromOrder → issueInvoice → sendInvoice
//
// getInvoice is used for crash-recovery reconciliation: if we crashed after /send
// but before DB commit, we read bexio's `is_sent` field to decide retry vs no-op.

import { callBexio } from './http.ts';
import type { BexioInvoice, CreateInvoiceFromOrderInput } from './types.ts';

/**
 * Create an invoice from an existing recurring order.
 * Bexio's endpoint: POST /kb_order/{id}/repetition  (creates next billing period invoice)
 *
 * NOTE: There are two patterns in bexio for creating invoices from orders:
 *   1. POST /kb_order/{id}/repetition — bexio's "auto" path, creates the next due invoice
 *   2. POST /kb_invoice with copy-from-order parameters — manual path
 *
 * We use #1 because it lets bexio compute the right billing period itself, matching
 * what the order's repetition config says. If the bot's notion of "due today" disagrees
 * with bexio's repetition state, bexio wins (server is the source of truth).
 */
export async function createInvoiceFromOrder(
  accessToken: string,
  input: CreateInvoiceFromOrderInput,
): Promise<BexioInvoice> {
  return callBexio<BexioInvoice>(`/kb_order/${input.order_id}/repetition`, {
    accessToken,
    method: 'POST',
    body: {},
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

/**
 * Send invoice to customer via bexio's mail system.
 * Endpoint: POST /kb_invoice/{id}/send.
 *
 * Phase 1: no custom subject/body — uses bexio's default template.
 * Phase 3 (Mahnwesen): pre-Phase-2.5 spike will determine if custom mail body is supported.
 */
export async function sendInvoice(accessToken: string, invoiceId: number): Promise<void> {
  await callBexio<void>(`/kb_invoice/${invoiceId}/send`, {
    accessToken,
    method: 'POST',
    body: {},
  });
}

/**
 * Get full invoice detail. Used by crash-recovery to reconcile is_sent / mail_sent_at.
 */
export async function getInvoice(accessToken: string, invoiceId: number): Promise<BexioInvoice> {
  return callBexio<BexioInvoice>(`/kb_invoice/${invoiceId}`, { accessToken });
}
