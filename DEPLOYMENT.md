# Deployment auf Coolify mit Cloudflare Access

Drei Layer, von außen nach innen:

1. **Cloudflare DNS** — Domain zeigt auf Coolify-Server
2. **Cloudflare Access** — Passkey-Login vor jedem Request
3. **Coolify** — hostet Postgres + Webapp + Worker-als-Scheduled-Task

```
  User Browser
      │
      ▼
  bexio-bot.deine-domain.tld   ◄── Cloudflare DNS
      │
      ▼
  Cloudflare Access            ◄── Passkey-Login (WebAuthn)
      │ (proxied, JWT eingefügt)
      ▼
  Coolify Reverse-Proxy
      │
      ▼
  ┌──────────────┬──────────────────────┐
  │ Webapp :3000 │  Postgres :5432      │
  │ (SvelteKit)  │  (Coolify-Service)   │
  └──────────────┴──────────────────────┘
        ▲
        │ liest dieselbe DB
  ┌─────┴────────┐
  │ Worker (Cron)│  ◄── Coolify "Scheduled Task" um 08:00 Europe/Zurich
  │ runs+exits   │
  └──────────────┘
```

---

## Schritt 1 — Domain bei Cloudflare

1. Domain (z.B. `deine-domain.tld`) zu Cloudflare-DNS hinzufügen (falls noch nicht).
   Anleitung: https://developers.cloudflare.com/dns/zone-setups/full-setup/
2. Bei deinem Domain-Registrar die Nameserver auf Cloudflare zeigen.
3. Subdomain für den Bot anlegen:
   - Type: `A` (oder `CNAME` falls dein Coolify hinter einer dynamischen IP läuft)
   - Name: `bexio-bot`
   - Target: deine Coolify-Server-IP
   - **Proxy: ON** (orange Wolke) — wichtig für Cloudflare Access
4. SSL/TLS-Modus: "Full (strict)" empfohlen. Coolify generiert dann ein Let's-Encrypt-Cert auf der Origin.

## Schritt 2 — Cloudflare Zero Trust + Access aktivieren

Cloudflare Zero Trust ist im Free-Tier bis 50 User. Ein Konto reicht ja für Marcus.

1. https://one.dash.cloudflare.com → Plan auswählen → "Free".
2. Settings → Authentication → **Login methods** → "One-time PIN" ist als Default da. Optional: WebAuthn-fähigen IdP wie GitHub, Google, oder einen eigenen SAML/OIDC-Provider hinzufügen.
3. **Passkey aktivieren:** Settings → WARP Client → "WebAuthn keys" als zusätzlichen Faktor erlauben. Oder: über One-Time-PIN als ersten Faktor + Passkey als zweiten.
   - Cleaner Weg: nutz einen IdP der WebAuthn nativ kann (z.B. **PomeriumIdP** oder Google mit Security Key Enforcement).

## Schritt 3 — Access Application erstellen

1. https://one.dash.cloudflare.com → Access → Applications → "Add an application" → "Self-hosted".
2. **Application name:** `bexio-bot`
3. **Session duration:** 24h (oder 7d wenn du faul bist)
4. **Application domain:** `bexio-bot.deine-domain.tld`
5. **Identity providers:** wähl die aus, die du in Schritt 2 konfiguriert hast.
6. **Policies:**
   - Policy name: `Marcus only`
   - Action: `Allow`
   - Include → "Emails" → `marcusmartini83@gmail.com`
   - Require → "Authentication method" → `WebAuthn` (das macht Passkey zur Pflicht).
7. Speichern.

Jetzt: jeder Aufruf von `https://bexio-bot.deine-domain.tld/...` wird von Cloudflare abgefangen. Du musst dich erst per Passkey einloggen, **dann** kommt der Request beim Bot an.

## Schritt 4 — Coolify-Setup

1. **GitHub-Repo erstellen** und dieses Projekt pushen:
   ```bash
   gh repo create bexio-bot --private --source=. --push
   ```
   (oder via Web-UI). Repo bleibt **privat** — die `.env.local` ist gitignored, aber `BEXIO_CLIENT_SECRET` würde im Git-History suchbar sein wenn jemand mal `git add -A` macht.

2. **Coolify-Server**: in Coolify-UI ein neues Projekt anlegen:

