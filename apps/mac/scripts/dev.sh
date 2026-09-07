#!/usr/bin/env bash
#
# Run the Mac app in development with a helper that does not need a
# globally linked `bento` on PATH. The app reads BENTO_HELPER at launch.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
HELPER="$(cd "$(dirname "$0")" && pwd)/bento-from-source"
chmod +x "$HELPER"
export BENTO_HELPER="$HELPER"
# GUI-like PATH gaps: keep docker and homebrew tools reachable.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$ROOT/apps/mac"
exec "$ROOT/node_modules/.bin/native" dev "$@"
