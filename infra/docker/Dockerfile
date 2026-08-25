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
