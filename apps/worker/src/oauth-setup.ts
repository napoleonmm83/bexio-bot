// One-shot OAuth flow for the initial bexio token. Runs locally on http://localhost:8080.
// Opens the bexio auth URL in your browser, catches the callback, exchanges the code,
// and stores the refresh + access token in the secrets table.
//
// Usage: bun run oauth-setup
// Prereq: BEXIO_CLIENT_ID, BEXIO_CLIENT_SECRET, BEXIO_REDIRECT_URI in .env.local

import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { getDb, closeDb, secrets } from '@bexio-bot/db';

const CLIENT_ID = process.env.BEXIO_CLIENT_ID;
const CLIENT_SECRET = process.env.BEXIO_CLIENT_SECRET;
const REDIRECT_URI = process.env.BEXIO_REDIRECT_URI ?? 'http://localhost:8080/callback';
const AUTH_URL = 'https://auth.bexio.com/realms/bexio/protocol/openid-connect/auth';
const TOKEN_URL = 'https://auth.bexio.com/realms/bexio/protocol/openid-connect/token';
// Required scopes per endpoint verified live against Marcus' bexio (2026-05):
// - kb_order_show:    GET /kb_order, GET /kb_order/{id}
// - kb_order_edit:    POST /kb_order/{id}/repetition  (creates invoice from order — required!)
// - kb_invoice_show:  GET /kb_invoice/{id} (for crash-recovery reconciliation)
// - kb_invoice_edit:  POST /kb_invoice/{id}/issue, POST /kb_invoice/{id}/send
// - contact_show:     GET /contact/{id} (for resolving customer names)
const SCOPES = 'openid offline_access kb_order_show kb_order_edit kb_invoice_show kb_invoice_edit contact_show';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing BEXIO_CLIENT_ID or BEXIO_CLIENT_SECRET in .env.local');
  process.exit(1);
}

// PKCE — extra safety even though bexio is a confidential client
const codeVerifier = randomBytes(32).toString('base64url');
const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
const state = randomBytes(16).toString('base64url');

const authUrl = new URL(AUTH_URL);
authUrl.searchParams.set('response_type', 'code');
authUrl.searchParams.set('client_id', CLIENT_ID);
authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
authUrl.searchParams.set('scope', SCOPES);
authUrl.searchParams.set('state', state);
authUrl.searchParams.set('code_challenge', codeChallenge);
authUrl.searchParams.set('code_challenge_method', 'S256');

const fullAuthUrl = authUrl.toString();

console.log('');
console.log('bexio OAuth setup');
console.log('═════════════════');
console.log('Redirect URI:', REDIRECT_URI);
console.log('Scopes:      ', SCOPES);
console.log('');
console.log('Opening browser. If it does not open automatically, visit this URL manually:');
console.log('');
console.log(fullAuthUrl);
console.log('');

// Auto-open browser (Windows: start, macOS: open, Linux: xdg-open)
const opener =
  process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', fullAuthUrl]]
  : process.platform === 'darwin' ? ['open', [fullAuthUrl]]
  : ['xdg-open', [fullAuthUrl]];

try {
  spawn(opener[0] as string, opener[1] as string[], { detached: true, stdio: 'ignore' }).unref();
} catch {
  // Manual open is fine — URL is printed above.
}

let resolveFlow: (ok: boolean) => void;
const flowDone = new Promise<boolean>((r) => { resolveFlow = r; });

