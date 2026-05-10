<script lang="ts">
  import type { PageData } from './$types.ts';

  let { data }: { data: PageData } = $props();

  function formatDateTime(d: Date | string | null | undefined): string {
    if (!d) return '—';
    const date = typeof d === 'string' ? new Date(d) : d;
    return new Intl.DateTimeFormat('de-CH', {
      timeZone: 'Europe/Zurich',
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    }).format(date);
  }

  function duration(started: Date | string | null | undefined, finished: Date | string | null | undefined): string {
    if (!started || !finished) return '—';
    const ms = new Date(finished).getTime() - new Date(started).getTime();
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${Math.floor(ms / 60000)}min ${Math.floor((ms % 60000) / 1000)}s`;
  }

  function statusBadge(s: string | null | undefined): { label: string; cls: string } {
    if (s === 'sent') return { label: 'gesendet', cls: '' };
    if (s === 'failed') return { label: 'fehler', cls: 'err' };
    if (s === 'issued') return { label: 'festgeschrieben', cls: 'warn' };
    if (s === 'sending') return { label: 'sendet…', cls: 'warn' };
    if (s === 'created') return { label: 'erstellt', cls: 'warn' };
    return { label: s ?? '—', cls: 'muted' };
  }

  function runStatus(run: PageData['runs'][number]): { label: string; cls: string } {
    if (!run.finishedAt) return { label: 'läuft / abgestürzt', cls: 'warn' };
    if (run.errorsJsonb) return { label: 'mit Fehlern', cls: 'err' };
    return { label: 'erfolgreich', cls: '' };
  }
</script>

<div class="page">
  <header class="topbar">
    <div class="product">bexio-bot<span class="dot">.</span></div>
    <div class="meta"><a href="/">← Dashboard</a></div>
  </header>

  <section class="section" style="margin-top: 32px;">
    <h2>Lauf-Historie · letzte 30 Tage</h2>
    {#if data.runs.length === 0}
      <p class="empty">Noch keine Läufe in der DB. Manuell starten mit <code>bun run worker</code> oder warte auf den nächsten Cron um 08:00.</p>
    {:else}
      <table>
        <thead>
          <tr>
            <th>Lauf</th>
            <th>Status</th>
            <th>Erstellt</th>
            <th>Gesendet</th>
            <th>Dauer</th>
            <th>Gestartet</th>
          </tr>
        </thead>
        <tbody>
          {#each data.runs as run}
            {@const status = runStatus(run)}
            <tr>
              <td class="client">
                #{run.id}
                {#if run.notes}
                  <span class="meta-row">{run.notes}</span>
                {/if}
              </td>
              <td><span class="badge {status.cls}">{status.label}</span></td>
              <td class="amount">{run.createdInvoicesCount}</td>
              <td class="amount">{run.sentInvoicesCount}</td>
              <td class="amount">{duration(run.startedAt, run.finishedAt)}</td>
              <td class="amount" style="font-family: var(--mono); font-size: 12px; color: var(--text-3);">
                {formatDateTime(run.startedAt)}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>

  <section class="section" style="margin-top: 40px;">
    <h2>Rechnungs-Historie · letzte 50</h2>
    {#if data.invoices.length === 0}
      <p class="empty">Noch keine Rechnungen vom Bot erstellt.</p>
    {:else}
      <table>
        <thead>
          <tr>
            <th>Kunde / Auftrag</th>
            <th>Periode</th>
            <th>bexio</th>
            <th>Status</th>
            <th>Versuche</th>
            <th>Gesendet</th>
          </tr>
        </thead>
        <tbody>
          {#each data.invoices as inv}
            {@const status = statusBadge(inv.status)}
            <tr>
              <td class="client">
                {inv.customerName ?? `Auftrag #${inv.orderId}`}
                <span class="meta-row">Auftrag #{inv.orderId}</span>
              </td>
              <td><span class="badge muted">{inv.billingPeriod}</span></td>
              <td class="amount" style="font-family: var(--mono); font-size: 12px;">
                {inv.invoiceId ? `#${inv.invoiceId}` : '—'}
              </td>
              <td><span class="badge {status.cls}">{status.label}</span></td>
              <td class="amount">{inv.attempts}</td>
              <td class="amount" style="font-family: var(--mono); font-size: 12px; color: var(--text-3);">
                {formatDateTime(inv.sentAt)}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>

  <footer class="footer">
    <a href="/">Dashboard</a>
    <span class="sep">·</span>
    <a href="/auth/bexio/reauth">bexio Re-Auth</a>
  </footer>

  {#if data.errors.length > 0}
    <div style="margin-top: 24px; padding: 16px; border: 1px solid var(--err); color: var(--err); font-family: var(--mono); font-size: 12px;">
      {#each data.errors as err}
        <div>· {err}</div>
      {/each}
    </div>
  {/if}
</div>
