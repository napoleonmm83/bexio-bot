<script lang="ts">
  import { enhance } from '$app/forms';
  import type { PageData, ActionData } from './$types.ts';

  let { data, form }: { data: PageData; form: ActionData } = $props();

  type Row = { articleId: number | null; qty: string };
  let positions = $state<Row[]>([{ articleId: null, qty: '1' }]);

  let contactSearch = $state('');
  let contactSelected = $state<{ id: number; name: string; email: string | null } | null>(null);

  const filteredContacts = $derived(
    contactSearch.trim()
      ? data.contacts.filter((c) => c.name.toLowerCase().includes(contactSearch.toLowerCase()))
      : data.contacts,
  );

  // Auto-suggest plan name when both customer and first product are chosen.
  let nameTouched = $state(false);
  let nameInput = $state('');
  $effect(() => {
    if (nameTouched) return;
    const firstArticle = positions[0]?.articleId
      ? data.articles.find((x) => x.id === positions[0]!.articleId)
      : null;
    if (firstArticle && contactSelected) {
      nameInput = `${firstArticle.name} — ${contactSelected.name}`;
    }
  });

  function addPosition() { positions = [...positions, { articleId: null, qty: '1' }]; }
  function removePosition(i: number) { positions = positions.filter((_, idx) => idx !== i); }

  const today = new Date().toISOString().slice(0, 10);
  let endDateUnlimited = $state(true);
</script>

<svelte:head><title>Neues Abo · bexio-bot</title></svelte:head>

<main class="page">
  <p class="back"><a href="/subscriptions">← Abonnements</a></p>
  <h1>Neues Abonnement</h1>

  {#if form?.error}<p class="error">⚠ {form.error}</p>{/if}

  <form method="POST" use:enhance class="form">
    <div class="field">
      <label class="label" for="contact">Kunde</label>
      {#if !contactSelected}
        <input
          id="contact"
          type="text"
          placeholder="Kontakt suchen…"
          bind:value={contactSearch}
          autocomplete="off"
        />
        {#if filteredContacts.length > 0}
          <ul class="suggestions">
            {#each filteredContacts as c}
              <li>
                <button type="button" onclick={() => { contactSelected = c; contactSearch = c.name; }}>
                  {c.name}{#if c.email} <span class="muted">· {c.email}</span>{/if}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      {:else}
        <p class="selection">
          <strong>{contactSelected.name}</strong>
          <span class="muted">(bexio-Id {contactSelected.id}{#if contactSelected.email}, {contactSelected.email}{/if})</span>
          <button type="button" onclick={() => { contactSelected = null; contactSearch = ''; }}>ändern</button>
        </p>
        <input type="hidden" name="bexio_contact_id" value={contactSelected.id} />
      {/if}
    </div>

    <div class="field">
      <label class="label" for="name">Plan-Name</label>
      <input
        id="name"
        type="text"
        name="name"
        bind:value={nameInput}
        oninput={() => (nameTouched = true)}
        placeholder="Hosting Basic — IT Service Martin"
        required
      />
    </div>

    <fieldset class="field">
      <legend class="label">Intervall</legend>
      <label class="radio"><input type="radio" name="interval" value="monthly" checked /> monatlich</label>
      <label class="radio"><input type="radio" name="interval" value="yearly" /> jährlich</label>
    </fieldset>

    <div class="field">
      <label class="label" for="start_date">Startdatum</label>
      <input id="start_date" type="date" name="start_date" value={today} required />
    </div>

    <div class="field">
      <label class="label">Enddatum</label>
      <label class="checkbox"><input type="checkbox" bind:checked={endDateUnlimited} /> unbefristet</label>
      {#if !endDateUnlimited}
        <input type="date" name="end_date" />
      {/if}
    </div>

    <div class="field">
      <label class="checkbox"><input type="checkbox" name="auto_send" checked /> Rechnung gleich versenden</label>
    </div>

    <fieldset class="field">
      <legend class="label">Positionen</legend>
      {#each positions as pos, idx (idx)}
        <div class="position-row">
          <select bind:value={pos.articleId} name="item_article_id" required>
            <option value={null} disabled>Produkt wählen…</option>
            {#each data.articles as a}
              <option value={a.id}>{a.name} ({a.code}) · CHF {a.price}</option>
            {/each}
          </select>
          <input type="number" step="0.001" min="0.001" name="item_qty" bind:value={pos.qty} required />
          {#if positions.length > 1}
            <button type="button" class="btn-secondary" onclick={() => removePosition(idx)}>entfernen</button>
          {/if}
        </div>
      {/each}
      <button type="button" class="btn-secondary" onclick={addPosition}>+ Produkt hinzufügen</button>
    </fieldset>

    <div class="actions">
      <button type="submit" class="btn-primary">Anlegen</button>
      <a href="/subscriptions" class="btn-secondary">Abbrechen</a>
    </div>
  </form>
</main>

<style>
  .page { padding: 1.5rem; max-width: 720px; margin: 0 auto; }
  .back { margin-bottom: 0.5rem; }
  .form { display: flex; flex-direction: column; gap: 1.25rem; margin-top: 1.5rem; }
  .field { display: flex; flex-direction: column; gap: 0.4rem; border: 0; padding: 0; margin: 0; }
  .label { font-weight: 500; }
  input[type="text"], input[type="date"], input[type="number"], select {
    padding: 0.5rem 0.6rem;
    border: 1px solid var(--border, #d1d5db);
    border-radius: 4px;
    font: inherit;
  }
  .radio, .checkbox { display: inline-flex; align-items: center; gap: 0.4rem; margin-right: 1rem; }
  .suggestions {
    list-style: none;
    padding: 0;
    margin: 0;
    max-height: 240px;
    overflow: auto;
    border: 1px solid var(--border, #d1d5db);
    border-radius: 4px;
  }
  .suggestions li { border-bottom: 1px solid var(--border, #eee); }
  .suggestions li:last-child { border-bottom: 0; }
  .suggestions button {
    width: 100%;
    text-align: left;
    padding: 0.5rem 0.6rem;
    background: transparent;
    border: 0;
    cursor: pointer;
    font: inherit;
  }
  .suggestions button:hover { background: var(--bg-2, #f3f4f6); }
  .selection {
    padding: 0.5rem 0.6rem;
    background: var(--bg-2, #f3f4f6);
    border-radius: 4px;
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }
  .selection button {
    margin-left: auto;
    background: transparent;
    border: 0;
    color: var(--accent, #4f8cff);
    cursor: pointer;
    text-decoration: underline;
  }
  .position-row {
    display: grid;
    grid-template-columns: 1fr 110px auto;
    gap: 0.5rem;
    align-items: center;
    margin-bottom: 0.5rem;
  }
  .actions { display: flex; gap: 0.75rem; margin-top: 1rem; }
  .btn-primary {
    padding: 0.5rem 1rem; border: 0; border-radius: 6px;
    background: var(--accent, #4f8cff); color: white; cursor: pointer; font: inherit;
    text-decoration: none;
  }
  .btn-secondary {
    padding: 0.5rem 1rem; border: 1px solid var(--border, #d1d5db); border-radius: 6px;
    background: transparent; cursor: pointer; font: inherit; text-decoration: none;
    color: inherit;
  }
  .error {
    padding: 0.75rem;
    background: rgba(239, 68, 68, 0.1);
    border: 1px solid rgba(239, 68, 68, 0.4);
    border-radius: 4px;
    color: #991b1b;
  }
  .muted { color: var(--text-3, #6b7484); font-size: 0.9rem; }
</style>
