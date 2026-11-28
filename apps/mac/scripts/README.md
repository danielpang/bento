# Packaging and signing the Mac app

`package.sh` builds an unsigned `target/bundle/Bento.app`. `sign.sh` signs it with Developer ID and the hardened runtime, notarizes and staples it, and only then writes `Bento-<version>-<arch>.dmg` and `Bento-<version>-<arch>.zip` beside it. Both run from any folder.

```sh
BENTO_RELEASE_TAG=v1.2.3 apps/mac/scripts/package.sh
BENTO_NOTARY_PROFILE=bento-notary apps/mac/scripts/sign.sh
```

The version comes from `BENTO_RELEASE_TAG`, the same tag the Electron app's `package.mjs` reads. Without it, `git describe` names the checkout (for example `0.2.8-6-gdfc33df5-dirty`), which is fine for a local build and wrong for a release.

## Modes

`sign.sh` signs, notarizes, staples, checks the result with `spctl`, and packages. It refuses to start without notarization credentials.

`sign.sh --sign-only` signs with Developer ID and verifies the signature. Nothing is uploaded and no dmg or zip is written. Use it to test the signed app before notarizing.

`sign.sh --dry-run` signs ad hoc, skips notarization, and writes the dmg and zip. The result runs on this Mac only.

## Signing identity

The script uses the one "Developer ID Application" identity in the keychain. When there is more than one, set `BENTO_SIGN_IDENTITY` to its name or SHA-1 hash; the script lists them. List them yourself with `security find-identity -v -p codesigning`.

## Notarization credentials

Any one of these, checked in this order:

| Variables | What |
|---|---|
| `BENTO_NOTARY_PROFILE` | A profile saved with `xcrun notarytool store-credentials`. The simplest on a developer's Mac. |
| `APPLE_NOTARY_KEY`, `APPLE_NOTARY_KEY_ID`, `APPLE_NOTARY_ISSUER_ID` | An App Store Connect API key: the `.p8` file's contents, its key id, and the issuer id. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | An Apple ID with an app specific password. The names `.github/workflows/desktop.yml` already uses. |

To save a profile once (it asks for the app specific password and keeps it in the login keychain):

```sh
xcrun notarytool store-credentials bento-notary --apple-id <apple id> --team-id <team id>
```

A rejected submission prints Apple's log, which names each file it refused.

## Entitlements

Only the bundled `node` has any: `entitlements/node.plist` grants `com.apple.security.cs.allow-jit`, without which V8 crashes at its first compiled function under the hardened runtime. The Rust binary and Postgres need none. Postgres loads its own libraries and extension modules under library validation, which passes because the script signs every one of them with the same team.
