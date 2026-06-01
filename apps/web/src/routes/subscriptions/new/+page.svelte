<script lang="ts">
  // Deprecation notice — the bot-native subscription layer is retired.
</script>

<div class="page">
  <header class="topbar">
    <div class="product">bexio-bot<span class="dot">.</span></div>
    <div class="meta">Abonnements</div>
  </header>

  <section class="card">
    <h2>Abonnements sind deaktiviert</h2>
    <p>Der bot-interne Subscription-Layer wurde abgelöst. Wiederkehrende Abrechnungen
      laufen jetzt vollständig über <strong>bexio-Aufträge</strong> — die Order-Pipeline
      deckt jeden Rechnungszyklus korrekt ab (täglich bis jährlich, inkl. benutzerdefinierter Intervalle).</p>
    <p>Neue wiederkehrende Aufträge legst du in bexio an und importierst sie hier.</p>
    <div class="actions">
      <a class="btn primary" href="/orders/import">Zum Auftrags-Import →</a>
      <a class="btn" href="/">Dashboard</a>
    </div>
  </section>

  <footer class="footer">
    <a href="/">← Dashboard</a>
    <span class="sep">·</span>
    <a href="/orders/import">Import</a>
    <span class="sep">·</span>
    <a href="/settings">Einstellungen</a>
  </footer>
</div>

<style>
  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
    padding: 24px; margin-top: 28px; max-width: 64ch;
  }
  .card h2 { font-size: 16px; font-weight: 600; margin: 0 0 12px; }
  .card p { color: var(--text-2); font-size: 14px; margin: 0 0 12px; }
  .actions { margin-top: 18px; display: flex; gap: 10px; }
  .btn {
    display: inline-flex; align-items: center; height: 34px; padding: 0 16px;
    border: 1px solid var(--border); background: transparent; color: var(--text-2);
    font-size: 13px; border-radius: 4px;
  }
  .btn:hover { border-color: var(--text-3); color: var(--text); text-decoration: none; }
  .btn.primary { border-color: var(--accent); color: var(--accent); }
  .btn.primary:hover { background: rgba(79, 140, 255, 0.08); }
</style>
