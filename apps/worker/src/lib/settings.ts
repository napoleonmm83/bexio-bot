// Runtime settings for a worker run. Resolution order: DB app_settings → env →
// hardcoded default. Loaded ONCE per runDaily and threaded into the pipeline, so
// a value changed on the /settings web page takes effect on the next run without
// a redeploy. When app_settings is empty every value falls back to env/default,
// i.e. behaviour is identical to before the settings table existed.

import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { getSettings } from '@bexio-bot/db';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PostgresJsDatabase<any>;

// Canonical default invoice-mail templates. {document_nr} is rendered per invoice.
// The message MUST keep the literal [Network Link] token — bexio's /send returns
// 422 without it (the worker also appends it defensively, see bexio-client).
export const DEFAULT_MAIL_SUBJECT = 'Rechnung {document_nr}';
export const DEFAULT_MAIL_MESSAGE = [
  'Sehr geehrte Damen und Herren',
  '',
  'Im Anhang finden Sie unsere Rechnung {document_nr}.',
  'Die Rechnung können Sie auch online einsehen: [Network Link]',
  '',
  'Bei Fragen stehen wir Ihnen gerne zur Verfügung.',
  '',
  'Freundliche Grüsse',
].join('\n');

export const DEFAULT_DASHBOARD_URL = 'https://bexio-bot.martini.digital';

export type WorkerSettings = {
  /** Catch-up tolerance (days) for the recurring-order due-gate. */
  dueWindowDays: number;
  /** Invoice e-mail subject template ({document_nr}). */
  mailSubject: string;
  /** Invoice e-mail body template ({document_nr}); must contain [Network Link]. */
  mailMessage: string;
  /** When false, invoices are created as drafts (not issued/sent) for manual
   *  handling in bexio. Default true = create → issue → send automatically. */
  autoSend: boolean;
  /** Master switch for run notifications (Discord). */
  notificationsEnabled: boolean;
  /** Discord webhook URL, or undefined when no channel is configured. */
  discordWebhookUrl: string | undefined;
  /** Deep-link base used in notification embeds. */
  dashboardUrl: string;
};

const SETTING_KEYS = [
  'order_due_window_days',
  'invoice_mail_subject',
  'invoice_mail_message',
  'auto_send_invoices',
  'notifications_enabled',
  'discord_webhook_url',
  'dashboard_url',
];

function parseWindowDays(raw: string | undefined): number {
  const n = Number(raw ?? '3');
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw === '') return fallback;
  return raw === 'true' || raw === '1' || raw === 'on';
}

function nonEmpty(raw: string | undefined): string | undefined {
  return raw != null && raw.trim() !== '' ? raw : undefined;
}

/**
 * Load all worker-relevant settings, applying DB → env → default fallback.
 */
export async function loadWorkerSettings(db: Db): Promise<WorkerSettings> {
  const s = await getSettings(db, SETTING_KEYS);
  return {
    dueWindowDays: parseWindowDays(s.order_due_window_days ?? process.env.ORDER_DUE_WINDOW_DAYS),
    mailSubject: nonEmpty(s.invoice_mail_subject) ?? DEFAULT_MAIL_SUBJECT,
    mailMessage: nonEmpty(s.invoice_mail_message) ?? DEFAULT_MAIL_MESSAGE,
    autoSend: parseBool(s.auto_send_invoices ?? process.env.AUTO_SEND_INVOICES, true),
    notificationsEnabled: parseBool(s.notifications_enabled ?? process.env.NOTIFICATIONS_ENABLED, true),
    discordWebhookUrl: nonEmpty(s.discord_webhook_url) ?? nonEmpty(process.env.DISCORD_WEBHOOK_URL),
    dashboardUrl:
      nonEmpty(s.dashboard_url) ?? nonEmpty(process.env.DASHBOARD_URL) ?? DEFAULT_DASHBOARD_URL,
  };
}
