<script lang="ts">
  // Web-based OAuth flow: the button below is a plain link to /auth/bexio
  // which initiates the OAuth dance, redirects to bexio's auth page, and
  // catches the callback at /callback (writes new refresh + access tokens
  // into the secrets table).
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
    <h2>OAuth-Flow starten</h2>
    <p style="color: var(--text-2); line-height: 1.6;">
      Du wirst zu bexio weitergeleitet, meldest dich an und gibst dem Bot die
      benötigten Berechtigungen. Nach dem Callback werden Refresh- und
      Access-Token in der <code>secrets</code>-Tabelle gespeichert.
    </p>
    <p>
      <a
        href="/auth/bexio"
        data-sveltekit-reload
        style="display:inline-block;padding:10px 18px;background:var(--accent);color:white;text-decoration:none;border-radius:4px;font-weight:500;"
      >Mit bexio verbinden</a>
    </p>
    <p style="color: var(--text-3); font-size: 12px;">
      Alternative für Local-Dev: <code>bun run oauth-setup</code> im Terminal
      (nutzt <code>http://localhost:8080/callback</code>).
    </p>
  </section>

  <footer class="footer">
    <a href="/">Dashboard</a>
    <span class="sep">·</span>
    <a href="/runs">Lauf-Historie</a>
  </footer>
</div>
