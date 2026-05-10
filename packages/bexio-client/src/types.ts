// bexio API response types. Conservative — only fields we actually use.
// Full schema docs: https://docs.bexio.com/

// ─── OAuth ────────────────────────────────────────────────

export type TokenResponse = {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  token_type: string;
  scope: string;
};

// ─── kb_order (Recurring orders) ──────────────────────────

export type RecurringInterval = 'monthly' | 'quarterly' | 'semi_annual' | 'yearly';

/**
 * Repetition config inside an order. Field names from bexio's API.
 * Reverse-engineered from observed responses; subject to drift.
 */
export type BexioRepetition = {
  start_date?: string; // 'YYYY-MM-DD'
  end_date?: string | null;
  type?: string; // bexio's own enum: 'monthly' | 'quarterly' | 'half_year' | 'yearly' or similar
  every?: number; // e.g. every=3 means every 3 months
  next_repetition_at?: string | null; // 'YYYY-MM-DD' — most useful field for the worker
};

export type BexioOrder = {
  id: number;
  document_nr: string;
  title: string;
  contact_id: number;
  contact_sub_id?: number | null;
  total: string; // CHF as string
  total_gross?: string;
  total_net?: string;
  is_recurring: boolean;
  repetition?: BexioRepetition | null;
  api_reference?: string | null;
  updated_at: string; // 'YYYY-MM-DD HH:mm:ss'
  is_valid_from?: string;
};

// ─── contact ───────────────────────────────────────────────

/**
 * bexio contact. contact_type_id: 1 = company (Firma), 2 = person (Privatperson).
 * Display name: firms use name_1; persons use "name_2 name_1" (Vorname Nachname).
 */
export type BexioContact = {
  id: number;
  contact_type_id: number;
  name_1: string;
  name_2?: string | null;
  salutation_id?: number | null;
  mail?: string | null;
  updated_at: string;
};

export function formatContactName(c: BexioContact): string {
  const isPerson = c.contact_type_id === 2;
  if (isPerson && c.name_2) {
    return `${c.name_2} ${c.name_1}`.trim();
  }
  return c.name_1.trim() || `Kontakt #${c.id}`;
}

// ─── kb_invoice ───────────────────────────────────────────

export type BexioInvoice = {
  id: number;
  document_nr: string;
  title: string;
  contact_id: number;
  total: string;
  is_valid_from: string;
  is_valid_to: string;
  is_sent?: boolean; // critical for crash-recovery reconciliation
  mail_sent_at?: string | null;
  kb_item_status_id: number; // bexio's status enum (open, paid, etc.)
  api_reference?: string | null;
  updated_at: string;
};

export type CreateInvoiceFromOrderInput = {
  order_id: number;
  // bexio supports more fields here (api_reference, etc.) — added as needed
};

// ─── HTTP errors ──────────────────────────────────────────

export type BexioErrorClass = 'auth' | 'rate_limit' | 'transient' | 'permanent';

export class BexioApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly errorClass: BexioErrorClass,
    public readonly body: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(`bexio API ${status} (${errorClass}): ${body.slice(0, 200)}`);
    this.name = 'BexioApiError';
  }
}
