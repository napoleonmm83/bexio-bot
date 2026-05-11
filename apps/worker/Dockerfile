# Worker image — long-running idle host. Coolify "Scheduled Tasks" docker-exec
# the actual `bun run apps/worker/src/cli.ts` invocation on a cron, so the
# container itself just needs to stay alive between runs (~5 MB RAM idle).
# Manual one-off run: `docker exec <container> bun run apps/worker/src/cli.ts`.

FROM oven/bun:1.3.12-alpine AS deps
WORKDIR /app

# Workspace manifests — copy ALL workspace package.jsons (incl. ones we
# don't run here), otherwise bun considers the lockfile out of sync and
# --frozen-lockfile fails.
COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/db/package.json ./packages/db/
COPY packages/bexio-client/package.json ./packages/bexio-client/
COPY packages/notify/package.json ./packages/notify/

RUN bun install --frozen-lockfile --production

# Source files. Bun runs TypeScript directly, no build step.
COPY tsconfig.json ./
COPY apps/worker ./apps/worker
COPY packages ./packages

# Run as non-root for defense-in-depth
USER bun

# Idle host so Coolify can `docker exec` the worker on its cron schedule.
CMD ["sleep", "infinity"]
