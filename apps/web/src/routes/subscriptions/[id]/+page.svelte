<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageData, ActionData } from './$types.ts';

  let { data, form }: { data: PageData; form: ActionData } = $props();
  const s = $derived(data.subscription);

  const dtCH = new Intl.DateTimeFormat('de-CH', {
    timeZone: 'Europe/Zurich',
    day: '2-digit', month: '2-digit', year: 'numeric',
  });
  const dtFull = new Intl.DateTimeFormat('de-CH', {
    timeZone: 'Europe/Zurich',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  function fmtDate(d: Date | string | null | undefined): string {
    if (!d) return '—';
    return dtCH.format(typeof d === 'string' ? new Date(d) : d);
  }
  function fmtDateTime(d: Date | string | null | undefined): string {
    if (!d) return '—';
    return dtFull.format(typeof d === 'string' ? new Date(d) : d);
  }

  function statusBadgeCls(st: string): string {
    if (st === 'active' || st === 'success') return 'ok';
    if (st === 'paused' || st === 'pending') return 'warn';
    if (st === 'failed') return 'err';
    return 'muted';
  }

  function intervalLabel(i: string): string {
    if (i === 'monthly') return 'monatlich';
    if (i === 'yearly') return 'jährlich';
    return i;
  }
</script>

<svelte:head><title>{s.name} · bexio-bot</title></svelte:head>

<main class="page">
  <p class="back"><a href="/subscriptions">← Abonnements</a></p>

  <header>
    <h1>{s.name}</h1>
    <span class="badge {statusBadgeCls(s.status)}">{s.status}</span>
  </header>

  {#if form?.runResult}
    {@const r = form.runResult}
    <p class="banner {r.kind === 'sent' ? 'ok' : r.kind === 'failed' ? 'err' : 'warn'}">
      Manueller Lauf: <strong>{r.kind}</strong>
      {#if r.kind === 'sent'} — bexio #{r.invoiceId} · CHF {r.amount}{/if}
      {#if r.kind === 'failed'} — {r.reason}{/if}
    </p>
  {/if}

  <section class="grid">
    <div><strong>bexio-Kontakt</strong><div>#{s.bexioContactId}</div></div>
    <div><strong>Intervall</strong><div>{intervalLabel(s.interval)}</div></div>
    <div><strong>Start</strong><div>{fmtDate(s.startDate)}</div></div>
    <div><strong>Ende</strong><div>{fmtDate(s.endDate)}</div></div>
    <div><strong>Nächste Fälligkeit</strong><div>{fmtDate(s.nextBillingDate)}</div></div>
    <div><strong>Auto-Send</strong><div>{s.autoSend ? 'ja' : 'nein'}</div></div>
  </section>

  <section>
    <h2>Positionen</h2>
    {#if data.items.length === 0}
      <p class="muted">Keine Positionen erfasst.</p>
    {:else}
      <table class="data-table">
        <thead><tr><th>#</th><th>Artikel</th><th>Menge</th></tr></thead>
        <tbody>
          {#each data.items as it}
            <tr><td>{it.positionOrder + 1}</td><td>{it.articleName}</td><td>{it.qty}</td></tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>

  <section class="actions">
    {#if s.status === 'active'}
      <form method="POST" action="?/pause" use:enhance><button class="btn-secondary">Pausieren</button></form>
      <form method="POST" action="?/runNow" use:enhance><button class="btn-primary">Jetzt abrechnen</button></form>
    {:else if s.status === 'paused'}
      <form method="POST" action="?/resume" use:enhance><button class="btn-primary">Fortsetzen</button></form>
    {/if}
    {#if s.status !== 'cancelled'}
      <form
        method="POST"
        action="?/cancel"
        use:enhance
        onsubmit={(e) => { if (!confirm('Wirklich kündigen? Keine weiteren Rechnungen.')) e.preventDefault(); }}
      >
        <button class="btn-danger">Kündigen</button>
      </form>
    {/if}
  </section>

  <section>
    <h2>Lauf-Historie</h2>
    {#if data.runs.length === 0}
      <p class="muted">Noch keine Läufe.</p>
    {:else}
      <table class="data-table">
        <thead>
          <tr><th>geplant für</th><th>ausgeführt</th><th>Status</th><th>bexio-Rechnung</th></tr>
        </thead>
        <tbody>
          {#each data.runs as r}
            <tr>
              <td>{fmtDate(r.scheduledFor)}</td>
              <td>{fmtDateTime(r.executedAt)}</td>
              <td><span class="badge {statusBadgeCls(r.status)}">{r.status}</span></td>
              <td>{r.bexioInvoiceId ? `#${r.bexioInvoiceId}` : '—'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>
</main>

<style>
  .page { padding: 1.5rem; max-width: 920px; margin: 0 auto; }
  .back { margin-bottom: 0.5rem; }
  header { display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 1rem;
    padding: 1rem;
    background: var(--bg-2, #f3f4f6);
    border-radius: 6px;
    margin-bottom: 2rem;
  }
  .grid div div { color: var(--text-3, #6b7484); margin-top: 0.2rem; }
  section { margin-top: 1.5rem; }
  section.actions { display: flex; gap: 0.75rem; }
  .banner { padding: 0.75rem; border-radius: 4px; margin: 1rem 0; }
  .banner.ok { background: rgba(34, 197, 94, 0.12); color: #166534; }
  .banner.err { background: rgba(239, 68, 68, 0.12); color: #991b1b; }
  .banner.warn { background: rgba(245, 158, 11, 0.12); color: #92400e; }
  .badge { padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.85rem; }
  .badge.ok { background: rgba(34, 197, 94, 0.15); color: #166534; }
  .badge.warn { background: rgba(245, 158, 11, 0.15); color: #92400e; }
  .badge.err { background: rgba(239, 68, 68, 0.15); color: #991b1b; }
  .badge.muted { background: rgba(107, 116, 132, 0.15); color: #4b5563; }
  .btn-primary, .btn-secondary, .btn-danger {
    padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; font: inherit;
  }
  .btn-primary { background: var(--accent, #4f8cff); color: white; border: 0; }
  .btn-secondary { background: transparent; border: 1px solid var(--border, #d1d5db); color: inherit; }
  .btn-danger { background: rgba(239, 68, 68, 0.1); border: 1px solid rgba(239, 68, 68, 0.4); color: #991b1b; }
  .data-table { width: 100%; border-collapse: collapse; }
  .data-table th, .data-table td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid var(--border, #e5e7eb); }
  .data-table th { font-weight: 500; font-size: 0.85rem; color: var(--text-3, #6b7484); }
  .muted { color: var(--text-3, #6b7484); font-style: italic; }
</style>
