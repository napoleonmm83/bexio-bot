# Deployment — bexio-bot on Coolify

**Status: live since 2026-05-11.** This document is a snapshot of the actual
deployed setup, not a forward-looking plan. For the day-to-day Coolify resource
IDs see `project_coolify_resource_map.md` in project memory.

## Architecture

```
                       Cloudflare DNS (proxied)
                                │
                                ▼
                     Cloudflare Access (One-Time PIN)
                                │  policy: marcusmartini83@gmail.com only
                                ▼
                        Coolify Traefik proxy
                                │
                  ┌─────────────┴─────────────┐
                  ▼                           ▼
   bexio-bot-web (long-running)      bexio-bot-worker (idle host)
   /apps/web/Dockerfile               /apps/worker/Dockerfile
   port 3000, /health checked         CMD ["sleep", "infinity"]
   Adapter-node + SvelteKit                   ▲
                  │                           │ docker exec
                  │                ┌──────────┴──────────┐
                  │                │ Coolify Scheduled   │
                  │                │ Task "daily-run"    │
                  │                │ 0 6 * * * UTC       │
                  │                │ bun run apps/       │
                  │                │   worker/src/cli.ts │
                  │                └─────────────────────┘
                  ▼                           ▼
        ┌──────────────────────────────────────────┐
        │  postgresql-shared (Coolify, dump_all S3)│
        │  DB: bexiobot, user: bexiobot            │
        │  internal hostname: <postgres-uuid>:5432 │
        └──────────────────────────────────────────┘
                  ▲
                  │
              auth.bexio.com (OIDC, refresh-token in secrets table)
```

