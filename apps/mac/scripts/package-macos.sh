#!/usr/bin/env bash
#
# Build a macOS .app that does not require a user-installed `bento` CLI.
# Bundles the TUI/server helper (and a Node binary) into Resources/helper,
# wraps the native executable so BENTO_HELPER points at that helper.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
MAC="$ROOT/apps/mac"
HELPER_STAGE="$MAC/.helper-stage"
NATIVE="$ROOT/node_modules/.bin/native"

cd "$ROOT"

echo "Building @bento/tui and its dependencies..."
pnpm turbo run build --filter='@bento/tui...' --output-logs=errors-only

echo "Deploying the helper package..."
rm -rf "$HELPER_STAGE"
pnpm --filter @bento/tui deploy --prod "$HELPER_STAGE"

CLI_JS=""
for candidate in "$HELPER_STAGE/dist/cli.js" "$HELPER_STAGE/cli.js"; do
  if [[ -f "$candidate" ]]; then
    CLI_JS="$candidate"
    break
  fi
done
if [[ -z "$CLI_JS" ]]; then
  echo "error: deployed helper has no dist/cli.js (did @bento/tui build?)" >&2
  exit 1
fi
CLI_REL="${CLI_JS#"$HELPER_STAGE/"}"

# Homebrew's `node` binary is not relocatable (it needs libnode and a pile of
# Cellar dylibs). The app launcher puts /opt/homebrew/bin and /usr/local/bin
# on PATH, so the helper uses whatever Node is already on the machine.
cat > "$HELPER_STAGE/bento" << EOF
#!/bin/bash
set -euo pipefail
DIR="\$(cd "\$(dirname "\$0")" && pwd)"
if ! command -v node >/dev/null 2>&1; then
  echo "bento:error Node.js was not found. Install Node 22+ (https://nodejs.org) and reopen Bento." >&2
  exit 127
fi
exec node "\$DIR/$CLI_REL" "\$@"
EOF
chmod +x "$HELPER_STAGE/bento"

echo "Building the native binary..."
cd "$MAC"
"$NATIVE" build
"$NATIVE" package --target macos

APP="$(find "$MAC/zig-out/package" -maxdepth 1 -name '*.app' -print -quit)"
if [[ -z "$APP" || ! -d "$APP" ]]; then
  echo "error: native package did not produce a .app under zig-out/package" >&2
  exit 1
fi

MACOS_DIR="$APP/Contents/MacOS"
RESOURCES="$APP/Contents/Resources"
if [[ ! -x "$MACOS_DIR/mac" ]]; then
  echo "error: expected $MACOS_DIR/mac" >&2
  exit 1
fi

echo "Injecting the bundled helper into $(basename "$APP")..."
mv "$MACOS_DIR/mac" "$MACOS_DIR/mac-bin"
cp "$MAC/scripts/macos-launcher.sh" "$MACOS_DIR/mac"
chmod +x "$MACOS_DIR/mac" "$MACOS_DIR/mac-bin"

rm -rf "$RESOURCES/helper"
mkdir -p "$RESOURCES"
cp -R "$HELPER_STAGE" "$RESOURCES/helper"
chmod +x "$RESOURCES/helper/bento"
# Drop a broken Homebrew node copy from earlier package attempts, if any.
rm -f "$RESOURCES/helper/node"

if command -v codesign >/dev/null 2>&1; then
  codesign --force --deep -s - "$APP" 2>/dev/null || true
fi

echo
echo "Packaged: $APP"
echo "Open with: open \"$APP\""
echo "Docker Desktop must be running for local mode and agent sandboxes."
