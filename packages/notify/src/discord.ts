// Discord webhook adapter. Renders four embed types matching DESIGN.md status colors:
//   success — 0x22c55e (--ok)
//   failed  — 0xef4444 (--err)
//   partial — 0xf59e0b (--warn)
//   no-due  — 0x6b7484 (--text-3)
// Plus an optional 'new-orders-available' embed when sync finds orders not yet enabled.
//
// Webhook-only — no bot account, no OAuth. URL goes in DISCORD_WEBHOOK_URL.

const COLOR_OK = 0x22c55e;
const COLOR_WARN = 0xf59e0b;
const COLOR_ERR = 0xef4444;
const COLOR_INFO = 0x4f8cff;
const COLOR_MUTED = 0x6b7484;

type Embed = {
  title?: string;
  url?: string;
  description?: string;
  color?: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
};

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? 'https://bexio-bot.martini.digital';

export type DiscordRunReport = {
  runId: number;
  startedAt: Date;
  finishedAt: Date;
  results: Array<{
    customerName: string;
    kind: 'sent' | 'created_unsent' | 'not_due' | 'skipped_duplicate' | 'skipped_unsupported' | 'failed';
    invoiceId?: number;
    amount?: string;
    billingPeriod?: string;
    reason?: string;
  }>;
  enabledOrders: number;
  errors: Array<{ stage: string; message: string }>;
  newOrders: Array<{ bexioOrderId: number; customerName: string; interval: string }>;
  /** Orders whose frozen billing address diverges from the live contact. */
  driftWarnings?: Array<{ bexioOrderId: number; customerName: string; detail: string }>;
  /** Recurring orders whose bexio repetition type the bot can't process — surfaced
   *  so they aren't silently dropped by the orchestrator (EDGE-8). */
  unsupportedOrders?: Array<{ bexioOrderId: number; customerName: string; bexioType: string }>;
  subscriptionResults: Array<{
    kind: 'sent' | 'skipped_duplicate' | 'failed';
    subscriptionId: number;
    invoiceId?: number;
    amount?: string;
    scheduledFor?: string;
    reason?: string;
  }>;
};

export type DiscordSendResult =
  | { ok: true }
  | { ok: false; status?: number; error: string };

/**
 * Send the daily run report embed(s) to Discord.
 * Fire-and-forget pattern: caller wraps this in Promise.allSettled.
 *
 * Adds a second 'new-orders-available' embed if sync detected new orders.
 */
export async function sendRunReport(
  webhookUrl: string,
  report: DiscordRunReport,
  dashboardUrl: string = DASHBOARD_URL,
): Promise<DiscordSendResult> {
  const embeds: Embed[] = [buildRunEmbed(report)];
  if (report.newOrders.length > 0) {
    embeds.push(buildNewOrdersEmbed(report.newOrders, dashboardUrl));
  }
  return postWebhook(webhookUrl, { embeds });
}

/**
 * One-shot: send an arbitrary message. Used for setup-test and ad-hoc alerts.
 */
export async function sendMessage(webhookUrl: string, content: string): Promise<DiscordSendResult> {
  return postWebhook(webhookUrl, { content });
}

// ── Internal helpers ──────────────────────────────────────────────

const ALLOWED_WEBHOOK_HOSTS = ['discord.com', 'discordapp.com'];

/**
 * Allowlist a Discord webhook URL (SEC-4). The URL is operator-supplied via
 * /settings and the worker POSTs run summaries to it server-side, so an
 * unconstrained host is an SSRF vector (internal services, cloud metadata).
 * Require https + an official Discord host (exact or sub-domain).
 */
