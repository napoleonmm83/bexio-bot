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
/**
 * Inline repetition info on a kb_order (rarely populated — see BexioOrderRepetition
 * for the canonical representation returned from /kb_order/{id}/repetition).
 */
export type BexioRepetition = {
  start_date?: string;
  end_date?: string | null;
  type?: string;
  every?: number;
  next_repetition_at?: string | null;
};

/**
 * Response shape of GET /kb_order/{id}/repetition (verified live, 2026-05).
 *
 * `type` values seen: 'monthly', 'yearly'. Bexio docs hint at 'quarterly' and 'half_year'
 * but I haven't observed them; mapper falls back gracefully.
 *
 * `interval` is multiplier on `type`. Example: type='monthly' interval=3 → every 3 months.
 *
 * `schedule` controls within-period timing for monthly billing. Seen: 'last_day' (last
 * day of month). Not relevant for our period mapping.
 */
export type BexioOrderRepetition = {
  start?: string;
  end?: string | null;
  repetition?: {
    type: string;
    interval: number;
    schedule?: string;
  } | null;
};

/**
 * Translate bexio's repetition config to our canonical interval enum.
 * Hierarchy: type comes first, interval is a multiplier-override for monthly.
 */
export function mapRepetitionToInterval(
  rep: BexioOrderRepetition | null | undefined,
): 'monthly' | 'quarterly' | 'semi_annual' | 'yearly' {
  const r = rep?.repetition;
  if (!r) return 'monthly'; // legacy fallback for orders with no /repetition response

  switch (r.type) {
    case 'yearly':    return 'yearly';
    case 'quarterly': return 'quarterly';
    case 'half_year': return 'semi_annual';
    case 'monthly':
      // interval=1 monthly, interval=3 = quarterly, interval=6 = semi_annual, interval=12 = yearly
      if (r.interval === 12) return 'yearly';
      if (r.interval === 6)  return 'semi_annual';
      if (r.interval === 3)  return 'quarterly';
      return 'monthly';
    default:
      return 'monthly';
  }
}

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
  /** kb_item_status_id — raw bexio status. Account-specific IDs.
   *  Marcus' bexio: 5=open, 6=done, 21=canceled. Use mapBexioStatus() to translate. */
  kb_item_status_id?: number;
  repetition?: BexioRepetition | null;
  api_reference?: string | null;
  updated_at: string; // 'YYYY-MM-DD HH:mm:ss'
  is_valid_from?: string;
};

export type MappedBexioStatus = 'open' | 'partial' | 'done' | 'canceled' | 'unknown';

/**
 * Translate bexio's kb_item_status_id to a stable enum.
 * Status IDs vary per account; this is the mapping verified against Marcus' bexio.
 * Add new IDs here if the discovery script (test-bexio.ts) surfaces them.
 */
export function mapBexioStatus(statusId: number | undefined | null): MappedBexioStatus {
  switch (statusId) {
    case 5:  return 'open';
    case 6:  return 'done';
    case 7:  return 'partial';   // tentative — bexio's "Teilweise" tab; verify when first seen
    case 21: return 'canceled';
    default: return 'unknown';
  }
}

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