3. **Postgres-Service** hinzufügen:
   - Service-Type: PostgreSQL 16
   - DB-Name: `bexiobot`
   - User: `bexiobot`
   - Password: stark generieren (min 32 Zeichen)
   - Network: gleicher private Network wie die Webapp
   - Backup: Daily nach S3-kompatiblen Storage (Hetzner Object Storage / Backblaze B2)

4. **Webapp-Service** hinzufügen:
   - Build-Type: Dockerfile, Pfad `apps/web/Dockerfile`
   - Build-Context: Repo-Root (Coolify-Default)
   - Domain: `bexio-bot.deine-domain.tld`
   - Port: `3000`
   - Environment-Variablen (aus Coolify-Secrets):
     ```
     DATABASE_URL=postgres://bexiobot:STRONG_PW@<postgres-service>:5432/bexiobot
     BEXIO_CLIENT_ID=d0008ce5-aa8d-4f23-b475-62010bdc71ef
     BEXIO_CLIENT_SECRET=...
     BEXIO_REDIRECT_URI=https://bexio-bot.deine-domain.tld/auth/bexio/callback
     DISCORD_WEBHOOK_URL=...
     WORKER_TZ=Europe/Zurich
     LOG_LEVEL=info
     NODE_ENV=production
     ```
   - Healthcheck: `GET /health`, Interval 60s, Threshold 3
   - Auto-Deploy: ON für `main`-Branch

5. **Worker als Scheduled Task** hinzufügen:
   - Coolify-Type: "Scheduled Task" (nicht "App")
   - Image: gleiches Dockerfile-Build, aber Path `apps/worker/Dockerfile`
   - Schedule: `0 8 * * *` (täglich 08:00 Server-Zeit — stell sicher dass Coolify-Server Zeitzone Europe/Zurich nutzt, oder nutze `0 6 * * *` für 06:00 UTC)
   - Environment-Variablen: gleiche wie Webapp
   - Logs: Coolify schreibt automatisch nach stdout-Logs

6. **Migrations** beim ersten Deploy:
   - Manuell einmal: `coolify exec <web-service> -- bun run db:migrate`
   - Oder: Worker-Image hat im CMD-Override für ersten Run `bun run packages/db/src/migrate.ts`
   - Spätere Migrations: Webapp-Dockerfile-CMD auf `migrate && start` umstellen, oder als pre-deploy Hook

7. **Initialer OAuth-Flow auf dem Server:**
   - Einmalig: `coolify exec <web-service> -- bun run oauth-setup`
   - Aber: das Skript öffnet den Browser. Auf einem Headless-Server geht das nicht.
   - Workaround: lokal den OAuth-Flow durchspielen (wie schon getan), DB-Backup machen, auf Coolify-Postgres restoren — die `secrets`-Tabelle bringt den Refresh-Token mit.
   - Alternativ: `BEXIO_REFRESH_TOKEN` als ENV-Var setzen, ein "first-run-import"-Skript schreibt es einmal in die secrets-Tabelle.

## Schritt 5 — Cloudflare Access Origin-Lock (optional, Defense-in-Depth)

Cloudflare-Access setzt einen `Cf-Access-Jwt-Assertion`-Header in jeden Request. Der Bot kann den validieren — falls jemand Coolify direkt erreicht (z.B. über IP statt Domain), wird's geblockt.

Konfiguration im Bot kommt in einer späteren Phase. Für Phase 1: Cloudflare-Access vor Coolify reicht. Coolify-Server-Firewall sollte eingehende Connections nur von Cloudflare-IPs erlauben (Cloudflare publiziert die Liste: https://www.cloudflare.com/ips/).

## Schritt 6 — Smoke-Test nach Deploy

1. Browser → `https://bexio-bot.deine-domain.tld/health`
2. Cloudflare-Access fängt: zeig dir Login-Screen, du klickst "WebAuthn", Passkey-Prompt.
3. Nach Login: JSON-Response `{"status":"ok",...}`.
4. `/` zeigt Dashboard mit deinen Aufträgen.

## Was passiert nach Phase 1 Tag 30

Acceptance-Kriterium aus Design-Doc:
- 30 Tage Live-Betrieb mit 0 Doppel-Sendungen
- Crash-Recovery-Suite läuft in CI
- Mindestens ein automatisierter Restore-Test grün

Diese Punkte stehen offen, sind nicht Teil von Phase 1 Schritt 10. Wir bauen sie nach den 30 Tagen Live-Betrieb auf, sobald wir wissen welche Edge-Cases tatsächlich auftreten.
