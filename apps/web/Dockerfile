# Webapp image — long-running SvelteKit server via adapter-node.
# Coolify exposes port 3000; Cloudflare Access tunnels to it.

FROM oven/bun:1.3-alpine AS builder
WORKDIR /app

# Workspace manifests
COPY package.json bun.lock ./
COPY apps/web/package.json ./apps/web/
COPY packages/db/package.json ./packages/db/
COPY packages/bexio-client/package.json ./packages/bexio-client/
COPY packages/notify/package.json ./packages/notify/

# Install everything (incl. dev deps) — needed for vite build
RUN bun install --frozen-lockfile

# Source
COPY tsconfig.json ./
COPY apps/web ./apps/web
COPY packages ./packages

# Build SvelteKit app
RUN cd apps/web && bun run build

# ── Runtime image ─────────────────────────────────────
FROM oven/bun:1.3-alpine AS runtime
WORKDIR /app

# Copy production node_modules + built app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/web/build ./apps/web/build
COPY --from=builder /app/apps/web/package.json ./apps/web/
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/package.json ./
COPY --from=builder /app/bun.lock ./

EXPOSE 3000
USER bun

ENV NODE_ENV=production
ENV PORT=3000

# adapter-node output: build/index.js is the server entry
CMD ["bun", "run", "apps/web/build/index.js"]
