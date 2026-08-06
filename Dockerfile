# syntax=docker/dockerfile:1
#
# Multi-stage build. The final image contains the standalone Next.js server,
# the compiled workers, and nothing else — no build toolchain, no dev deps.
#
# Same image runs all three processes; the compose file picks which via the
# command. That keeps "the web and the worker are running the same code"
# true by construction rather than by discipline.

# ── Dependencies ─────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ── Build ────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next needs *some* value for these at build time for static analysis. They are
# placeholders — real values are injected at runtime, never baked into the image.
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATABASE_URL=postgres://build:build@localhost:5432/build
ENV SESSION_SECRET=YnVpbGQtdGltZS1wbGFjZWhvbGRlci1ub3QtYS1yZWFsLXNlY3JldC0zMmI=

RUN npm run build

# ── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000

# Run unprivileged. The node image already ships a `node` user.
RUN mkdir -p /app/secrets && chown -R node:node /app

# Standalone output carries its own minimal node_modules.
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

# Workers and migrations run from source via tsx, so they need the full
# dependency tree and the TypeScript sources.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=build --chown=node:node /app/tsconfig.json ./tsconfig.json
COPY --from=build --chown=node:node /app/package.json ./package.json

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
