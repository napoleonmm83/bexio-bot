// Settings page. Reads/writes the app_settings key/value store (shared Postgres),
// which the worker reads at runtime via getSetting() with an env fallback. Secrets
// (DATABASE_URL, BEXIO_CLIENT_SECRET, CF_ACCESS_*, …) are NEVER editable here.
// OAuth status is read-only from the `secrets` table.

import { fail } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types.ts';
import { getDb, appSettings, secrets, setSetting } from '@bexio-bot/db';
import {
  DEFAULT_MAIL_SUBJECT,
  DEFAULT_MAIL_MESSAGE,
  DEFAULT_DASHBOARD_URL,
} from '@bexio-bot/worker/settings';

const WEBHOOK_MASK = '••••••••••••';

// Explicit shape so PageData carries named keys (the template reads each one).
type SettingsValues = {
  order_due_window_days: string;
  invoice_mail_subject: string;
  invoice_mail_message: string;
  auto_send_invoices: string;
  notifications_enabled: string;
  discord_webhook_url: string;
  dashboard_url: string;
  import_auto_enable: string;
  incremental_sync_enabled: string;
  run_stale_minutes: string;
};

// Display defaults shown when a key has never been saved. The worker applies the
// same fallbacks at runtime (apps/worker/src/lib/settings.ts) — keep in sync.
const DEFAULTS: Record<string, string> = {
  order_due_window_days: '3',
  invoice_mail_subject: DEFAULT_MAIL_SUBJECT,
  invoice_mail_message: DEFAULT_MAIL_MESSAGE,
  auto_send_invoices: 'true',
  notifications_enabled: 'true',
  discord_webhook_url: '',
  dashboard_url: DEFAULT_DASHBOARD_URL,
  import_auto_enable: 'false',
  incremental_sync_enabled: 'true',
  run_stale_minutes: '120',
};

export const load: PageServerLoad = async () => {
  const db = getDb();

  const rows = await db.select().from(appSettings);
  const stored: Record<string, string> = {};
  for (const r of rows) stored[r.key] = r.value;
  const values: Record<string, string> = { ...DEFAULTS, ...stored };

  // OAuth status — read-only, never expose token values.
  let oauth: { connected: boolean; expiresAt: string | null } = { connected: false, expiresAt: null };
  try {
    const sec = await db.select().from(secrets);
    const refresh = sec.find((s) => s.key === 'bexio_refresh_token');
    const access = sec.find((s) => s.key === 'bexio_access_token');
    oauth = {
      connected: Boolean(refresh),
      expiresAt: access?.expiresAt ? new Date(access.expiresAt).toISOString() : null,
    };
  } catch {
    // surfaced as "unbekannt" in the UI
  }

  const webhookSet = Boolean(values.discord_webhook_url);

  // Never send the real webhook to the client — mask it. Built with named keys
  // so PageData['values'] is the explicit SettingsValues shape.
  const display: SettingsValues = {
    order_due_window_days: values.order_due_window_days,
    invoice_mail_subject: values.invoice_mail_subject,
    invoice_mail_message: values.invoice_mail_message,
    auto_send_invoices: values.auto_send_invoices,
    notifications_enabled: values.notifications_enabled,
    discord_webhook_url: webhookSet ? WEBHOOK_MASK : '',
    dashboard_url: values.dashboard_url,
    import_auto_enable: values.import_auto_enable,
    incremental_sync_enabled: values.incremental_sync_enabled,
    run_stale_minutes: values.run_stale_minutes,
  };

  return { oauth, webhookSet, values: display };
};

function boolField(v: FormDataEntryValue | null): string {
  return v === 'true' || v === 'on' || v === '1' ? 'true' : 'false';
}

export const actions: Actions = {
  // Group B — Benachrichtigungen
  notifications: async ({ request }) => {
    const db = getDb();
    const data = await request.formData();

    const dashboard = String(data.get('dashboard_url') ?? '').trim() || DEFAULT_DASHBOARD_URL;
    if (!/^https?:\/\/.+/.test(dashboard)) {
      return fail(400, { section: 'notifications', error: 'Dashboard-Link muss mit http(s):// beginnen.' });
    }

    await setSetting(db, 'notifications_enabled', boolField(data.get('notifications_enabled')));
    await setSetting(db, 'dashboard_url', dashboard);

    // Write-only masked field: only overwrite when the user typed a real value.
    const webhook = String(data.get('discord_webhook_url') ?? '').trim();
    if (webhook && webhook !== WEBHOOK_MASK) {
      if (!/^https:\/\/.+/.test(webhook)) {
        return fail(400, { section: 'notifications', error: 'Webhook-URL muss mit https:// beginnen.' });
      }
      await setSetting(db, 'discord_webhook_url', webhook);
    }

    return { section: 'notifications', success: true };
  },

  // Group C — Rechnungsstellung
  invoicing: async ({ request }) => {
    const db = getDb();
    const data = await request.formData();

    const subject = String(data.get('invoice_mail_subject') ?? '').trim();
    const message = String(data.get('invoice_mail_message') ?? '');
    const due = Number(String(data.get('order_due_window_days') ?? '').trim());

    if (!subject) {
      return fail(400, { section: 'invoicing', error: 'Betreff darf nicht leer sein.' });
    }
    if (!message.includes('[Network Link]')) {
      return fail(400, {
        section: 'invoicing',
        error: 'Der E-Mail-Text muss den Platzhalter [Network Link] enthalten — bexio /send verweigert sonst (422).',
      });
    }
    if (!Number.isInteger(due) || due < 0) {
      return fail(400, { section: 'invoicing', error: 'Fälligkeits-Toleranz muss eine ganze Zahl ≥ 0 sein.' });
    }

    await setSetting(db, 'invoice_mail_subject', subject);
    await setSetting(db, 'invoice_mail_message', message);
    await setSetting(db, 'order_due_window_days', String(due));
    await setSetting(db, 'auto_send_invoices', boolField(data.get('auto_send_invoices')));

    return { section: 'invoicing', success: true };
  },

  // Group D — Import & Erweitert
  advanced: async ({ request }) => {
    const db = getDb();
    const data = await request.formData();

    const stale = Number(String(data.get('run_stale_minutes') ?? '').trim());
    if (!Number.isInteger(stale) || stale < 1) {
      return fail(400, { section: 'advanced', error: 'Stale-Minuten muss eine ganze Zahl ≥ 1 sein.' });
    }

    await setSetting(db, 'import_auto_enable', boolField(data.get('import_auto_enable')));
    await setSetting(db, 'incremental_sync_enabled', boolField(data.get('incremental_sync_enabled')));
    await setSetting(db, 'run_stale_minutes', String(stale));

    return { section: 'advanced', success: true };
  },
};
