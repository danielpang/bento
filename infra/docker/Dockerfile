# syntax=docker/dockerfile:1
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

# Symbolicate the web console's browser exceptions in PostHog error
# tracking. `vite build` writes hidden source maps beside each bundle;
# here the PostHog CLI stamps a chunk id into the shipped JS and its map
# so a minified frame resolves to real code, then uploads the maps. The
# `.map` files are deleted afterwards, so they never reach the served
# image: the chunk ids ship, the maps do not.
#
# The API key arrives as a build secret, never a build arg, so it stays
# out of the image history. The whole step runs only when that secret is
# present, so a local `docker compose` build and a deploy before the
# secret exists both skip the upload and only strip the maps. It is
# best-effort: a CLI or network failure must not fail a deploy, since a
# missed upload only costs one release its symbols.
ARG POSTHOG_CLI_PROJECT_ID
ARG RELEASE_VERSION
RUN --mount=type=secret,id=posthog_cli_api_key \
    if [ -s /run/secrets/posthog_cli_api_key ]; then \
      export POSTHOG_CLI_API_KEY="$(cat /run/secrets/posthog_cli_api_key)" POSTHOG_CLI_PROJECT_ID; \
      npx --yes @posthog/cli@0.7.8 sourcemap inject --directory apps/web/dist \
      && npx --yes @posthog/cli@0.7.8 sourcemap upload --directory apps/web/dist \
           --release-name bento-web --release-version "${RELEASE_VERSION:-dev}" \
      || echo "posthog-cli sourcemap step failed; shipping web build without symbol upload"; \
    fi \
 && find apps/web/dist -name '*.map' -delete

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
