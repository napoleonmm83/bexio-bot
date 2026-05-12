<script lang="ts">
  import { page } from '$app/state';
  import type { PageData } from './$types.ts';

  let { data }: { data: PageData } = $props();

  const dtCH = new Intl.DateTimeFormat('de-CH', {
    timeZone: 'Europe/Zurich',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  function fmtDate(d: Date | string | null): string {
    if (!d) return '—';
    return dtCH.format(typeof d === 'string' ? new Date(d) : d);
  }

  function statusBadge(s: string): { label: string; cls: string } {
    if (s === 'active') return { label: 'aktiv', cls: 'ok' };
    if (s === 'paused') return { label: 'pausiert', cls: 'warn' };
    return { label: 'gekündigt', cls: 'muted' };
  }

  function intervalLabel(i: string): string {
    if (i === 'monthly') return 'monatlich';
    if (i === 'yearly') return 'jährlich';
    return i;
  }

  const VALID_FILTERS = ['alle', 'active', 'paused', 'cancelled'] as const;
  type Filter = (typeof VALID_FILTERS)[number];
  const initialFilter = (() => {
    const q = page.url.searchParams.get('filter');
    return q && (VALID_FILTERS as readonly string[]).includes(q) ? (q as Filter) : 'alle';
  })();
  let filter = $state<Filter>(initialFilter);

  const filtered = $derived(
    data.subscriptions.filter((s) => filter === 'alle' || s.status === filter),
  );

  const counts = $derived({
    alle: data.subscriptions.length,
    active: data.subscriptions.filter((s) => s.status === 'active').length,
    paused: data.subscriptions.filter((s) => s.status === 'paused').length,
    cancelled: data.subscriptions.filter((s) => s.status === 'cancelled').length,
  });
</script>

<svelte:head><title>Abonnements · bexio-bot</title></svelte:head>

<main class="page">
  <p class="back"><a href="/">← Dashboard</a></p>
  <header>
    <h1>Abonnements</h1>
    <a class="btn-primary" href="/subscriptions/new">+ Neues Abo</a>
  </header>

  <nav class="chips">
    {#each VALID_FILTERS as f}
      <button class:active={filter === f} onclick={() => (filter = f)} type="button">
        {f === 'alle' ? 'Alle' : f === 'active' ? 'Aktiv' : f === 'paused' ? 'Pausiert' : 'Gekündigt'}
        <span class="count">{counts[f]}</span>
      </button>
    {/each}
  </nav>

  {#if filtered.length === 0}
    <p class="empty">Keine Abonnements in dieser Ansicht.</p>
  {:else}
    <table class="data-table">
      <thead>
        <tr>
          <th>Name</th>
          <th>Kontakt</th>
          <th>Intervall</th>
          <th>Nächste Fälligkeit</th>
          <th>Status</th>
          <th>Letzter Lauf</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each filtered as s (s.id)}
          {@const badge = statusBadge(s.status)}
          <tr>
            <td><a href="/subscriptions/{s.id}">{s.name}</a></td>
            <td>#{s.bexioContactId}</td>
            <td>{intervalLabel(s.interval)}</td>
            <td>{fmtDate(s.nextBillingDate)}</td>
            <td><span class="badge {badge.cls}">{badge.label}</span></td>
            <td>
              {#if s.lastRun}
                {s.lastRun.status} · {fmtDate(s.lastRun.executed_at)}
              {:else}
                —
              {/if}
            </td>
            <td><a href="/subscriptions/{s.id}" class="link">Details →</a></td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</main>

<style>
  .page { padding: 1.5rem; max-width: 1100px; margin: 0 auto; }
  .back { margin-bottom: 0.5rem; }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
  .chips { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .chips button {
    padding: 0.4rem 0.8rem;
    border-radius: 999px;
    border: 1px solid var(--border, #d1d5db);
    background: transparent;
    cursor: pointer;
    font: inherit;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .chips button.active {
    background: var(--accent, #4f8cff);
    color: white;
    border-color: var(--accent, #4f8cff);
  }
  .chips .count {
    font-size: 0.8rem;
    opacity: 0.7;
  }
  .empty { color: var(--text-3, #6b7484); font-style: italic; padding: 2rem 0; }
  .btn-primary {
    padding: 0.5rem 1rem;
    border-radius: 6px;
    background: var(--accent, #4f8cff);
    color: white;
    text-decoration: none;
  }
  .link { color: var(--accent, #4f8cff); }
  .badge { padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.85rem; }
  .badge.ok { background: rgba(34, 197, 94, 0.15); color: #166534; }
  .badge.warn { background: rgba(245, 158, 11, 0.15); color: #92400e; }
  .badge.muted { background: rgba(107, 116, 132, 0.15); color: #4b5563; }
  .data-table { width: 100%; border-collapse: collapse; }
  .data-table th, .data-table td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid var(--border, #e5e7eb); }
  .data-table th { font-weight: 500; font-size: 0.85rem; color: var(--text-3, #6b7484); }
</style>