export function isAllowedDiscordWebhook(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return ALLOWED_WEBHOOK_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

async function postWebhook(webhookUrl: string, body: unknown): Promise<DiscordSendResult> {
  // Belt-and-suspenders SSRF guard: even if a bad URL slipped past the /settings
  // validation (or was set out-of-band), never POST to a non-Discord host. (SEC-4)
  if (!isAllowedDiscordWebhook(webhookUrl)) {
    return { ok: false, error: 'refusing to POST to non-Discord webhook host (SEC-4)' };
  }
  try {
    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      return { ok: false, status: res.status, error: text.slice(0, 200) };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function buildRunEmbed(r: DiscordRunReport): Embed {
  const sent = r.results.filter((x) => x.kind === 'sent');
  const dup = r.results.filter((x) => x.kind === 'skipped_duplicate');
  const failed = r.results.filter((x) => x.kind === 'failed');
  const notDue = r.results.filter((x) => x.kind === 'not_due');

  const status = pickStatus(r);
  const color = status === 'success' ? COLOR_OK
    : status === 'failed' ? COLOR_ERR
    : status === 'partial' ? COLOR_WARN
    : COLOR_MUTED;

  const durationMs = r.finishedAt.getTime() - r.startedAt.getTime();
  const durationStr = durationMs < 1000 ? `${durationMs}ms` : `${(durationMs / 1000).toFixed(1)}s`;

  const title = pickTitle(status, sent.length, r.results.length, r.enabledOrders);
  const description = pickDescription(status, r);

  const fields: Embed['fields'] = [];
  for (const s of sent.slice(0, 24)) {
    fields.push({
      name: `✓ ${truncate(s.customerName, 64)}`,
      value: s.amount && s.invoiceId ? `CHF ${s.amount} · bexio #${s.invoiceId}` : '(no detail)',
      inline: true,
    });
  }
  for (const d of dup) {
    fields.push({
      name: `↺ ${truncate(d.customerName, 64)}`,
      value: `bereits erstellt für ${d.billingPeriod ?? '(unbekannt)'}`,
      inline: true,
    });
  }
  for (const c of r.results.filter((x) => x.kind === 'created_unsent').slice(0, 12)) {
    fields.push({
      name: `📝 ${truncate(c.customerName, 64)}`,
      value: c.amount && c.invoiceId ? `Entwurf · CHF ${c.amount} · bexio #${c.invoiceId}` : 'Entwurf erstellt (nicht gesendet)',
      inline: true,
    });
  }
  for (const u of r.results.filter((x) => x.kind === 'skipped_unsupported')) {
    fields.push({
      name: `⚠ ${truncate(u.customerName, 64)}`,
      value: u.reason ?? 'unterstütztes Interval',
      inline: false,
    });
  }
  for (const f of failed) {
    fields.push({
      name: `✗ ${truncate(f.customerName, 64)}`,
      value: truncate(f.reason ?? 'unknown error', 256),
      inline: false,
    });
  }
  const subSent = r.subscriptionResults.filter((x) => x.kind === 'sent');
  const subFailed = r.subscriptionResults.filter((x) => x.kind === 'failed');
  if (subSent.length > 0 || subFailed.length > 0) {
    fields.push({
      name: '— Subscriptions —',
      value: ' ',
      inline: false,
    });
    for (const s of subSent.slice(0, 12)) {
      fields.push({
        name: `✓ Abo #${s.subscriptionId}`,
        value: s.amount && s.invoiceId ? `CHF ${s.amount} · bexio #${s.invoiceId}` : '(no detail)',
        inline: true,
      });
    }
    for (const f of subFailed) {
      fields.push({
        name: `✗ Abo #${f.subscriptionId}`,
        value: truncate(f.reason ?? 'unknown', 256),
        inline: false,
      });
    }
  }
  if (status === 'no-due' && notDue.length > 0) {
    fields.push({
      name: 'Nicht fällig',
      value: `${notDue.length} aktive Aufträge — bexio sagt "noch nicht fällig"`,
      inline: false,
    });
  }
  if (r.unsupportedOrders && r.unsupportedOrders.length > 0) {
    fields.push({
      name: '⚠ Nicht unterstützt',
      value: r.unsupportedOrders
        .slice(0, 8)
        .map((u) => `· #${u.bexioOrderId} ${truncate(u.customerName, 32)}: ${u.bexioType}`)
        .join('\n')
        .slice(0, 1024),
      inline: false,
    });
  }
  if (r.driftWarnings && r.driftWarnings.length > 0) {
    fields.push({
      name: '⚠ Adress-Drift',
      value: r.driftWarnings
        .slice(0, 8)
        .map((d) => `· #${d.bexioOrderId} ${truncate(d.customerName, 32)}: ${d.detail}`)
        .join('\n')
        .slice(0, 1024),
      inline: false,
    });
  }
  if (r.errors.length > 0) {
    fields.push({
      name: '⚠ Worker-Fehler',
      value: r.errors.map((e) => `· ${e.stage}: ${e.message}`).slice(0, 5).join('\n').slice(0, 1024),
      inline: false,
    });
  }

  return {
    title,
    description,
    color,
    fields: fields.slice(0, 25), // Discord limit: 25 fields per embed
    footer: { text: `Lauf #${r.runId} · ${formatTime(r.startedAt)} · Dauer ${durationStr}` },
    timestamp: r.startedAt.toISOString(),
  };
}

function buildNewOrdersEmbed(
  newOrders: DiscordRunReport['newOrders'],
  dashboardUrl: string = DASHBOARD_URL,
): Embed {
  const fields: Embed['fields'] = newOrders.slice(0, 24).map((o) => ({
    name: truncate(o.customerName, 64),
    value: `Auftrag #${o.bexioOrderId} · ${o.interval}`,
    inline: true,
  }));

  const dashboardLink = `${dashboardUrl}/?filter=pausiert`;

  return {
    title: `Neue Aufträge in bexio · ${newOrders.length}`,
    url: dashboardLink,
    description: `Sync hat neue Recurring-Aufträge gefunden. [Im Dashboard aktivieren →](${dashboardLink})`,
    color: COLOR_INFO,
    fields,
    footer: { text: 'auto-detected via /kb_order sync' },
  };
}

export function pickStatus(r: DiscordRunReport): 'success' | 'failed' | 'partial' | 'no-due' {
  // B2: run-level errors[] (a thrown processOrder or a crash-recovery reclaim land
  // in errors[] but NOT in results[]) must escalate the headline. Previously errors
  // only mattered when results was empty, so a run with a real error but any sent
  // order was mis-headlined green "Lauf erfolgreich".
  const hasErrors = r.errors.length > 0;
  const failed =
    r.results.filter((x) => x.kind === 'failed').length +
    r.subscriptionResults.filter((x) => x.kind === 'failed').length;
  const sent =
    r.results.filter((x) => x.kind === 'sent' || x.kind === 'created_unsent' || x.kind === 'skipped_duplicate').length +
    r.subscriptionResults.filter((x) => x.kind === 'sent' || x.kind === 'skipped_duplicate').length;
  if ((failed > 0 || hasErrors) && sent > 0) return 'partial';
  if (failed > 0 || hasErrors) return 'failed';
  if (sent > 0) return 'success';
  return 'no-due';
}

function pickTitle(
  status: ReturnType<typeof pickStatus>,
  sentCount: number,
  resultCount: number,
  enabledCount: number,
): string {
  // F-8: title shows ACTUAL new invoices (sentCount). Duplicates are listed
  // as ↺-fields below, not counted as creation.
  if (status === 'success' && sentCount > 0) return `Lauf erfolgreich · ${sentCount} neue Rechnungen`;
  if (status === 'success' && sentCount === 0) {
    return resultCount > 0
      ? 'Lauf erfolgreich · keine neuen Rechnungen (Duplikate übersprungen)'
      : 'Lauf erfolgreich · keine Aufträge fällig';
  }
  if (status === 'failed') return 'Lauf abgebrochen';
  if (status === 'partial') return `Lauf teilweise · ${sentCount} neue Rechnungen, Fehler beachten`;
  if (enabledCount === 0) return 'Lauf erfolgreich · keine Aufträge im Bot-Scope';
  return 'Lauf erfolgreich · keine Aufträge fällig';
}

function pickDescription(status: ReturnType<typeof pickStatus>, r: DiscordRunReport): string {
  if (status === 'success') return 'Alle fälligen Aufträge erstellt, festgeschrieben und gesendet.';
  if (status === 'failed') return 'Lauf wurde abgebrochen — siehe Worker-Fehler unten.';
  if (status === 'partial') return 'Einige Aufträge wurden erfolgreich verarbeitet, andere brauchen manuelles Eingreifen.';
  if (r.enabledOrders === 0) return 'Keine Recurring-Aufträge sind im Bot-Scope. Aktiviere sie im Dashboard.';
  return 'Heute keine Recurring-Rechnungen zu erstellen.';
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function formatTime(d: Date): string {
  const fmt = new Intl.DateTimeFormat('de-CH', {
    timeZone: 'Europe/Zurich',
    hour: '2-digit',
    minute: '2-digit',
  });
  return fmt.format(d);
}
