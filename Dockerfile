# TokenScope production image — multi-stage Nuxt 3 build.
#
# Mirrors a sibling project's Dockerfile shape:
#   deps → build → prod-deps → runtime
# Runtime ships only the .output/ tree + production node_modules + the
# migrations dir (entrypoint runs them on boot). No build tooling leaks.

# ── Stage 1: Dependencies ────────────────────────────────────────────
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# ── Stage 2: Build ───────────────────────────────────────────────────
FROM node:24-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Wave-VII: bake the git commit SHA into the build so the runtime image
# reports the exact revision at /admin/settings even when the deploy
# pipeline doesn't pass GIT_COMMIT_SHA at apply time. The Bicep env-var
# override (infra/modules/container-app.bicep:GIT_COMMIT_SHA) wins at
# runtime; this ARG is the fallback when the env is empty / unset.
ARG GIT_COMMIT_SHA=unknown
ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA
ENV NUXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── Stage 3: Production dependencies ─────────────────────────────────
FROM deps AS prod-deps
RUN npm prune --omit=dev

# ── Stage 4: Runtime ─────────────────────────────────────────────────
FROM node:24-slim AS runtime
WORKDIR /app

# Wave-VII: re-declare GIT_COMMIT_SHA ARG in the runtime stage so the
# baked SHA carries through to the running container. Bicep can
# override at deploy time via the env var of the same name (see
# infra/modules/container-app.bicep); when the env var is empty, this
# ARG-derived ENV is the canonical fallback.
ARG GIT_COMMIT_SHA=unknown
ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates dumb-init \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system tokenscope && useradd --system --gid tokenscope --create-home tokenscope

COPY --from=prod-deps --chown=tokenscope:tokenscope /app/node_modules ./node_modules
COPY --from=build --chown=tokenscope:tokenscope /app/.output ./.output
COPY --from=build --chown=tokenscope:tokenscope /app/drizzle ./drizzle
COPY --from=build --chown=tokenscope:tokenscope /app/scripts ./scripts
COPY --from=build --chown=tokenscope:tokenscope /app/entrypoint.sh ./entrypoint.sh
# The Claude Code plugin, served zipped by /api/v1/plugin (docs/design/self-served-marketplace.md).
COPY --from=build --chown=tokenscope:tokenscope /app/plugin ./plugin

ENV NODE_ENV=production
ENV NITRO_PORT=3000
ENV NITRO_HOST=0.0.0.0
ENV NUXT_TELEMETRY_DISABLED=1

EXPOSE 3000

USER tokenscope

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["./entrypoint.sh"]
