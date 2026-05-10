<script lang="ts">
  // Phase 1 placeholder: full Re-Auth flow implementation lands when needed (when
  // a refresh token actually expires). For now: link the user to run the OAuth
  // setup script from terminal.
</script>

<div class="page">
  <header class="topbar">
    <div class="product">bexio-bot<span class="dot">.</span></div>
    <div class="meta"><a href="/">← zurück zum Dashboard</a></div>
  </header>

  <div class="status">
    <span class="indicator warn"></span>
    <div class="status-text">
      <strong>bexio Re-Auth</strong>
      <span class="secondary"> · Refresh-Token erneuern</span>
    </div>
  </div>

  <section class="section">
    <h2>Anleitung</h2>
    <p style="color: var(--text-2); line-height: 1.6;">
      Falls der bexio-Refresh-Token abgelaufen ist (sehr selten — bexio rotiert ihn
      bei jedem Refresh), öffne ein Terminal auf dem Server und führe aus:
    </p>
    <pre style="background: var(--surface); padding: 16px; border-radius: 4px; border: 1px solid var(--border); font-family: var(--mono); font-size: 13px; overflow-x: auto;">bun run oauth-setup</pre>
    <p style="color: var(--text-3); font-size: 12px;">
      Phase 1 hat keinen Web-Re-Auth-Flow. In Phase 2 ergänzt — dann kannst du
      direkt hier auf den Button klicken und durch den OAuth-Flow im Browser laufen.
    </p>
  </section>

  <footer class="footer">
    <a href="/">Dashboard</a>
    <span class="sep">·</span>
    <a href="/runs">Lauf-Historie</a>
  </footer>
</div>
