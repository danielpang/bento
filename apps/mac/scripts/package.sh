#!/bin/sh
# Builds an unsigned Bento.app at apps/mac/target/bundle/Bento.app: the release binary, the
# bundled local server (sidecar dist with Postgres), and a node binary to run it with.
#
#   scripts/package.sh              uses sidecar/dist as it is (bundles it first when missing)
#   scripts/package.sh --sidecar    rebuilds sidecar/dist first
#
# BENTO_NODE_BINARY picks the node to bundle (default: the `node` on PATH, which must be 22 or
# later and an official build that links only system libraries).
set -eu

here=$(cd "$(dirname "$0")/.." && pwd)
repo=$(cd "$here/../.." && pwd)
out="$here/target/bundle/Bento.app"
dist="$here/sidecar/dist"

if [ "${1:-}" = "--sidecar" ] || [ ! -f "$dist/bin/sidecar.mjs" ]; then
  (cd "$repo" && pnpm --filter "@bento/mac-sidecar^..." build && pnpm --filter @bento/mac-sidecar bundle)
fi

node_bin=${BENTO_NODE_BINARY:-$(command -v node || true)}
[ -n "$node_bin" ] || { echo "No node found. Set BENTO_NODE_BINARY." >&2; exit 1; }
node_bin=$(cd "$(dirname "$node_bin")" && pwd -P)/$(basename "$node_bin")
[ -L "$node_bin" ] && node_bin=$(readlink -f "$node_bin")
major=$("$node_bin" -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] || { echo "node $major is too old; the sidecar needs 22 or later." >&2; exit 1; }
if otool -L "$node_bin" | tail -n +2 | grep -v -e '^\s*/usr/lib/' -e '^\s*/System/' >/dev/null; then
  echo "$node_bin links libraries outside the system (a Homebrew build?). Use an official node build." >&2
  exit 1
fi

cargo build --release -p bento-app --manifest-path "$here/Cargo.toml"
version=$(sed -n 's/^version = "\(.*\)"/\1/p' "$here/Cargo.toml" | head -n 1)

rm -rf "$out"
mkdir -p "$out/Contents/MacOS" "$out/Contents/Resources"
cp "$here/target/release/bento-mac" "$out/Contents/MacOS/bento-mac"
# ditto keeps the symlinks the Postgres libraries were thinned to.
ditto "$dist" "$out/Contents/Resources/sidecar"
cp "$node_bin" "$out/Contents/Resources/sidecar/bin/node"
chmod 755 "$out/Contents/Resources/sidecar/bin/node"

icon="$repo/apps/desktop/assets/icon.png"
set_dir=$(mktemp -d)/Bento.iconset
mkdir -p "$set_dir"
for size in 16 32 128 256 512; do
  sips -z $size $size "$icon" --out "$set_dir/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$icon" --out "$set_dir/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$set_dir" -o "$out/Contents/Resources/Bento.icns"
rm -rf "$(dirname "$set_dir")"

cat > "$out/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>ai.usebento.mac</string>
  <key>CFBundleName</key><string>Bento</string>
  <key>CFBundleDisplayName</key><string>Bento</string>
  <key>CFBundleExecutable</key><string>bento-mac</string>
  <key>CFBundleIconFile</key><string>Bento</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>$version</string>
  <key>CFBundleVersion</key><string>$version</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.developer-tools</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST

echo "$out"
