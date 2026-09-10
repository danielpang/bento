#!/usr/bin/env bash
# Install the Bento CLI from a GitHub release. No pnpm or checkout required.
# curl -fsSL https://github.com/danielpang/bento/releases/latest/download/install.sh | bash
# Pin a release: bash install.sh v1.2.3
set -euo pipefail

# Stamped by package-cli.mjs so a release's installer always selects that release.
RELEASE_VERSION=""
REPO="${BENTO_GITHUB_REPO:-danielpang/bento}"
VERSION="${1:-${BENTO_VERSION:-$RELEASE_VERSION}}"

err() { echo "error: $*" >&2; exit 1; }
for command in curl tar node; do
  command -v "$command" >/dev/null 2>&1 || err "$command is required"
done
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 19) ? 0 : 1)' \
  || err "Node.js 22.19 or newer is required (found $(node -v)). Install Node.js, then run this installer again."

# Match the Node runtime, including when it runs under Rosetta on an Apple Mac.
PLATFORM="$(node -p 'process.platform + "-" + process.arch')"
case "$PLATFORM" in
  darwin-arm64|darwin-x64|linux-arm64|linux-x64) ;;
  *) err "Unsupported platform: $PLATFORM. Use macOS or Linux (x64 or arm64)." ;;
esac
if [[ "$PLATFORM" == linux-* ]]; then
  node -e 'process.exit(process.report.getReport().header.glibcVersionRuntime ? 0 : 1)' \
    || err "This release requires glibc Linux. Alpine/musl is not supported."
fi

if [ -z "$VERSION" ]; then
  VERSION="$(curl --fail --silent --show-error --location --retry 3 \
    "https://api.github.com/repos/$REPO/releases/latest" \
    | node -e 'let data="";process.stdin.on("data", x => data+=x);process.stdin.on("end", () => {const tag=JSON.parse(data).tag_name;if(typeof tag!=="string")process.exit(1);console.log(tag)})')" \
    || err "Could not resolve the latest release for $REPO. Specify a version explicitly."
fi
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]] \
  || err "Invalid version. Use a tag such as v1.2.3 or v1.2.3-rc.1."

ASSET="bento-cli-$VERSION-$PLATFORM.tar.gz"
RELEASE_URL="https://github.com/$REPO/releases/download/$VERSION"
TMP="$(mktemp -d)"
STAGING=""
BACKUP=""
LINK_STAGING=""
cleanup() {
  rm -rf "$TMP"
  if [ -n "$STAGING" ]; then rm -rf "$STAGING"; fi
  if [ -n "$LINK_STAGING" ]; then rm -f "$LINK_STAGING"; fi
  if [ -n "$BACKUP" ] && [ -d "$BACKUP" ]; then
    if [ ! -e "$INSTALL_ROOT" ]; then mv "$BACKUP" "$INSTALL_ROOT"; else rm -rf "$BACKUP"; fi
  fi
}
trap cleanup EXIT

echo "Downloading Bento $VERSION for $PLATFORM"
curl --fail --silent --show-error --location --retry 3 "$RELEASE_URL/$ASSET" -o "$TMP/$ASSET"
curl --fail --silent --show-error --location --retry 3 "$RELEASE_URL/SHA256SUMS" -o "$TMP/SHA256SUMS"
node - "$TMP/$ASSET" "$TMP/SHA256SUMS" "$ASSET" <<'NODE'
const fs = require('node:fs');
const crypto = require('node:crypto');
const [archive, sums, name] = process.argv.slice(2);
const row = fs.readFileSync(sums, 'utf8').split(/\r?\n/).find(line => line.endsWith(`  ${name}`));
const expected = row?.slice(0, 64);
const actual = crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
if (!expected || !/^[a-f0-9]{64}$/.test(expected) || expected !== actual) {
  console.error('error: Release checksum verification failed. The existing installation was not changed.');
  process.exit(1);
}
NODE

