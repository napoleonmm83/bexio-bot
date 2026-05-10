// kb_invoice endpoints. The state machine drives these in order:
// createInvoiceFromOrder → issueInvoice → sendInvoice
//
// getInvoice is used for crash-recovery reconciliation: if we crashed after /send
// but before DB commit, we read bexio's `is_sent` field to decide retry vs no-op.

import { callBexio } from './http.ts';
import type { BexioInvoice, CreateInvoiceFromOrderInput } from './types.ts';

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
