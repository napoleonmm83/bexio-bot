<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageData, ActionData } from './$types.ts';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  const dtCH = new Intl.DateTimeFormat('de-CH', {
    timeZone: 'Europe/Zurich',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  function fmt(d: Date | string | null | undefined): string {
    if (!d) return '—';
    return dtCH.format(typeof d === 'string' ? new Date(d) : d);
  }

  function statusCls(s: string): string {
    if (s === 'success') return 'ok';
    if (s === 'failed') return 'err';
    if (s === 'pending') return 'warn';
    return 'muted';
  }
</script>

<svelte:head><title>Abrechnungs-Historie · bexio-bot</title></svelte:head>

<main class="page">
  <p class="back"><a href="/">← Dashboard</a></p>
  <h1>Abrechnungs-Historie</h1>

  {#if form?.error}<p class="banner err">⚠ {form.error}</p>{/if}
  {#if form?.result}
    {@const r = form.result}
    <p class="banner {r.kind === 'sent' ? 'ok' : r.kind === 'failed' ? 'err' : 'warn'}">
      Retry: <strong>{r.kind}</strong>
      {#if r.kind === 'sent'} — bexio #{r.invoiceId} · CHF {r.amount}{/if}
      {#if r.kind === 'failed'} — {r.reason}{/if}
    </p>
  {/if}

  {#if data.runs.length === 0}
    <p class="empty">Noch keine Läufe.</p>
  {:else}
    <table class="data-table">
      <thead>
        <tr>
          <th>Erstellt</th>
          <th>Abo</th>
          <th>geplant für</th>
          <th>ausgeführt</th>
          <th>Status</th>
          <th>bexio</th>
          <th>Fehler</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each data.runs as r (r.id)}
          <tr>
            <td>{fmt(r.createdAt)}</td>
            <td><a href="/subscriptions/{r.subscriptionId}">{r.subscriptionName ?? `#${r.subscriptionId}`}</a></td>
            <td>{fmt(r.scheduledFor)}</td>
            <td>{fmt(r.executedAt)}</td>
            <td><span class="badge {statusCls(r.status)}">{r.status}</span></td>
            <td>{r.bexioInvoiceId ? `#${r.bexioInvoiceId}` : '—'}</td>
            <td>
              {#if r.errorJsonb}
                <details>
                  <summary>Details</summary>
                  <pre>{JSON.stringify(r.errorJsonb, null, 2)}</pre>
                </details>
              {:else}—{/if}
            </td>
            <td>
              {#if r.status === 'failed'}
                <form method="POST" action="?/retry" use:enhance>
                  <input type="hidden" name="subscription_id" value={r.subscriptionId} />
                  <button class="btn-secondary">Retry</button>
                </form>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</main>

<style>
  .page { padding: 1.5rem; max-width: 1200px; margin: 0 auto; }
  .back { margin-bottom: 0.5rem; }
  .banner { padding: 0.75rem; border-radius: 4px; margin: 1rem 0; }
  .banner.ok { background: rgba(34, 197, 94, 0.12); color: #166534; }
  .banner.err { background: rgba(239, 68, 68, 0.12); color: #991b1b; }
  .banner.warn { background: rgba(245, 158, 11, 0.12); color: #92400e; }
  .empty { color: var(--text-3, #6b7484); font-style: italic; padding: 2rem 0; }
  .badge { padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.85rem; }
  .badge.ok { background: rgba(34, 197, 94, 0.15); color: #166534; }
  .badge.warn { background: rgba(245, 158, 11, 0.15); color: #92400e; }
  .badge.err { background: rgba(239, 68, 68, 0.15); color: #991b1b; }
  .badge.muted { background: rgba(107, 116, 132, 0.15); color: #4b5563; }
  .btn-secondary {
    padding: 0.35rem 0.7rem;
    border: 1px solid var(--border, #d1d5db);
    border-radius: 4px;
    background: transparent;
    cursor: pointer;
    font: inherit;
    color: inherit;
  }
  .data-table { width: 100%; border-collapse: collapse; }
  .data-table th, .data-table td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid var(--border, #e5e7eb); vertical-align: top; }
  .data-table th { font-weight: 500; font-size: 0.85rem; color: var(--text-3, #6b7484); }
  details summary { cursor: pointer; }
  details pre { font-size: 0.8rem; background: var(--bg-2, #f3f4f6); padding: 0.5rem; border-radius: 4px; overflow: auto; max-width: 360px; }
</style>
