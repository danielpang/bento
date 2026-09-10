#!/usr/bin/env bash
# Install the Bento terminal CLI from a GitHub release tarball.
#
# Usage:
#   curl -fsSL https://github.com/danielpang/bento/releases/latest/download/install.sh | bash
#   BENTO_VERSION=v0.1.0 bash install.sh
#   bash install.sh v0.1.0
set -euo pipefail

REPO="${BENTO_GITHUB_REPO:-danielpang/bento}"
VERSION="${BENTO_VERSION:-${1:-}}"

err() {
  echo "error: $*" >&2
  exit 1
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1 || err "$1 is required"
}

need_cmd curl
need_cmd tar
need_cmd node

NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if [ "$NODE_MAJOR" -lt 22 ]; then
  err "Node.js 22 or newer is required (found $(node -v))"
fi

if [ -z "$VERSION" ]; then
  VERSION="$(
    curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
      | head -1
  )"
  [ -n "$VERSION" ] || err "could not resolve the latest release for $REPO"
fi

ASSET="bento-cli-$VERSION.tar.gz"
URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $URL"
curl -fsSL "$URL" -o "$TMP/$ASSET"
tar -xzf "$TMP/$ASSET" -C "$TMP"

EXTRACTED="$TMP/bento-$VERSION"
[ -d "$EXTRACTED" ] || err "unexpected archive layout (missing bento-$VERSION/)"

if [ -n "${BENTO_INSTALL_DIR:-}" ]; then
  INSTALL_ROOT="$BENTO_INSTALL_DIR"
  BIN_DIR="${BENTO_BIN_DIR:-${HOME}/.local/bin}"
elif [ "$(id -u)" -eq 0 ] || [ -w /usr/local/lib ] 2>/dev/null; then
  INSTALL_ROOT="/usr/local/lib/bento"
  BIN_DIR="/usr/local/bin"
else
  INSTALL_ROOT="${HOME}/.local/lib/bento"
  BIN_DIR="${HOME}/.local/bin"
fi

mkdir -p "$(dirname "$INSTALL_ROOT")" "$BIN_DIR"

install_tree() {
  rm -rf "$INSTALL_ROOT"
  cp -R "$EXTRACTED" "$INSTALL_ROOT"
  ln -sf "$INSTALL_ROOT/bento" "$BIN_DIR/bento"
}

if [ -w "$(dirname "$INSTALL_ROOT")" ] && [ -w "$BIN_DIR" ] 2>/dev/null; then
  install_tree
elif command -v sudo >/dev/null 2>&1; then
  echo "Installing to $INSTALL_ROOT (sudo may prompt for your password)"
  sudo rm -rf "$INSTALL_ROOT"
  sudo cp -R "$EXTRACTED" "$INSTALL_ROOT"
  sudo ln -sf "$INSTALL_ROOT/bento" "$BIN_DIR/bento"
else
  err "cannot write to $INSTALL_ROOT or $BIN_DIR; set BENTO_INSTALL_DIR or run with sudo"
fi

echo "Installed bento $VERSION"
echo "  files: $INSTALL_ROOT"
echo "  command: $BIN_DIR/bento"

if ! command -v bento >/dev/null 2>&1; then
  echo "Add $BIN_DIR to your PATH, then run: bento --help"
else
  echo "Run: bento --help"
fi
