#!/usr/bin/env bash
#
# Run the CLI against the code you just edited.
#
# apps/tui runs straight from TypeScript through tsx, so its own source
# is always live and never needs building. Everything it imports resolves
# to dist, because each workspace package exports ./dist/index.js and
# there are no source aliases, so those are rebuilt first. Turbo caches
# per package, so an unchanged tree costs milliseconds.
#
# Arguments pass through: scripts/dev-cli.sh setup, --server <url>, and
# so on.
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm turbo run build --filter='@bento/tui^...' --output-logs=errors-only

exec pnpm -C apps/tui exec tsx src/cli.tsx "$@"
