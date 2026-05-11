<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageData } from './$types.ts';

  let { data }: { data: PageData } = $props();

  // ── formatting helpers ──────────────────────────────────────
  const dtCH = (opts: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat('de-CH', { timeZone: 'Europe/Zurich', ...opts });
  const fmtTime = dtCH({ day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const fmtDate = dtCH({ day: '2-digit', month: '2-digit', year: 'numeric' });
  const fmtMoney = new Intl.NumberFormat('de-CH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function formatTime(d: Date | string | null | undefined): string {
    if (!d) return '—';
    return fmtTime.format(typeof d === 'string' ? new Date(d) : d);
  }
  function formatDate(d: Date | string | null | undefined): string {
    if (!d) return '—';
    return fmtDate.format(typeof d === 'string' ? new Date(d) : d);
  }
  function formatAmount(amount: string | null | undefined): string {
    if (!amount) return '—';
    const n = parseFloat(amount);
    return Number.isFinite(n) ? fmtMoney.format(n) : amount;
  }
  function timeSince(d: Date | string | null | undefined): string {
    if (!d) return '—';
    const date = typeof d === 'string' ? new Date(d) : d;
    const sec = Math.floor((Date.now() - date.getTime()) / 1000);
    if (sec < 60) return `vor ${sec}s`;
    if (sec < 3600) return `vor ${Math.floor(sec / 60)}min`;
    if (sec < 86400) return `vor ${Math.floor(sec / 3600)}h`;
    return `vor ${Math.floor(sec / 86400)}d`;
  }
  function daysUntil(d: Date | string | null | undefined): { label: string; bucket: 'overdue' | 'due-soon' | 'due-later' | 'none' } {
    if (!d) return { label: '—', bucket: 'none' };
    const date = typeof d === 'string' ? new Date(d) : d;
    const days = Math.ceil((date.getTime() - Date.now()) / 86_400_000);
    if (days < 0) return { label: `${Math.abs(days)}d überfällig`, bucket: 'overdue' };
    if (days === 0) return { label: 'heute', bucket: 'due-soon' };
    if (days === 1) return { label: 'morgen', bucket: 'due-soon' };
    if (days < 7) return { label: `in ${days}d`, bucket: 'due-soon' };
    if (days < 14) return { label: `in ${days}d`, bucket: 'due-later' };
    if (days < 60) return { label: `in ${Math.round(days / 7)} Wochen`, bucket: 'due-later' };
    return { label: `in ${Math.round(days / 30)} Monaten`, bucket: 'due-later' };
  }

  const INTERVAL_LABEL: Record<string, string> = {
    daily: 'täglich',
    weekly: 'wöchentlich',
    monthly: 'monatlich',
    quarterly: 'vierteljährlich',
    yearly: 'jährlich',
  };

  // ── derived row enrichment ──────────────────────────────────
  type Row = (typeof data.orders)[number] & {
    _state: 'aktiv' | 'pausiert' | 'erledigt' | 'storniert';
    _due: ReturnType<typeof daysUntil>;
    _amountNum: number;
  };

  const PROCESSABLE = new Set(['open', 'partial']);

  const rows = $derived<Row[]>(
    data.orders.map((o) => {
      const archivedKind = o.bexioStatus === 'canceled' ? 'storniert'
        : (o.bexioStatus === 'done' ? 'erledigt' : null);
      const _state: Row['_state'] = archivedKind ?? (o.enabled ? 'aktiv' : 'pausiert');
      return {
        ...o,
        _state,
        _due: daysUntil(o.nextBillingDate),
        _amountNum: parseFloat(o.expectedAmount ?? '0') || 0,
      } as Row;
    }),
  );

  // ── counts (drive the filter chips) ─────────────────────────
  const counts = $derived({
    alle: rows.length,
    aktiv: rows.filter((r) => r._state === 'aktiv').length,
    pausiert: rows.filter((r) => r._state === 'pausiert').length,
    fällig: rows.filter((r) => PROCESSABLE.has(r.bexioStatus ?? '') && (r._due.bucket === 'overdue' || r._due.bucket === 'due-soon')).length,
    archiv: rows.filter((r) => r._state === 'erledigt' || r._state === 'storniert').length,
  });

  // ── interactive state ───────────────────────────────────────
  type Filter = 'alle' | 'aktiv' | 'pausiert' | 'fällig' | 'archiv';
  type SortKey = 'state' | 'customer' | 'interval' | 'next' | 'amount';
  type SortDir = 'asc' | 'desc';

  let filter = $state<Filter>('aktiv');
  let query = $state('');
  let frequency = $state<string>('alle');
  let sortKey = $state<SortKey>('next');
  let sortDir = $state<SortDir>('asc');

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = key;
      sortDir = key === 'amount' ? 'desc' : 'asc';
    }
  }

  function ariaSortFor(key: SortKey): 'ascending' | 'descending' | 'none' {
    if (sortKey !== key) return 'none';
    return sortDir === 'asc' ? 'ascending' : 'descending';
  }

  // ── filtered + searched + sorted view ───────────────────────
  const visible = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((r) => {
      // chip filter
      if (filter === 'aktiv' && r._state !== 'aktiv') return false;
      if (filter === 'pausiert' && r._state !== 'pausiert') return false;
      if (filter === 'fällig' && !(PROCESSABLE.has(r.bexioStatus ?? '') && (r._due.bucket === 'overdue' || r._due.bucket === 'due-soon'))) return false;
      if (filter === 'archiv' && !(r._state === 'erledigt' || r._state === 'storniert')) return false;
      // frequency filter
      if (frequency !== 'alle' && r.interval !== frequency) return false;
      // free-text search
      if (q) {
        const hay = `${r.customerName ?? ''} ${r.bexioOrderId} ${r.customerId ?? ''} ${r.interval ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const dir = sortDir === 'asc' ? 1 : -1;
    return filtered.sort((a, b) => {
      switch (sortKey) {
        case 'state': return dir * a._state.localeCompare(b._state);
        case 'customer': return dir * (a.customerName ?? '').localeCompare(b.customerName ?? '');
        case 'interval': return dir * (a.interval ?? '').localeCompare(b.interval ?? '');
        case 'amount': return dir * (a._amountNum - b._amountNum);
        case 'next': {
          const av = a.nextBillingDate ? new Date(a.nextBillingDate).getTime() : Number.POSITIVE_INFINITY;
          const bv = b.nextBillingDate ? new Date(b.nextBillingDate).getTime() : Number.POSITIVE_INFINITY;
          return dir * (av - bv);
        }
      }
    });
  });

  const intervalsInData = $derived(
    Array.from(new Set(rows.map((r) => r.interval).filter((x): x is string => !!x))).sort(),
  );

  // ── status banner ───────────────────────────────────────────
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

  // ── keyboard shortcut: "/" focuses search ───────────────────
  let searchEl: HTMLInputElement | undefined = $state();
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    e.preventDefault();
    searchEl?.focus();
    searchEl?.select();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="page">
  <header class="topbar">
    <div class="product">bexio-bot<span class="dot">.</span></div>
    <div class="meta">
      {#if data.lastRun?.startedAt}letzter Sync {formatTime(data.lastRun.startedAt)}{:else}kein Sync{/if}
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

  <!-- ── Filter chips: clickable, drive the table below ── -->
  <div class="chipbar" role="tablist" aria-label="Auftrags-Filter">
    {#each [
      { id: 'aktiv', label: 'Aktiv', count: counts.aktiv, kind: 'ok' },
      { id: 'pausiert', label: 'Pausiert', count: counts.pausiert, kind: 'muted' },
      { id: 'fällig', label: 'Fällig', count: counts.fällig, kind: 'warn' },
      { id: 'archiv', label: 'Archiv', count: counts.archiv, kind: 'muted' },
      { id: 'alle', label: 'Alle', count: counts.alle, kind: 'muted' },
    ] as f}
      <button
        type="button"
        role="tab"
        aria-selected={filter === f.id}
        class="chip {filter === f.id ? 'active' : ''}"
        onclick={() => (filter = f.id as Filter)}
      >
        <span class="chip-dot {f.kind}"></span>
        <span>{f.label}</span>
        <span class="chip-count">{f.count}</span>
      </button>
    {/each}
  </div>

  <!-- ── Toolbar: search + frequency + result count ── -->
  <div class="toolbar">
    <div class="search">
      <span class="search-icon" aria-hidden="true">⌕</span>
      <input
        bind:this={searchEl}
        bind:value={query}
        type="search"
        placeholder='Suche Kunde, Auftrag #, Kunden-ID …  (Drück "/" zum Fokussieren)'
        aria-label="Aufträge durchsuchen"
      />
      {#if query}
        <button type="button" class="clear" onclick={() => (query = '')} aria-label="Suche löschen">×</button>
      {/if}
    </div>

    <select bind:value={frequency} class="freq-select" aria-label="Frequenz-Filter">
      <option value="alle">Alle Frequenzen</option>
      {#each intervalsInData as iv}
        <option value={iv}>{INTERVAL_LABEL[iv] ?? iv}</option>
      {/each}
    </select>

    <span class="result-count">
      {visible.length} von {rows.length}
    </span>
  </div>

  <!-- ── Main orders table ── -->
  <div class="table-wrap">
    <table class="orders">
      <thead>
        <tr>
          <th class="col-state sortable" aria-sort={ariaSortFor('state')}>
            <button type="button" onclick={() => toggleSort('state')}>Status</button>
          </th>
          <th class="col-customer sortable" aria-sort={ariaSortFor('customer')}>
            <button type="button" onclick={() => toggleSort('customer')}>Kunde · Auftrag</button>
          </th>
          <th class="col-interval sortable" aria-sort={ariaSortFor('interval')}>
            <button type="button" onclick={() => toggleSort('interval')}>Frequenz</button>
          </th>
          <th class="col-next sortable" aria-sort={ariaSortFor('next')}>
            <button type="button" onclick={() => toggleSort('next')}>Nächste Fälligkeit</button>
          </th>
          <th class="col-amount sortable" aria-sort={ariaSortFor('amount')}>
            <button type="button" onclick={() => toggleSort('amount')}>Erwartet</button>
          </th>
          <th class="col-action" aria-label="Aktion"></th>
        </tr>
      </thead>
      <tbody>
        {#if visible.length === 0}
          <tr class="empty-row">
            <td colspan="6">
              <div class="empty-block">
                Keine Treffer. Filter zurücksetzen oder andere Suche probieren.
                {#if query || frequency !== 'alle' || filter !== 'alle'}
                  <button type="button" class="link" onclick={() => { query = ''; frequency = 'alle'; filter = 'alle'; }}>Filter zurücksetzen</button>
                {/if}
              </div>
            </td>
          </tr>
        {:else}
          {#each visible as o (o.bexioOrderId)}
            <tr class="row state-{o._state}">
              <td class="col-state">
                <span class="state-dot {o._state}" aria-label={o._state}></span>
              </td>
              <td class="col-customer">
                <span class="customer-name">{o.customerName ?? `Auftrag #${o.bexioOrderId}`}</span>
                <span class="meta-row">#{o.bexioOrderId}{#if o.customerId} · Kunden-ID {o.customerId}{/if}</span>
              </td>
              <td class="col-interval">
                <span class="freq-tag">{INTERVAL_LABEL[o.interval ?? ''] ?? o.interval ?? '—'}</span>
              </td>
              <td class="col-next">
                {#if o.nextBillingDate}
                  <span class="due-label due-{o._due.bucket}">{o._due.label}</span>
                  <span class="meta-row">{formatDate(o.nextBillingDate)}</span>
                {:else}
                  <span class="meta-row">—</span>
                {/if}
              </td>
              <td class="col-amount">
                {#if o.expectedAmount}
                  <span class="amount-num">{formatAmount(o.expectedAmount)}</span>
                  <span class="meta-row">CHF</span>
                {:else}
                  <span class="meta-row">—</span>
                {/if}
              </td>
              <td class="col-action">
                {#if o._state === 'aktiv'}
                  <form method="POST" action="?/toggle" use:enhance>
                    <input type="hidden" name="orderId" value={o.bexioOrderId} />
                    <input type="hidden" name="enabled" value="false" />
                    <button class="row-action pause" type="submit" title="Pausieren">Pausieren</button>
                  </form>
                {:else if o._state === 'pausiert'}
                  <form method="POST" action="?/toggle" use:enhance>
                    <input type="hidden" name="orderId" value={o.bexioOrderId} />
                    <input type="hidden" name="enabled" value="true" />
                    <button class="row-action activate" type="submit" title="Aktivieren">Aktivieren</button>
                  </form>
                {/if}
              </td>
            </tr>
          {/each}
        {/if}
      </tbody>
    </table>
  </div>

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
    <div class="errors-block">
      {#each data.errors as err}<div>· {err}</div>{/each}
    </div>
  {/if}
</div>

<style>
  /* ── Chipbar (filters) ── */
  .chipbar {
    display: flex; flex-wrap: wrap; gap: 6px;
    margin-bottom: 16px;
  }
  .chip {
    display: inline-flex; align-items: center; gap: 8px;
    height: 32px; padding: 0 12px;
    background: transparent; border: 1px solid var(--border); border-radius: 16px;
    font-family: var(--sans); font-size: 13px; color: var(--text-2);
    transition: border-color 120ms, color 120ms, background 120ms;
  }
  .chip:hover { border-color: var(--text-3); color: var(--text); }
  .chip:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .chip.active {
    border-color: var(--accent);
    color: var(--text);
    background: rgba(79, 140, 255, 0.06);
  }
  .chip-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: var(--text-3);
  }
  .chip-dot.ok { background: var(--ok); }
  .chip-dot.warn { background: var(--warn); }
  .chip-dot.err { background: var(--err); }
  .chip-dot.muted { background: var(--text-3); }
  .chip-count {
    font-family: var(--mono); font-size: 11px; color: var(--text-3);
    margin-left: 2px;
  }
  .chip.active .chip-count { color: var(--accent); }

  /* ── Toolbar (search + freq + count) ── */
  .toolbar {
    display: flex; gap: 12px; align-items: center;
    margin-bottom: 12px;
  }
  .search {
    position: relative; flex: 1; min-width: 0;
  }
  .search input {
    width: 100%; height: 36px;
    padding: 0 32px 0 32px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 4px;
    font-family: var(--sans); font-size: 13px; color: var(--text);
    transition: border-color 120ms;
  }
  .search input:focus {
    outline: none; border-color: var(--accent);
  }
  .search input::placeholder { color: var(--text-3); }
  .search-icon {
    position: absolute; left: 10px; top: 50%; transform: translateY(-50%);
    color: var(--text-3); font-size: 14px; pointer-events: none;
  }
  .clear {
    position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
    width: 22px; height: 22px; border: none; background: transparent;
    color: var(--text-3); font-size: 18px; line-height: 1; border-radius: 4px;
  }
  .clear:hover { color: var(--text); background: var(--surface-2); }

  .freq-select {
    height: 36px; padding: 0 28px 0 12px;
    background: var(--surface); border: 1px solid var(--border); border-radius: 4px;
    font-family: var(--sans); font-size: 13px; color: var(--text-2);
    appearance: none;
    background-image: linear-gradient(45deg, transparent 50%, var(--text-3) 50%),
                      linear-gradient(135deg, var(--text-3) 50%, transparent 50%);
    background-position: calc(100% - 16px) 50%, calc(100% - 11px) 50%;
    background-size: 5px 5px, 5px 5px;
    background-repeat: no-repeat;
  }
  .freq-select:focus {
    outline: none; border-color: var(--accent); color: var(--text);
  }
  .result-count {
    font-family: var(--mono); font-size: 12px; color: var(--text-3);
    white-space: nowrap;
  }

  /* ── Table ── */
  .table-wrap { overflow-x: auto; }
  table.orders { width: 100%; border-collapse: collapse; }
  table.orders thead th {
    position: sticky; top: 0; background: var(--bg);
    text-align: left; font-weight: 400; color: var(--text-3);
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
    padding: 10px 12px 8px;
    border-bottom: 1px solid var(--border);
    z-index: 1;
  }
  table.orders thead th.col-amount,
  table.orders thead th.col-action { text-align: right; }
  table.orders thead th.sortable button {
    background: transparent; border: none; padding: 0; margin: 0;
    color: inherit; font: inherit; text-transform: inherit; letter-spacing: inherit;
    cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
  }
  table.orders thead th.sortable button:hover { color: var(--text); }
  table.orders thead th.sortable button:focus-visible {
    outline: 2px solid var(--accent); outline-offset: 2px;
  }
  table.orders thead th[aria-sort="ascending"] button::after  { content: "↑"; font-family: var(--mono); }
  table.orders thead th[aria-sort="descending"] button::after { content: "↓"; font-family: var(--mono); }
  table.orders thead th[aria-sort="none"] button::after { content: ""; }

  table.orders tbody td {
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
    font-size: 13px;
  }
  table.orders tbody tr:last-child td { border-bottom: none; }
  table.orders tbody tr.row { transition: background 80ms; }
  table.orders tbody tr.row:hover { background: var(--surface-2); }

  /* state-row dimming */
  .row.state-pausiert { color: var(--text-2); }
  .row.state-erledigt,
  .row.state-storniert { color: var(--text-3); }
  .row.state-erledigt .customer-name,
  .row.state-storniert .customer-name { color: var(--text-3); }

  /* Cells */
  .col-state { width: 28px; padding-right: 0 !important; }
  .col-amount, .col-action { text-align: right; white-space: nowrap; }
  .col-action { width: 110px; }
  .col-interval { width: 130px; }
  .col-next { width: 180px; }
  .col-amount { width: 140px; }

  .state-dot {
    display: inline-block; width: 8px; height: 8px; border-radius: 50%;
    background: var(--text-3); vertical-align: middle;
  }
  .state-dot.aktiv     { background: var(--ok); box-shadow: 0 0 0 3px rgba(34,197,94,0.12); }
  .state-dot.pausiert  { background: transparent; border: 1px solid var(--text-3); width: 7px; height: 7px; }
  .state-dot.erledigt  { background: var(--text-3); }
  .state-dot.storniert { background: var(--err); box-shadow: 0 0 0 3px rgba(239,68,68,0.12); }

  .customer-name { display: block; color: var(--text); }
  .row.state-erledigt .customer-name,
  .row.state-storniert .customer-name { color: var(--text-3); }

  .freq-tag {
    font-family: var(--mono); font-size: 11px; color: var(--text-2);
  }

  .due-label {
    display: block;
    font-family: var(--mono); font-size: 12px;
    color: var(--text);
  }
  .due-overdue   { color: var(--err); }
  .due-due-soon  { color: var(--warn); }
  .due-due-later { color: var(--text-2); }

  .amount-num {
    font-family: var(--mono); font-variant-numeric: tabular-nums;
    color: var(--text); font-size: 13px;
  }
  .row.state-erledigt .amount-num,
  .row.state-storniert .amount-num { color: var(--text-3); }

  /* Action button (per-row) */
  .row-action {
    display: inline-flex; align-items: center; height: 26px; padding: 0 10px;
    border: 1px solid var(--border); background: transparent; color: var(--text-2);
    font-family: var(--sans); font-size: 12px; border-radius: 4px;
    transition: border-color 120ms, color 120ms, opacity 120ms;
    opacity: 0.6;
  }
  tr.row:hover .row-action,
  .row-action:focus-visible { opacity: 1; }
  .row-action.activate:hover { border-color: var(--accent); color: var(--accent); }
  .row-action.pause:hover    { border-color: var(--warn); color: var(--warn); }

  /* Empty state */
  .empty-row td { border: none; }
  .empty-block {
    padding: 32px 12px; text-align: center;
    color: var(--text-3); font-size: 13px;
    display: flex; flex-direction: column; gap: 12px; align-items: center;
  }
  .link {
    background: transparent; border: none; color: var(--accent);
    font: inherit; cursor: pointer; padding: 0;
  }
  .link:hover { text-decoration: underline; }

  .errors-block {
    margin-top: 24px; padding: 16px;
    border: 1px solid var(--err); color: var(--err);
    font-family: var(--mono); font-size: 12px;
  }

  /* Mobile collapse */
  @media (max-width: 720px) {
    .toolbar { flex-wrap: wrap; }
    .search { flex: 1 1 100%; order: 1; }
    .freq-select { flex: 1; order: 2; }
    .result-count { order: 3; margin-left: auto; }
    .col-interval, .col-next { display: none; }
    .col-action { width: 90px; }
    .meta-row { display: block; }
    /* on mobile, fold interval into customer cell */
    .col-customer .meta-row::after {
      content: '';
    }
  }
</style>
