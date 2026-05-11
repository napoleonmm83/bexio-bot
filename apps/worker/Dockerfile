# Worker image — runs once per Coolify "Scheduled Task" trigger, then exits.
# NOT a long-running server. Coolify schedules this; the container exits cleanly.

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

# Default to a single daily run. Coolify Scheduled Task triggers via:
#   docker run --rm <image>
# To run --check or --dry-run, override CMD in Coolify task config.
CMD ["bun", "run", "apps/worker/src/cli.ts"]
