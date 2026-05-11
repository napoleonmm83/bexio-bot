# Webapp image — long-running SvelteKit server via adapter-node.
# Coolify exposes port 3000; Cloudflare Access tunnels to it.

FROM oven/bun:1.3.12-alpine AS builder
WORKDIR /app

# Workspace manifests — copy ALL workspace package.jsons (incl. ones we
# don't build here), otherwise bun considers the lockfile out of sync and
# --frozen-lockfile fails.
COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/db/package.json ./packages/db/
COPY packages/bexio-client/package.json ./packages/bexio-client/
COPY packages/notify/package.json ./packages/notify/

# Install everything (incl. dev deps) — needed for vite build.
RUN bun install --frozen-lockfile

# Source
COPY tsconfig.json ./
COPY apps/web ./apps/web
COPY apps/worker ./apps/worker
COPY packages ./packages

RUN cd apps/web && bun run build

# ── Runtime image ─────────────────────────────────────
FROM oven/bun:1.3.12-alpine AS runtime
WORKDIR /app

# curl for Coolify's in-container healthcheck (alpine has wget but
# Coolify prefers curl; including both silences a deploy-time warning).
RUN apk add --no-cache curl

# Copy production node_modules + built app.
# IMPORTANT: bun's workspace install hoists deps into /app/node_modules/.bun/
# but the user-facing symlinks (e.g. drizzle-orm) live in apps/web/node_modules/
# — without copying that dir, SvelteKit's built server chunks can't resolve
# imports and every route 500s with "Cannot find package".
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=builder /app/apps/web/build ./apps/web/build
COPY --from=builder /app/apps/web/package.json ./apps/web/
# Worker source needed at runtime: the trigger-run endpoint calls
# runDaily() in-process via @bexio-bot/worker/run, which the workspace
# resolver maps back to apps/worker/src/lib/run.ts.
COPY --from=builder /app/apps/worker ./apps/worker
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./
COPY --from=builder /app/bun.lock ./

EXPOSE 3000
USER bun

ENV NODE_ENV=production
ENV PORT=3000

# Run drizzle migrations before starting the server so /health (which
# queries bot_runs) doesn't fail on first deploy when the schema is empty.
# Migrations are idempotent — safe to re-run on every container start.
CMD ["sh", "-c", "bun run packages/db/src/migrate.ts && bun run apps/web/build/index.js"]
