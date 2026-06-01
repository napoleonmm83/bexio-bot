<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageData, ActionData } from './$types.ts';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const INTERVAL_LABEL: Record<string, string> = {
    daily: 'täglich', weekly: 'wöchentlich', monthly: 'monatlich',
    quarterly: 'vierteljährlich', semi_annual: 'halbjährlich', yearly: 'jährlich',
  };
  const STATUS_LABEL: Record<string, string> = {
    open: 'offen', partial: 'teilweise', done: 'erledigt', canceled: 'storniert', unknown: 'unbekannt',
  };

  const fmt = (d: string | Date | null): string => {
    if (!d) return '—';
    return new Intl.DateTimeFormat('de-CH', {
      timeZone: 'Europe/Zurich', day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(new Date(d));
  };
</script>

<div class="page">
  <header class="topbar">
    <div class="product">bexio-bot<span class="dot">.</span></div>
    <div class="meta">Auftrags-Import</div>
  </header>

  <div class="intro">
    <h1>Auftrags-Import</h1>
    <p>Importiert Aufträge aus bexio, ohne einen Abrechnungslauf auszulösen. Auto-Discovery (Sync)
      landet immer deaktiviert; nur der bewusste Einzel-Import darf sofort aktivieren.</p>
  </div>

  <!-- ── Einzel-Import ──────────────────────────────────────────── -->
  <section class="card">
    <h2>Einzel-Auftrag importieren</h2>
    <form method="POST" action="?/importOne" use:enhance>
      <div class="row">
        <div class="field narrow">
          <label for="orderId">bexio Auftrags-ID</label>
          <input id="orderId" name="orderId" type="number" min="1" step="1" placeholder="z.B. 13" required />
        </div>
        <label class="check">
          <input type="checkbox" name="enable" value="true" checked={data.importAutoEnable} />
          <span>Sofort aktivieren</span>
        </label>
        <button class="btn primary" type="submit">Importieren</button>
      </div>
      <p class="help">Holt genau diesen Auftrag + seinen Rechnungszyklus und legt/aktualisiert eine
        Zeile im Cache. „Sofort aktivieren" schaltet ihn direkt scharf (Standard: aus).</p>

      {#if form?.action === 'importOne' && form.success && form.result && 'customerName' in form.result}
        {@const r = form.result}
        <p class="msg ok">
          ✓ {r.customerName} (#{r.bexioOrderId}) {r.wasInsert ? 'importiert' : 'aktualisiert'} ·
          {INTERVAL_LABEL[r.interval] ?? r.interval} ·
          {r.enabled ? 'aktiviert' : 'deaktiviert'}
          {#if r.unsupportedType} · ⚠ Typ „{r.unsupportedType}" wird nicht abgerechnet{/if}
        </p>
      {:else if form?.action === 'importOne' && form?.error}
        <p class="msg err">{form.error}</p>
      {/if}
    </form>
  </section>

  <!-- ── Synchronisation ────────────────────────────────────────── -->
  <section class="card">
    <h2>Synchronisation</h2>
    <div class="kv">
      <span class="k">Letzter Inkrement-Sync</span>
      <span class="v mono">{fmt(data.lastSync)}</span>
    </div>
    <form method="POST" action="?/syncNow" use:enhance>
      <div class="actions">
        <button class="btn primary" type="submit">Jetzt synchronisieren (inkrementell)</button>
      </div>
      <p class="help">Holt in bexio neu erstellte/geänderte Recurring-Aufträge (via <code>updated_at</code>).
        Rechnet nichts ab; neue Aufträge landen deaktiviert. Der Voll-Scan läuft täglich automatisch.</p>

      {#if form?.action === 'syncNow' && form.success && form.result && 'total' in form.result}
        {@const r = form.result}
        <p class="msg ok">
          ✓ {r.total} geprüft · {r.newlyAdded} neu · {r.alreadyTracked} aktualisiert
          {#if r.unsupportedOrders?.length} · ⚠ {r.unsupportedOrders.length} nicht unterstützt{/if}
        </p>
      {:else if form?.action === 'syncNow' && form?.error}
        <p class="msg err">{form.error}</p>
      {/if}
    </form>
  </section>

  <!-- ── Verfolgte Aufträge ─────────────────────────────────────── -->
  <section class="card">
    <h2>Verfolgte Aufträge ({data.orders.length})</h2>
    {#if data.orders.length === 0}
      <p class="help">Noch keine Aufträge im Cache. Importiere einen oben oder starte einen Sync.</p>
    {:else}
      <table>
        <thead>
          <tr><th>#</th><th>Kunde</th><th>Frequenz</th><th>Status</th><th>Aktiv</th><th class="r">Sync</th></tr>
        </thead>
        <tbody>
          {#each data.orders as o (o.bexioOrderId)}
            <tr>
              <td class="mono">{o.bexioOrderId}</td>
              <td>{o.customerName}</td>
              <td>{INTERVAL_LABEL[o.interval] ?? o.interval}</td>
              <td>{STATUS_LABEL[o.bexioStatus] ?? o.bexioStatus}</td>
              <td>{#if o.enabled}<span class="badge">aktiv</span>{:else}<span class="badge muted">pausiert</span>{/if}</td>
              <td class="r mono dim">{fmt(o.syncedAt)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      <p class="help">Aktivieren/Pausieren erfolgt im <a href="/">Dashboard</a>.</p>
    {/if}
  </section>

  <footer class="footer">
    <a href="/">← Dashboard</a>
    <span class="sep">·</span>
    <a href="/settings">Einstellungen</a>
    <span class="sep">·</span>
    <a href="/runs">Lauf-Historie</a>
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

  .row { display: flex; gap: 18px; align-items: flex-end; flex-wrap: wrap; }
  .field { margin-bottom: 0; }
  .field.narrow { max-width: 180px; }
  .field label { display: block; font-size: 13px; color: var(--text-2); margin-bottom: 6px; }

  input[type="number"] {
    width: 100%; background: var(--bg); border: 1px solid var(--border); border-radius: 4px;
    color: var(--text); font-family: var(--sans); font-size: 13px; padding: 9px 11px;
  }
  input:focus { outline: none; border-color: var(--accent); }
  input::placeholder { color: var(--text-3); }

  .check { display: flex; align-items: center; gap: 9px; cursor: pointer; font-size: 14px; color: var(--text); height: 38px; }
  .check input { width: 16px; height: 16px; accent-color: var(--accent); cursor: pointer; }

  .help { color: var(--text-3); font-size: 12px; margin: 12px 0 0; max-width: 72ch; }
  .help code {
    font-family: var(--mono); font-size: 11px; color: var(--text-2);
    background: var(--surface-2); padding: 1px 4px; border-radius: 3px;
  }

  .kv { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; padding: 0 0 14px; }
  .kv .k { color: var(--text-2); font-size: 13px; }
  .kv .v { color: var(--text); font-size: 13px; }
  .kv .v.mono { font-family: var(--mono); font-size: 12px; }

  .actions { margin-top: 4px; }
  .btn {
    display: inline-flex; align-items: center; height: 38px; padding: 0 16px;
    border: 1px solid var(--border); background: transparent; color: var(--text-2);
    font-family: var(--sans); font-size: 13px; border-radius: 4px; cursor: pointer;
    transition: border-color 120ms, color 120ms, background 120ms;
  }
  .btn:hover { border-color: var(--text-3); color: var(--text); }
  .btn.primary { border-color: var(--accent); color: var(--accent); }
  .btn.primary:hover { background: rgba(79, 140, 255, 0.08); }

  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-weight: 400; color: var(--text-3); font-size: 11px;
       text-transform: uppercase; letter-spacing: 0.06em; padding: 0 10px 8px; border-bottom: 1px solid var(--border); }
  td { padding: 9px 10px; border-bottom: 1px solid var(--border); font-size: 13px; vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  .r { text-align: right; }
  .mono { font-family: var(--mono); font-size: 12px; }
  .dim { color: var(--text-3); }

  .badge { display: inline-flex; align-items: center; gap: 5px; font-family: var(--mono); font-size: 11px; color: var(--ok); }
  .badge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: var(--ok); }
  .badge.muted { color: var(--text-3); } .badge.muted::before { background: var(--text-3); }

  .msg { font-size: 13px; margin: 12px 0 0; font-family: var(--mono); }
  .msg.ok { color: var(--ok); }
  .msg.err { color: var(--err); }
</style>