Both apps build from the private repo `napoleonmm83/bexio-bot` via SSH deploy key
(registered on the repo as a read-only key + uploaded to Coolify's private-key store).

Single shared Postgres for all of Marcus' Coolify projects keeps backup operations
to one job (`pg_dumpall` daily 04:00 → S3 with 3-day local retention).

## Auth surface

- **Cloudflare Access** sits in front of every route. Login via OTP to
  `marcusmartini83@gmail.com`, 24h session.
- **OAuth callback** (`/callback`) survives this transparently because the
  user's browser carries the CF Access cookie when bexio redirects back.
- **Deploy webhooks**: not used. Auto-deploy is OFF; deploys are triggered
  manually via `GET /api/v1/deploy?uuid=<app-uuid>&force=true`.

## Daily test canary

A `daily`-recurring bexio order ("IT Service Martini") fires every morning at
08:00 CH. Full pipeline runs end-to-end against real bexio every day, so any
regression (token rotation drift, bexio API change, Discord webhook breakage,
schema drift) surfaces within 24h instead of waiting for a monthly recurring.

## Operational runbooks

### Trigger a deploy

```bash
TOKEN=$(grep '^COOLIFY_API_TOKEN=' .env.local | cut -d= -f2-)
APP=vx76yeg463w2ckfndrsbsj8m  # web; for worker use s8dljxy4nawz52bxcjhar9nm
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://coolify.martini.digital/api/v1/deploy?uuid=$APP&force=true"
```

### Read worker run output (last 200 lines)

```bash
TOKEN=$(grep '^COOLIFY_API_TOKEN=' .env.local | cut -d= -f2-)
APP=s8dljxy4nawz52bxcjhar9nm
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://coolify.martini.digital/api/v1/applications/$APP/logs?lines=200" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['logs'])"
```

### Restore the Postgres backup (manual integrity test)

The shared Postgres backs up daily to S3 via `pg_dumpall`. To verify a backup
restores cleanly (recommended every 3-6 months):

1. In Coolify UI → Shared Services → `postgresql-shared` → Backups → pick a
   recent backup → "Download" (gzipped pg_dumpall output).
2. Spin up a throwaway Postgres locally:
   ```bash
   docker run -d --rm --name pg-restore-test -e POSTGRES_PASSWORD=test \
     -p 25433:5432 postgres:16-alpine
   ```
3. Restore into it:
   ```bash
   gunzip -c <backup-file>.gz | docker exec -i pg-restore-test \
     psql -U postgres -d postgres
   ```
4. Verify: connect, `\l` should list `bexiobot` DB, `\c bexiobot` then `\dt`
   should show `bot_runs`, `recurring_orders`, `invoice_runs`, `secrets`,
   `__drizzle_migrations`.
5. Tear down: `docker stop pg-restore-test`.

If step 4 fails: open a ticket immediately and switch backup-frequency to
hourly until root-caused.

### Rotate the bexio refresh token

Either:
- Visit `/auth/bexio/reauth` in the live app and click "Mit bexio verbinden"
  — completes the OAuth dance and writes new tokens to `secrets` table.
- Or local: `bun run oauth-setup` → catches callback on
  `http://localhost:8080/callback` → writes to local DB. Then export the
  `secrets` row and import into the production Postgres (rare; the web flow
  is the normal path).

### Adjust the daily-run cron

Coolify uses UTC. Current: `0 6 * * *` (= 08:00 CH summer / 07:00 winter).

```bash
TOKEN=$(grep '^COOLIFY_API_TOKEN=' .env.local | cut -d= -f2-)
APP=s8dljxy4nawz52bxcjhar9nm
TASK=jdp6f54qwm2n6ycosi6q0ajj
echo '{"frequency":"0 6 * * *"}' | curl -s -X PATCH \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data-binary @- \
  "https://coolify.martini.digital/api/v1/applications/$APP/scheduled-tasks/$TASK"
```

### Trigger an on-demand run via HTTP (Claude Cowork)

The web app exposes `POST /api/trigger-run` for ad-hoc invocations from
outside Coolify (primarily Claude Cowork, but any caller with a valid
Cloudflare Access service token works). The Coolify daily cron at 06:00 UTC
stays primary; this endpoint is the manual escape hatch.

**One-time setup:**

1. **Cloudflare Access** — in the bexio-bot Access app, add a **Service Auth**
   policy that allows requests with a specific Service Token, and capture the
   app's **AUD** tag (Access → Applications → bexio-bot → Overview).
2. **Service Token** — Access → Service Auth → Create Service Token. Save the
   Client-Id and Client-Secret somewhere durable (1Password, etc).
3. **Coolify env vars** on the web application (UUID in
   `project_coolify_resource_map.md`):
   - `CF_ACCESS_TEAM_DOMAIN=martinidigital` (no `.cloudflareaccess.com` —
     verify with `jq .claim_iss` on a failing JWT if unsure; the value comes
     from CF Zero Trust → Settings → Custom Pages → Team Domain)
   - `CF_ACCESS_AUD=<AUD-tag-from-step-1>`
4. **Restart the web app** for env vars to take effect.

**Cowork-side configuration:** when configuring the Cowork task that should
trigger the bot, point it at `https://bexio-bot.martini.digital/api/trigger-run`
and include these headers on every request:

```
CF-Access-Client-Id:     <service-token-client-id>.access
CF-Access-Client-Secret: <service-token-client-secret>
Content-Type:            application/json
```

**Trigger + poll example:**

```bash
TRIGGER=$(curl -s -X POST \
  -H "CF-Access-Client-Id: $CF_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_CLIENT_SECRET" \
  -H "Content-Type: application/json" \
  --data '{"dryRun":false}' \
  https://bexio-bot.martini.digital/api/trigger-run)

RUN_ID=$(echo "$TRIGGER" | jq -r '.runId')

# poll until finished
while :; do
  STATUS=$(curl -s \
    -H "CF-Access-Client-Id: $CF_CLIENT_ID" \
    -H "CF-Access-Client-Secret: $CF_CLIENT_SECRET" \
    "https://bexio-bot.martini.digital/api/runs/$RUN_ID")
  STATE=$(echo "$STATUS" | jq -r '.status')
  echo "$STATE"
  [[ "$STATE" == "running" ]] || break
  sleep 5
done
echo "$STATUS" | jq .
```

**Response semantics:**

| Endpoint | Code | Meaning |
|---|---|---|
| `POST /api/trigger-run` | 202 | Run started, `runId` returned. |
| `POST /api/trigger-run` | 409 | A run is already in-flight (<30 min old). Existing `runId` returned. |
| `POST /api/trigger-run` | 401 | CF Access JWT missing or invalid. |
| `GET /api/runs/:id` | 200 | Status in body (`running` / `completed` / `failed` / `stale`). |
| `GET /api/runs/:id` | 404 | No run with that ID. |

Notes:

- The run executes inside the web container (same process). If the container
  is redeployed mid-run, the run gets cut off — but `reconcileInFlightSends()`
  in the next run reconciles any `invoice_runs` rows stuck in `'sending'`
  against bexio's `is_sent` field. No double-send risk.
- A pre-inserted `bot_runs` row carries `trigger_source='cowork'` so manual
  triggers are distinguishable from cron runs in the dashboard.
- Stale-run detection: a row older than 30 minutes with `finished_at IS NULL`
  is treated as dead (process crashed) and unblocks new triggers.

## Defense-in-depth follow-ups

- **Cloudflare Origin-Lock**: configure the Hetzner Cloud Firewall (or `ufw`
  on the Coolify host) to only accept inbound 80/443 from
  [Cloudflare's published IP ranges](https://www.cloudflare.com/ips/). Without
  this lock, anyone who learns the origin IP can bypass CF Access by hitting
  it directly.

  Quickstart on the Coolify host (replace `<cf-ip-range>` for each entry from
  https://www.cloudflare.com/ips-v4 and ips-v6):

  ```bash
  ufw default deny incoming
  ufw allow OpenSSH
  for IP in $(curl -s https://www.cloudflare.com/ips-v4); do
    ufw allow from "$IP" to any port 80,443 proto tcp
  done
  for IP in $(curl -s https://www.cloudflare.com/ips-v6); do
    ufw allow from "$IP" to any port 80,443 proto tcp
  done
  ufw enable
  ```

- **Phase-1 acceptance criteria** (DESIGN.md): 30 days of live operation with
  zero double-sends. Daily test canary makes this much easier to validate.

- **Crash-recovery suite in CI**: scheduled but not yet built.