const server = Bun.serve({
  port: 8080,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname !== '/callback') {
      return new Response('Not found. Waiting on /callback', { status: 404 });
    }

    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const error = url.searchParams.get('error');

    if (error) {
      console.error('bexio returned error:', error, url.searchParams.get('error_description'));
      setTimeout(() => resolveFlow(false), 100);
      return errorPage(`bexio returned error: ${error}`);
    }

    if (!code) {
      return errorPage('Missing authorization code in callback.');
    }

    if (returnedState !== state) {
      console.error('State mismatch — possible CSRF attempt.');
      return errorPage('State mismatch. Aborting for safety.');
    }

    // Exchange code for tokens
    const tokenParams = new URLSearchParams();
    tokenParams.set('grant_type', 'authorization_code');
    tokenParams.set('code', code);
    tokenParams.set('redirect_uri', REDIRECT_URI);
    tokenParams.set('client_id', CLIENT_ID);
    tokenParams.set('client_secret', CLIENT_SECRET);
    tokenParams.set('code_verifier', codeVerifier);

    let tokens: { access_token: string; refresh_token: string; expires_in: number; scope: string };
    try {
      const tokenRes = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: tokenParams,
      });

      if (!tokenRes.ok) {
        const errBody = await tokenRes.text();
        console.error('Token exchange failed:', tokenRes.status, errBody);
        setTimeout(() => resolveFlow(false), 100);
        return errorPage(`Token exchange failed: ${tokenRes.status} — ${errBody.slice(0, 200)}`);
      }

      tokens = await tokenRes.json();
    } catch (err) {
      console.error('Token exchange threw:', err);
      setTimeout(() => resolveFlow(false), 100);
      return errorPage(`Network error during token exchange: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Persist to DB
    try {
      const db = getDb();
      const expiresAt = new Date(Date.now() + tokens.expires_in * 1000);

      await db
        .insert(secrets)
        .values({ key: 'bexio_refresh_token', value: tokens.refresh_token })
        .onConflictDoUpdate({
          target: secrets.key,
          set: { value: tokens.refresh_token, updatedAt: new Date() },
        });

      await db
        .insert(secrets)
        .values({ key: 'bexio_access_token', value: tokens.access_token, expiresAt })
        .onConflictDoUpdate({
          target: secrets.key,
          set: { value: tokens.access_token, expiresAt, updatedAt: new Date() },
        });

      console.log('');
      console.log('OAuth flow complete.');
      console.log('  refresh_token: stored in secrets.bexio_refresh_token');
      console.log('  access_token:  stored in secrets.bexio_access_token (expires', expiresAt.toISOString(), ')');
      console.log('  scopes granted:', tokens.scope);
      console.log('');
    } catch (err) {
      console.error('DB write failed:', err);
      setTimeout(() => resolveFlow(false), 100);
      return errorPage(`Token received but DB write failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    setTimeout(() => resolveFlow(true), 200);
    return successPage(tokens);
  },
});

console.log('Listening on http://127.0.0.1:8080 — waiting for /callback...');

const ok = await flowDone;
server.stop();
await closeDb();

process.exit(ok ? 0 : 1);

// ─── HTML helpers ────────────────────────────────────────────────

function successPage(tokens: { expires_in: number; scope: string }): Response {
  return new Response(
    `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>bexio OAuth — OK</title>
<style>
  body { font-family: 'Inter', system-ui, sans-serif; background: #0b0d10; color: #e8ebf0;
    margin: 0; padding: 60px 32px; }
  .wrap { max-width: 560px; margin: 0 auto; }
  h1 { font-weight: 500; letter-spacing: -0.01em; margin: 0 0 16px; }
  .ok { color: #22c55e; }
  p { color: #98a2b3; line-height: 1.6; }
  code { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 13px;
    background: #161a22; padding: 2px 6px; border-radius: 3px; color: #e8ebf0; }
  .meta { margin-top: 24px; padding: 16px; background: #11141a; border: 1px solid #1f2530;
    border-radius: 4px; font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 12px;
    color: #6b7484; }
</style></head><body><div class="wrap">
  <h1><span class="ok">●</span> OAuth-Flow erfolgreich</h1>
  <p>Refresh-Token gespeichert in <code>secrets.bexio_refresh_token</code>.</p>
  <p>Du kannst dieses Tab schließen und ins Terminal zurückgehen.</p>
  <div class="meta">
    access_token läuft ab in ${tokens.expires_in}s<br>
    scopes: ${tokens.scope}
  </div>
</div></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

function errorPage(message: string): Response {
  return new Response(
    `<!doctype html>
<html lang="de"><head><meta charset="utf-8"><title>bexio OAuth — Fehler</title>
<style>
  body { font-family: 'Inter', system-ui, sans-serif; background: #0b0d10; color: #e8ebf0;
    margin: 0; padding: 60px 32px; }
  .wrap { max-width: 560px; margin: 0 auto; }
  h1 { font-weight: 500; letter-spacing: -0.01em; margin: 0 0 16px; }
  .err { color: #ef4444; }
  p { color: #98a2b3; line-height: 1.6; }
  pre { background: #11141a; border: 1px solid #1f2530; padding: 16px;
    border-radius: 4px; color: #ef4444; font-family: 'JetBrains Mono', ui-monospace, monospace;
    font-size: 13px; overflow-x: auto; }
</style></head><body><div class="wrap">
  <h1><span class="err">●</span> OAuth-Flow fehlgeschlagen</h1>
  <p>Schau ins Terminal für Details, dann nochmal <code>bun run oauth-setup</code>.</p>
  <pre>${escapeHtml(message)}</pre>
</div></body></html>`,
    { status: 400, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
