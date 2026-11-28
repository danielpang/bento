#!/usr/bin/env bash
# Signs target/bundle/Bento.app (built by package.sh) with Developer ID and the hardened runtime,
# notarizes and staples it, and only then writes Bento-<version>-<arch>.dmg and .zip beside it.
#
#   scripts/sign.sh              sign, notarize, staple, package
#   scripts/sign.sh --sign-only  sign and verify; no notarization, no dmg or zip
#   scripts/sign.sh --dry-run    sign ad hoc, skip notarization, package (for local testing)
#
# BENTO_SIGN_IDENTITY picks the identity (name or SHA-1) when the keychain has more than one
# Developer ID Application identity. Notarization takes, in this order: BENTO_NOTARY_PROFILE (a
# `notarytool store-credentials` profile), APPLE_NOTARY_KEY with APPLE_NOTARY_KEY_ID and
# APPLE_NOTARY_ISSUER_ID (an App Store Connect API key), or APPLE_ID with
# APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
out="$here/target/bundle"
app="$out/Bento.app"
entitlements="$here/scripts/entitlements"
mode=release
case "${1:-}" in
  "") ;;
  --sign-only) mode=sign-only ;;
  --dry-run) mode=dry-run ;;
  *) echo "Unknown option: $1" >&2; exit 2 ;;
esac

die() {
  echo "sign.sh: $*" >&2
  exit 1
}

[ -x "$app/Contents/MacOS/bento-mac" ] || die "No $app. Run scripts/package.sh first."
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Contents/Info.plist")
arch=$(lipo -archs "$app/Contents/MacOS/bento-mac")
case "$arch" in arm64) ;; x86_64) arch=x64 ;; *) die "Expected a single architecture app, found: $arch" ;; esac

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

notary=()
if [ "$mode" = release ]; then
  if [ -n "${BENTO_NOTARY_PROFILE:-}" ]; then
    notary=(--keychain-profile "$BENTO_NOTARY_PROFILE")
  elif [ -n "${APPLE_NOTARY_KEY:-}" ]; then
    [ -n "${APPLE_NOTARY_KEY_ID:-}" ] && [ -n "${APPLE_NOTARY_ISSUER_ID:-}" ] || die "APPLE_NOTARY_KEY needs APPLE_NOTARY_KEY_ID and APPLE_NOTARY_ISSUER_ID."
    (umask 077 && printf '%s\n' "$APPLE_NOTARY_KEY" > "$work/notary.p8")
    notary=(--key "$work/notary.p8" --key-id "$APPLE_NOTARY_KEY_ID" --issuer "$APPLE_NOTARY_ISSUER_ID")
  elif [ -n "${APPLE_ID:-}" ]; then
    [ -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ] || die "APPLE_ID needs APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID."
    notary=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
  else
    die "No notarization credentials. Set BENTO_NOTARY_PROFILE, APPLE_NOTARY_KEY (with _KEY_ID and _ISSUER_ID), or APPLE_ID (with APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID), or pass --sign-only."
  fi
fi

if [ "$mode" = dry-run ]; then
  identity=- timestamp=--timestamp=none
else
  identity=${BENTO_SIGN_IDENTITY:-}
  if [ -z "$identity" ]; then
    found=$(security find-identity -v -p codesigning | sed -n 's/^ *[0-9]*) \([0-9A-F]\{40\}\) "\(Developer ID Application: .*\)"$/\1 \2/p')
    [ -n "$found" ] || die "No Developer ID Application identity in the keychain."
    [ "$(printf '%s\n' "$found" | wc -l | tr -d ' ')" = 1 ] || die "More than one Developer ID Application identity; set BENTO_SIGN_IDENTITY to one of:
$found"
    identity=${found%% *}
  fi
  timestamp=--timestamp
fi

sign() {
  local args=(--force "$timestamp" --options runtime --sign "$identity")
  [ -z "${2:-}" ] || args+=(--entitlements "$2")
  codesign "${args[@]}" "$1"
}

xattr -cr "$app"
# Every Mach-O file, deepest first, then the app. Symlinks are sealed with the bundle, not signed.
find "$app/Contents" -type f -print0 | while IFS= read -r -d '' file; do
  case "$(file -b --mime-type "$file")" in application/x-mach-binary*) printf '%s\n' "$file" ;; esac
done | awk -F/ '{ print NF "\t" $0 }' | sort -t "$(printf '\t')" -k1,1nr | cut -f2- > "$work/list"
echo "Signing $(wc -l < "$work/list" | tr -d ' ') files in $app"
while IFS= read -r item; do
  case "$item" in
    "$app/Contents/Resources/sidecar/bin/node") sign "$item" "$entitlements/node.plist" ;;
    *) sign "$item" ;;
  esac
done < "$work/list"
sign "$app"
codesign --verify --deep --strict --verbose=2 "$app"
[ "$mode" = sign-only ] && exit 0

if [ "$mode" = release ]; then
  ditto -c -k --sequesterRsrc --keepParent "$app" "$work/Bento.zip"
  xcrun notarytool submit "$work/Bento.zip" "${notary[@]}" --wait --timeout 60m --output-format json > "$work/submit.json" || true
  cat "$work/submit.json"
  id=$(plutil -extract id raw -o - "$work/submit.json" 2>/dev/null || true)
  status=$(plutil -extract status raw -o - "$work/submit.json" 2>/dev/null || true)
  if [ "$status" != Accepted ]; then
    [ -z "$id" ] || xcrun notarytool log "$id" "${notary[@]}" || true
    die "Notarization ended as '${status:-no status}'."
  fi
  xcrun stapler staple "$app"
  xcrun stapler validate "$app"
  spctl --assess --type execute --verbose=2 "$app"
fi

name="Bento-$version-$arch"
rm -f "$out/$name.zip" "$out/$name.dmg"
ditto -c -k --sequesterRsrc --keepParent "$app" "$out/$name.zip"
mkdir "$work/dmg"
ditto "$app" "$work/dmg/Bento.app"
ln -s /Applications "$work/dmg/Applications"
hdiutil create -quiet -volname Bento -srcfolder "$work/dmg" -fs HFS+ -format UDZO -ov "$out/$name.dmg"
echo "$out/$name.dmg"
echo "$out/$name.zip"
