#!/bin/bash
# CFBundleExecutable for the packaged .app. Puts the bundled helper on
# PATH, exports BENTO_HELPER for the native core, then runs the real binary.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
HELPER="$DIR/../Resources/helper/bento"
export BENTO_HELPER="$HELPER"
export PATH="/usr/local/bin:/opt/homebrew/bin:$(dirname "$HELPER"):$PATH"
exec "$DIR/mac-bin" "$@"
