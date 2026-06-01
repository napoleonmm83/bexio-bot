<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageData, ActionData } from './$types.ts';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const fmtExpiry = (iso: string | null): string => {
    if (!iso) return 'unbekannt';
    return new Intl.DateTimeFormat('de-CH', {
      timeZone: 'Europe/Zurich',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(iso));
  };

  const expired = $derived(
    data.oauth.expiresAt ? new Date(data.oauth.expiresAt).getTime() < Date.now() : false,
  );

  // Per-section feedback from the form action result.
  const msgFor = (section: string) =>
    form?.section === section
      ? form.success
        ? { kind: 'ok' as const, text: 'Gespeichert.' }
        : { kind: 'err' as const, text: form.error ?? 'Fehler beim Speichern.' }
      : null;
</script>

<div class="page">
  <header class="topbar">
    <div class="product">bexio-bot<span class="dot">.</span></div>
    <div class="meta">Einstellungen</div>
  </header>

  <div class="intro">
    <h1>Einstellungen</h1>
    <p>Werden im gemeinsamen Postgres gespeichert; der Worker liest sie beim nächsten Lauf
      (mit Env-Fallback). Secrets bleiben Deploy-Zeit-Konfiguration und sind hier nicht editierbar.</p>
  </div>

  <!-- ── A · Verbindung & Status (read-only) ────────────────────── -->
  <section class="card">
    <h2>Verbindung &amp; Status</h2>
    <div class="kv">
      <span class="k">bexio-Verbindung</span>
      <span class="v">
        {#if data.oauth.connected}
          <span class="badge">Verbunden</span>
        {:else}
          <span class="badge err">Nicht verbunden</span>
        {/if}
      </span>
    </div>
    <div class="kv">
      <span class="k">Access-Token gültig bis</span>
      <span class="v mono">
        {fmtExpiry(data.oauth.expiresAt)}
        {#if expired}<span class="badge warn">abgelaufen — wird beim nächsten Lauf erneuert</span>{/if}
      </span>
    </div>
    <div class="actions">
      <a class="btn" href="/auth/bexio">bexio neu verbinden</a>
    </div>
  </section>

  <!-- ── B · Benachrichtigungen ─────────────────────────────────── -->
  <section class="card">
    <h2>Benachrichtigungen</h2>
    <form method="POST" action="?/notifications" use:enhance>
      <label class="check">
        <input type="checkbox" name="notifications_enabled" value="true"
               checked={data.values.notifications_enabled === 'true'} />
        <span>Benachrichtigungen aktiv (Discord)</span>
      </label>

      <div class="field">
        <label for="discord_webhook_url">Discord Webhook URL</label>
        <input id="discord_webhook_url" name="discord_webhook_url" type="text" autocomplete="off"
               placeholder={data.webhookSet ? '•••••••••••• (gesetzt — leer lassen zum Behalten)' : 'https://discord.com/api/webhooks/…'} />
        <p class="help">Wird maskiert. Leer lassen behält den gespeicherten Wert. https:// erforderlich.</p>
      </div>

      <div class="field">
        <label for="dashboard_url">Dashboard-Link (für Notification-Deep-Links)</label>
        <input id="dashboard_url" name="dashboard_url" type="url"
               value={data.values.dashboard_url} placeholder="https://bexio-bot.martini.digital" />
      </div>

      {#if msgFor('notifications')}<p class="msg {msgFor('notifications')?.kind}">{msgFor('notifications')?.text}</p>{/if}
      <div class="actions"><button class="btn primary" type="submit">Speichern</button></div>
    </form>
  </section>

  <!-- ── C · Rechnungsstellung ──────────────────────────────────── -->
  <section class="card">
    <h2>Rechnungsstellung</h2>
    <form method="POST" action="?/invoicing" use:enhance>
      <div class="field narrow">
        <label for="order_due_window_days">Fälligkeits-Toleranz (Tage)</label>
        <input id="order_due_window_days" name="order_due_window_days" type="number" min="0" step="1"
               value={data.values.order_due_window_days} />
        <p class="help">Wie viele Tage nach dem geplanten Termin ein Auftrag noch nachgeholt wird
          (deckt einen verpassten Lauf ab). Rechnet nie ältere Perioden nach.</p>
      </div>

      <div class="field">
        <label for="invoice_mail_subject">Rechnungs-E-Mail · Betreff</label>
        <input id="invoice_mail_subject" name="invoice_mail_subject" type="text"
               value={data.values.invoice_mail_subject} />
        <p class="help">Platzhalter: <code>{'{document_nr}'}</code></p>
      </div>

      <div class="field">
        <label for="invoice_mail_message">Rechnungs-E-Mail · Text</label>
        <textarea id="invoice_mail_message" name="invoice_mail_message" rows="9">{data.values.invoice_mail_message}</textarea>
        <p class="help">Muss <code>[Network Link]</code> enthalten (bexio ersetzt es durch den Rechnungslink).
          Platzhalter: <code>{'{document_nr}'}</code></p>
      </div>

      {#if msgFor('invoicing')}<p class="msg {msgFor('invoicing')?.kind}">{msgFor('invoicing')?.text}</p>{/if}
      <div class="actions"><button class="btn primary" type="submit">Speichern</button></div>
    </form>
  </section>

  <!-- ── D · Import & Erweitert ─────────────────────────────────── -->
  <section class="card">
    <h2>Import &amp; Erweitert</h2>
    <form method="POST" action="?/advanced" use:enhance>
      <label class="check">
        <input type="checkbox" name="import_auto_enable" value="true"
               checked={data.values.import_auto_enable === 'true'} />
        <span>Neu importierte Aufträge automatisch aktivieren</span>
      </label>
      <p class="help indent">Gilt nur für den manuellen Einzel-Import. Auto-Discovery (Sync) landet
        immer deaktiviert — ein fremder bexio-Auftrag beginnt nie still abzurechnen.</p>

      <label class="check">
        <input type="checkbox" name="incremental_sync_enabled" value="true"
               checked={data.values.incremental_sync_enabled === 'true'} />
        <span>Häufige Auftrags-Synchronisation (Inkrement alle ~2h)</span>
      </label>
      <p class="help indent">Neue/geänderte bexio-Aufträge tauchen innerhalb von Stunden statt 24h auf.</p>

      <div class="field narrow">
        <label for="run_stale_minutes">Lauf gilt als hängen nach (Minuten)</label>
        <input id="run_stale_minutes" name="run_stale_minutes" type="number" min="1" step="1"
               value={data.values.run_stale_minutes} />
      </div>

      <div class="kv">
        <span class="k">Cron-Zeitplan (read-only)</span>
        <span class="v mono">Billing 08:00 Europe/Zurich · Inkrement-Sync alle 2h — geändert wird er in Coolify</span>
      </div>

      {#if msgFor('advanced')}<p class="msg {msgFor('advanced')?.kind}">{msgFor('advanced')?.text}</p>{/if}
      <div class="actions"><button class="btn primary" type="submit">Speichern</button></div>
    </form>
  </section>

  <footer class="footer">
    <a href="/">← Dashboard</a>
    <span class="sep">·</span>
    <a href="/runs">Lauf-Historie</a>
    <span class="sep">·</span>
    <a href="/orders/import">Import</a>
    <span class="sep">·</span>
    <span>v0.1.0</span>
  </footer>
</div>

<style>
  .intro { margin: 28px 0 24px; }
  .intro h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 6px; }
  .intro p { color: var(--text-2); font-size: 13px; max-width: 64ch; margin: 0; }

  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 20px 22px; margin-bottom: 20px;
  }
  .card h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em;
    font-weight: 500; color: var(--text-3); margin: 0 0 16px;
  }

  .field { margin-bottom: 16px; }
  .field.narrow { max-width: 240px; }
  .field label { display: block; font-size: 13px; color: var(--text-2); margin-bottom: 6px; }

  input[type="text"], input[type="url"], input[type="number"], textarea {
    width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
    color: var(--text); font-family: var(--sans); font-size: 13px; padding: 9px 11px;
    transition: border-color 120ms;
  }
  textarea { font-family: var(--mono); font-size: 12px; line-height: 1.6; resize: vertical; }
  input:focus, textarea:focus { outline: none; border-color: var(--accent); }
  input::placeholder { color: var(--text-3); }

  .check {
    display: flex; align-items: center; gap: 10px; cursor: pointer;
    font-size: 14px; color: var(--text); margin-bottom: 4px;
  }
  .check input { width: 16px; height: 16px; accent-color: var(--accent); cursor: pointer; }

  .help { color: var(--text-3); font-size: 12px; margin: 6px 0 0; max-width: 70ch; }
  .help.indent { margin: 4px 0 16px 26px; }
  .help code, .field code {
    font-family: var(--mono); font-size: 11px; color: var(--text-2);
    background: var(--surface-2); padding: 1px 4px; border-radius: 3px;
  }

  .kv {
    display: flex; justify-content: space-between; gap: 16px; align-items: baseline;
    padding: 10px 0; border-bottom: 1px solid var(--border);
  }
  .kv:last-of-type { border-bottom: none; }
  .kv .k { color: var(--text-2); font-size: 13px; }
  .kv .v { color: var(--text); font-size: 13px; text-align: right; }
  .kv .v.mono { font-family: var(--mono); font-size: 12px; }

  .actions { margin-top: 16px; display: flex; gap: 10px; align-items: center; }
  .btn {
    display: inline-flex; align-items: center; height: 34px; padding: 0 16px;
    border: 1px solid var(--border); background: transparent; color: var(--text-2);
    font-family: var(--sans); font-size: 13px; border-radius: 4px; cursor: pointer;
    transition: border-color 120ms, color 120ms, background 120ms;
  }
  .btn:hover { border-color: var(--text-3); color: var(--text); text-decoration: none; }
  .btn.primary { border-color: var(--accent); color: var(--accent); }
  .btn.primary:hover { background: rgba(79, 140, 255, 0.08); }

  .badge {
    display: inline-flex; align-items: center; gap: 5px;
    font-family: var(--mono); font-size: 11px; color: var(--ok);
  }
  .badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
  .badge.warn { color: var(--warn); } .badge.warn::before { background: var(--warn); }
  .badge.err { color: var(--err); } .badge.err::before { background: var(--err); }

  .msg { font-size: 13px; margin: 4px 0 0; font-family: var(--mono); }
  .msg.ok { color: var(--ok); }
  .msg.err { color: var(--err); }
</style>
