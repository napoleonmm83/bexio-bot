<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageData } from './$types.ts';

  let { data }: { data: PageData } = $props();

  function formatTime(d: Date | string | null | undefined): string {
    if (!d) return '—';
    const date = typeof d === 'string' ? new Date(d) : d;
    return new Intl.DateTimeFormat('de-CH', {
      timeZone: 'Europe/Zurich',
      day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).format(date);
  }

  function formatAmount(amount: string | null | undefined): string {
    if (!amount) return '—';
    const n = parseFloat(amount);
    if (!Number.isFinite(n)) return amount;
    return new Intl.NumberFormat('de-CH', {
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    }).format(n);
  }

  function timeSince(d: Date | string | null | undefined): string {
    if (!d) return '—';
    const date = typeof d === 'string' ? new Date(d) : d;
    const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
    if (seconds < 60) return `vor ${seconds}s`;
    if (seconds < 3600) return `vor ${Math.floor(seconds / 60)}min`;
    if (seconds < 86400) return `vor ${Math.floor(seconds / 3600)}h`;
    return `vor ${Math.floor(seconds / 86400)}d`;
  }

  function formatDate(d: Date | string | null | undefined): string {
    if (!d) return '—';
    const date = typeof d === 'string' ? new Date(d) : d;
    return new Intl.DateTimeFormat('de-CH', {
      timeZone: 'Europe/Zurich',
      day: '2-digit', month: '2-digit', year: 'numeric',
    }).format(date);
  }

  function daysUntil(d: Date | string | null | undefined): string {
    if (!d) return '—';
    const date = typeof d === 'string' ? new Date(d) : d;
    const days = Math.ceil((date.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
    if (days < 0) return `${Math.abs(days)}d überfällig`;
    if (days === 0) return 'heute';
    if (days === 1) return 'morgen';
    if (days < 7) return `in ${days}d`;
    if (days < 14) return `in ${days}d`;
    if (days < 60) return `in ${Math.round(days / 7)} Wochen`;
    return `in ${Math.round(days / 30)} Monaten`;
  }

  // Status indicator logic
  let statusKind = $derived.by(() => {
    if (!data.lastRun) return 'muted';
    if (data.lastRun.errorsJsonb) return 'err';
    if (!data.lastRun.finishedAt) return 'warn';
    return 'ok';
  });

  let statusText = $derived.by(() => {
    if (!data.lastRun) return 'Noch kein Lauf — Worker ist nie gelaufen';
    if (data.lastRun.errorsJsonb) return 'Letzter Lauf mit Fehlern';
    if (!data.lastRun.finishedAt) return 'Letzter Lauf läuft noch oder ist abgestürzt';
    return `Letzter Lauf erfolgreich ${timeSince(data.lastRun.finishedAt ?? data.lastRun.startedAt)}`;
  });
</script>

<div class="page">
  <header class="topbar">
    <div class="product">bexio-bot<span class="dot">.</span></div>
    <div class="meta">
      {#if data.lastRun?.startedAt}
        letzter Sync {formatTime(data.lastRun.startedAt)}
      {:else}
        kein Sync
      {/if}
      · Cron 08:00 Europe/Zurich
    </div>
  </header>

  <div class="status">
    <span class="indicator {statusKind}"></span>
    <div class="status-text">
      <strong>{statusText}</strong>
      {#if data.lastRun?.finishedAt}
        <span class="secondary"> ·
          {data.lastRun.createdInvoicesCount ?? 0} erstellt,
          {data.lastRun.sentInvoicesCount ?? 0} gesendet,
          {data.lastRun.errorsJsonb ? 'mit Fehlern' : '0 Fehler'}
        </span>
      {/if}
    </div>
  </div>

  <div class="grid-2">
    <section class="section">
      <h2>Heute aktiv</h2>
      {#if data.todayInvoices.length === 0}
        <p class="empty">Heute keine Aktivität. Nächster Cron-Lauf: morgen 08:00.</p>
      {:else}
        <table>
          <thead><tr><th>Auftrag</th><th>Status</th><th>Zeit</th></tr></thead>
          <tbody>
            {#each data.todayInvoices as inv}
              <tr>
                <td class="client">
                  Auftrag #{inv.orderId}
                  <span class="meta-row">bexio-Rechn. {inv.invoiceId ?? '—'} · Periode {inv.billingPeriod}</span>
                </td>
                <td>
                  <span class="badge {inv.status === 'sent' ? '' : inv.status === 'failed' ? 'err' : 'warn'}">
                    {inv.status}
                  </span>
                </td>
                <td class="amount">{formatTime(inv.updatedAt)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </section>

    <section class="section">
      <h2>Fällig · nächste 30 Tage</h2>
      {#if data.dueSoon.length === 0}
        <p class="empty">Keine Aufträge fällig in den nächsten 30 Tagen.</p>
      {:else}
        <table>
          <thead><tr><th>Kunde</th><th>Fällig</th><th>Erwartet</th></tr></thead>
          <tbody>
            {#each data.dueSoon as o}
              <tr>
                <td class="client">
                  {o.customerName}
                  <span class="meta-row">
                    Auftrag #{o.bexioOrderId} · {o.interval} ·
                    {o.enabled ? 'aktiv' : 'noch nicht aktiv'}
                  </span>
                </td>
                <td>
                  <span class="badge {o.enabled ? '' : 'muted'}">{daysUntil(o.nextBillingDate)}</span>
                  <span class="meta-row">{formatDate(o.nextBillingDate)}</span>
                </td>
                <td class="amount">CHF {formatAmount(o.expectedAmount)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </section>
  </div>

  <section class="admin-section">
    <h2>Auftrags-Verwaltung</h2>

    <details class="disclosure" open={data.disabledOrders.length > 0}>
      <summary>
        <span>Verfügbar in bexio · noch nicht aktiv</span>
        <span class="counter">{data.disabledOrders.length}</span>
      </summary>
      <div class="body">
        {#if data.disabledOrders.length === 0}
          <p class="empty">Alle bexio-Recurring-Aufträge sind im Bot-Scope.</p>
        {:else}
          <table>
            <thead><tr><th>Kunde</th><th>Interval</th><th>Nächste Fälligkeit</th><th>Erwartet</th><th></th></tr></thead>
            <tbody>
              {#each data.disabledOrders as o}
                <tr>
                  <td class="client">
                    {o.customerName}
                    <span class="meta-row">Auftrag #{o.bexioOrderId} · Kunde #{o.customerId}</span>
                  </td>
                  <td><span class="badge muted">{o.interval}</span></td>
                  <td>
                    {formatDate(o.nextBillingDate)}
                    <span class="meta-row">{daysUntil(o.nextBillingDate)}</span>
                  </td>
                  <td class="amount">CHF {formatAmount(o.expectedAmount)}</td>
                  <td>
                    <form method="POST" action="?/toggle" use:enhance>
                      <input type="hidden" name="orderId" value={o.bexioOrderId} />
                      <input type="hidden" name="enabled" value="true" />
                      <button class="toggle activate" type="submit">Aktivieren</button>
                    </form>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    </details>

    <details class="disclosure">
      <summary>
        <span>Im Bot-Scope · aktiv</span>
        <span class="counter">{data.enabledOrders.length}</span>
      </summary>
      <div class="body">
        {#if data.enabledOrders.length === 0}
          <p class="empty">Noch nichts aktiviert.</p>
        {:else}
          <table>
            <thead><tr><th>Kunde</th><th>Interval</th><th>Nächste Fälligkeit</th><th>Erwartet</th><th></th></tr></thead>
            <tbody>
              {#each data.enabledOrders as o}
                <tr>
                  <td class="client">
                    {o.customerName}
                    <span class="meta-row">Auftrag #{o.bexioOrderId} · Kunde #{o.customerId}</span>
                  </td>
                  <td><span class="badge">{o.interval}</span></td>
                  <td>
                    {formatDate(o.nextBillingDate)}
                    <span class="meta-row">{daysUntil(o.nextBillingDate)}</span>
                  </td>
                  <td class="amount">CHF {formatAmount(o.expectedAmount)}</td>
                  <td>
                    <form method="POST" action="?/toggle" use:enhance>
                      <input type="hidden" name="orderId" value={o.bexioOrderId} />
                      <input type="hidden" name="enabled" value="false" />
                      <button class="toggle pause" type="submit">Pausieren</button>
                    </form>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    </details>

    <details class="disclosure">
      <summary>
        <span>Archiviert · in bexio erledigt oder storniert</span>
        <span class="counter">{data.archivedOrders.length}</span>
      </summary>
      <div class="body">
        {#if data.archivedOrders.length === 0}
          <p class="empty">Keine archivierten Aufträge.</p>
        {:else}
          <table>
            <thead><tr><th>Kunde</th><th>bexio-Status</th><th>Erwartet</th></tr></thead>
            <tbody>
              {#each data.archivedOrders as o}
                <tr>
                  <td class="client">
                    {o.customerName}
                    <span class="meta-row">Auftrag #{o.bexioOrderId} · Kunde #{o.customerId}</span>
                  </td>
                  <td>
                    <span class="badge {o.bexioStatus === 'canceled' ? 'err' : 'muted'}">
                      {o.bexioStatus === 'canceled' ? 'storniert' : 'erledigt'}
                    </span>
                  </td>
                  <td class="amount">CHF {formatAmount(o.expectedAmount)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          <p class="empty" style="font-size: 12px; padding-top: 12px;">
            Archivierte Aufträge werden vom Bot nicht bearbeitet, auch wenn sie aktiviert wären.
          </p>
        {/if}
      </div>
    </details>
  </section>

  <footer class="footer">
    <a href="/runs">Lauf-Historie</a>
    <span class="sep">·</span>
    <a href="/auth/bexio/reauth">bexio Re-Auth</a>
    <span class="sep">·</span>
    <span>Health <a href="/health" class="health-ok">200</a></span>
    <span class="sep">·</span>
    <span>v0.1.0</span>
  </footer>

  {#if data.errors.length > 0}
    <div style="margin-top: 24px; padding: 16px; border: 1px solid var(--err); color: var(--err); font-family: var(--mono); font-size: 12px;">
      {#each data.errors as err}
        <div>· {err}</div>
      {/each}
    </div>
  {/if}
</div>