tar -xzf "$TMP/$ASSET" -C "$TMP"
EXTRACTED="$TMP/bento-$VERSION"
[ -f "$EXTRACTED/dist/cli.js" ] && [ -x "$EXTRACTED/bento" ] || err "The release archive is missing the CLI."

if [ -n "${BENTO_INSTALL_DIR:-}" ]; then
  INSTALL_ROOT="$BENTO_INSTALL_DIR"
  BIN_DIR="${BENTO_BIN_DIR:-${HOME}/.local/bin}"
elif [ -w /usr/local/lib ] && [ -w /usr/local/bin ]; then
  INSTALL_ROOT="/usr/local/lib/bento"
  BIN_DIR="${BENTO_BIN_DIR:-/usr/local/bin}"
else
  INSTALL_ROOT="${HOME}/.local/lib/bento"
  BIN_DIR="${BENTO_BIN_DIR:-${HOME}/.local/bin}"
fi
# Resolve relative overrides before creating the installed command's symlink.
mkdir -p "$(dirname "$INSTALL_ROOT")" "$BIN_DIR"
INSTALL_ROOT="$(cd "$(dirname "$INSTALL_ROOT")" && pwd)/$(basename "$INSTALL_ROOT")"
BIN_DIR="$(cd "$BIN_DIR" && pwd)"
case "$INSTALL_ROOT" in
  /|*/.|*/..|/usr|/usr/local|/usr/local/lib|"$HOME"|"$BIN_DIR") err "Choose a dedicated directory for BENTO_INSTALL_DIR." ;;
esac
[ ! -L "$INSTALL_ROOT" ] || err "BENTO_INSTALL_DIR must be a directory, not a symlink."
[ ! -e "$INSTALL_ROOT" ] || [ -d "$INSTALL_ROOT" ] || err "BENTO_INSTALL_DIR is not a directory."
if [ -d "$INSTALL_ROOT" ] && [ -n "$(ls -A "$INSTALL_ROOT")" ]; then
  node - "$INSTALL_ROOT/package.json" <<'NODE' || err "BENTO_INSTALL_DIR contains files from another application. Choose a dedicated directory."
try {
  const manifest = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'));
  if (manifest.name !== '@bento/tui') process.exit(1);
} catch { process.exit(1); }
NODE
fi
[ -w "$(dirname "$INSTALL_ROOT")" ] && [ -w "$BIN_DIR" ] \
  || err "Install paths are not writable. Set BENTO_INSTALL_DIR and BENTO_BIN_DIR to user-owned directories."
[ ! -d "$BIN_DIR/bento" ] || err "$BIN_DIR/bento is a directory. Choose another BENTO_BIN_DIR."

STAGING="$(mktemp -d "$(dirname "$INSTALL_ROOT")/.bento-install.XXXXXX")"
cp -R "$EXTRACTED/." "$STAGING/"
INSTALLED_VERSION="$("$STAGING/bento" --version)" || err "The downloaded CLI could not start."
[ "$INSTALLED_VERSION" = "${VERSION#v}" ] || err "The downloaded CLI reports the wrong version: $INSTALLED_VERSION"
LINK_STAGING="$BIN_DIR/.bento-link-$(basename "$STAGING")"
ln -s "$INSTALL_ROOT/bento" "$LINK_STAGING"
if [ -d "$INSTALL_ROOT" ]; then
  BACKUP="$STAGING.previous"
  mv "$INSTALL_ROOT" "$BACKUP"
fi
mv "$STAGING" "$INSTALL_ROOT"
STAGING=""
mv -f "$LINK_STAGING" "$BIN_DIR/bento"
LINK_STAGING=""

echo "Installed Bento $VERSION"
echo "  files: $INSTALL_ROOT"
echo "  command: $BIN_DIR/bento"
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "Run: bento --help" ;;
  *) echo "Add this to your shell profile: export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac
