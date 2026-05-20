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
    /** Required when type === 'weekly'. Lowercase English day names. */
    weekdays?: string[];
  } | null;
};

/**
 * Translate bexio's repetition config to our canonical interval enum.
 *
 * Bexio API supports exactly four type values (verified live 2026-05-10 via probe):
 *   daily, weekly, monthly, yearly
 *
 * Quarterly and semi-annual don't exist as native bexio types — they're configured
 * as monthly with interval=3 or interval=6. Our enum surfaces them as distinct
 * values for clearer UI display.
 */
export type CanonicalInterval =
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'semi_annual'
  | 'yearly';

export function mapRepetitionToInterval(
  rep: BexioOrderRepetition | null | undefined,
): CanonicalInterval {
  const r = rep?.repetition;
  if (!r) return 'monthly'; // legacy fallback for orders with no /repetition response

  switch (r.type) {
    case 'daily':  return 'daily';
    case 'weekly': return 'weekly';
    case 'yearly': return 'yearly';
    case 'monthly':
      // bexio monthly + interval multiplier maps to our finer enum values
      if (r.interval === 12) return 'yearly';
      if (r.interval === 6)  return 'semi_annual';
      if (r.interval === 3)  return 'quarterly';
      return 'monthly';
    default:
      // Unknown future type — default to monthly so DB accepts it. Caller can
      // detect via isSupportedBexioInterval() and skip in the state machine.
      return 'monthly';
  }
}

/**
 * Returns true if bexio's repetition.type is one the bot can drive.
 * All four native bexio types are supported.
 */
export function isSupportedBexioInterval(rep: BexioOrderRepetition | null | undefined): boolean {
  const type = rep?.repetition?.type;
  return type === 'daily' || type === 'weekly' || type === 'monthly' || type === 'yearly';
}

export type BexioOrder = {
  id: number;
  document_nr: string;
  title: string;
  contact_id: number;
  contact_sub_id?: number | null;
  user_id?: number | null;
  project_id?: number | null;
  logopaper_id?: number | null;
  language_id?: number | null;
  bank_account_id?: number | null;
  currency_id?: number | null;
  payment_type_id?: number | null;
  total: string; // CHF as string
  total_gross?: string;
  total_net?: string;
  mwst_type?: number;
  mwst_is_net?: boolean;
  is_recurring: boolean;
  /** kb_item_status_id — raw bexio status. Account-specific IDs.
   *  Marcus' bexio: 5=open, 6=done, 21=canceled. Use mapBexioStatus() to translate. */
  kb_item_status_id?: number;
  repetition?: BexioRepetition | null;
  positions?: BexioOrderPosition[];
  api_reference?: string | null;
  updated_at: string; // 'YYYY-MM-DD HH:mm:ss'
  is_valid_from?: string;
};

export type BexioOrderPosition = {
  id: number;
  type: string;
  amount?: string | number;
  unit_id?: number | null;
  account_id?: number | null;
  unit_name?: string | null;
  tax_id?: number | null;
  tax_value?: string | null;
  text?: string | null;
  unit_price?: string | number | null;
  discount_in_percent?: string | number | null;
  internal_pos?: number | null;
  is_optional?: boolean | null;
  parent_id?: number | null;
  article_id?: number | null;
};

export type MappedBexioStatus = 'open' | 'partial' | 'done' | 'canceled' | 'unknown';

/**
 * Translate bexio's kb_item_status_id to a stable enum.
 * IDs verified live against Marcus' bexio (2026-05-10):
 *   5  → open      (offen — initial state)
 *   6  → done      (erledigt — fully invoiced)
 *   15 → partial   (teilweise — partially invoiced, recurring not yet done)
 *   21 → canceled  (storniert)
 *
 * Add new IDs here as we discover them. Bexio's status IDs may vary per
 * account so this mapping is account-specific verified data.
 */
export function mapBexioStatus(statusId: number | undefined | null): MappedBexioStatus {
  switch (statusId) {
    case 5:  return 'open';
    case 6:  return 'done';
    case 15: return 'partial';   // bexio's "Teilweise" tab — partially invoiced
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

// ─── article ─────────────────────────────────────────────

/**
 * bexio article (Produkt). Fields used by the subscription layer to build
 * invoice positions. Verified live against /article endpoint 2026-05.
 */
export type BexioArticle = {
  id: number;
  user_id?: number;
  article_type_id?: number;
  /** Article number shown to users (e.g. "HOST-BASIC") */
  intern_code: string;
  /** Display name (e.g. "Hosting Basic") */
  intern_name: string;
  intern_description?: string | null;
  /** Sale price as decimal string in CHF. Source-of-truth for billing. */
  sale_price?: string | null;
  purchase_price?: string | null;
  cost_price?: string | null;
  /** Default tax id (bexio's tax registry id, NOT a rate). Used for invoice positions. */
  sales_tax_id?: number | null;
  purchase_tax_id?: number | null;
  is_stock?: boolean;
  stock_id?: number | null;
  stock_nr?: number;
  stock_min_nr?: number;
  stock_reserved_nr?: number;
  stock_available_nr?: number;
  stock_picked_nr?: number;
  updated_at?: string;
};

// ─── CreateInvoiceInput ──────────────────────────────────

/**
 * Input for POST /kb_invoice. Only the fields the subscription layer uses.
 * bexio supports many more; add as needed.
 */
export type CreateInvoiceInput = {
  contact_id: number;
  title?: string;
  is_valid_from: string; // YYYY-MM-DD
  is_valid_to?: string;
  mwst_type?: number; // 0 = incl, 1 = excl, 2 = exempt
  mwst_is_net?: boolean;
  api_reference?: string;
  /** Inline positions. At least one required. */
  positions: BexioInvoicePositionInput[];
};

export type BexioInvoicePositionInput = {
  /** Position type. For article-based: 'KbPositionArticle'. */
  type: 'KbPositionArticle' | 'KbPositionCustom';
  article_id?: number; // required when type='KbPositionArticle'
  account_id?: number | null;
  unit_id?: number | null;
  unit_name?: string | null;
  amount: string; // qty as decimal string
  unit_price?: string; // optional override; if omitted bexio uses the article's sale_price
  tax_id?: number | null;
  tax_value?: string | null;
  text?: string; // optional custom description
  discount_in_percent?: string | null;
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
