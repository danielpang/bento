# The server and the web console, built and shipped from one image.
#
# Used by docker-compose.yml for the whole-stack local run and by
# infra/fly for deployment, so there is one definition of what a Bento
# server image contains rather than two that drift.
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/web ./apps/web

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @bento/server... build && pnpm --filter @bento/web... build

# Give PostHog the web build's source maps, then throw them away.
#
# A browser reports a minified stack: the console's one captured
# exception so far reads "RangeError: Maximum call stack size exceeded"
# at `Nk` and `Pk`, line 226 of `/`, which names nothing. PostHog can
# only undo that if it holds the maps, matched to the shipped chunks by
# an id stamped into both. `sourcemap process` does all three steps:
# stamp the chunks, upload chunks and maps, delete the maps.
#
# The maps are deleted whether or not the upload ran, because the final
# stage copies this one wholesale and the server serves /assets as
# static files: a shipped .map is the whole source, published.
# POSTHOG_HOST only for a deployment that is not on PostHog US cloud;
# empty leaves the CLI on its own default.
ARG POSTHOG_HOST
ARG POSTHOG_PROJECT_ID
ARG SOURCE_COMMIT
RUN --mount=type=secret,id=posthog_api_key \
    set -eu; \
    if [ -s /run/secrets/posthog_api_key ] && [ -n "${POSTHOG_PROJECT_ID:-}" ]; then \
      POSTHOG_CLI_API_KEY="$(cat /run/secrets/posthog_api_key)" \
      POSTHOG_CLI_PROJECT_ID="${POSTHOG_PROJECT_ID}" \
      npx --yes @posthog/cli@0.18.1 ${POSTHOG_HOST:+--host "${POSTHOG_HOST}"} \
        sourcemap process --directory apps/web/dist/assets --delete-after \
        --release-name bento-web --release-version "${SOURCE_COMMIT:-unknown}"; \
    else \
      echo "No PostHog credentials for this build: browser exceptions from it will stay minified."; \
    fi; \
    find apps/web/dist -name '*.map' -delete

RUN pnpm prune --prod

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
# BENTO_ENVIRONMENT is set per deployment (infra/fly/*.toml), not here:
# an image that claimed production labelled development that way too.

# The server makes the git worktrees agents work in, and it makes them
# itself rather than inside the sandbox, so git has to exist here. The
# slim image has none, and without it provisioning fails with a bare
# "spawn git ENOENT" before any sandbox is started.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app ./
EXPOSE 8080
# Migrations run at boot, guarded by an advisory lock so concurrent
# machines cannot race the same DDL.
CMD ["sh", "-c", "node packages/db/dist/migrate.js && node apps/server/dist/index.js"]
