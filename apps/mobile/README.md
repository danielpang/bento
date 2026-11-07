# Bento for iOS

An Expo SDK 55 / React Native client for hosted Bento, inside the existing pnpm workspace. It reuses `@bento/api-client` and `@bento/core`. Agent execution, permissions, and billing remain on the existing server.

## Current scope

- Browser device authorization, with the native bearer token stored in SecureStore.
- Team and project selection, stage filtering, search, and card creation.
- Card instructions, live agent output, paginated past conversations, and follow-up messages.
- Single-choice, multiple-choice, and free-text answers to agent questions.
- Start a backlog card, approve a gated stage, and open pull requests.
- Foreground stream recovery and cached data removal on team changes, expiry, and sign-out.

This is the first mobile milestone. Push notifications, artifact previews, pipeline editing, Swarms, local Mac connectivity, and App Store submission are not implemented. Set up repositories and agents in the web console first. The native client requires an HTTPS server with hosted authentication enabled.

## Develop

Use Node 22.19+ and the repository's pinned pnpm 9.15.4. From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm dev:mobile
```

Use an Expo development build on your iPhone or iOS Simulator. The default server is `https://app.usebento.ai`; the sign-in screen also accepts another HTTPS origin. Approve the displayed device code in the browser and return to Bento. No provider keys or Expo secrets belong in the app bundle.

Native requests use `expo/fetch`, which supplies the streaming response body the shared SSE client expects. Streams close in the background and resume from the last event sequence when the screen returns. Board reconnections refetch a snapshot. Pending questions refresh every ten seconds while the card is foregrounded, because they are not a separate SSE event. Mutations are never automatically retried.

The web export is for UI testing. It uses in-memory credentials and forgets them on refresh. Native builds persist credentials using Keychain through SecureStore.

## Verify

From the repository root:

```sh
pnpm build:mobile
pnpm --filter @bento/mobile typecheck
pnpm --filter @bento/mobile test
pnpm --filter @bento/mobile build:web
pnpm --filter @bento/mobile exec playwright install chromium
pnpm --filter @bento/mobile test:e2e
```

`build:mobile` builds shared packages, bundles the iOS app, and compiles its JavaScript to Hermes bytecode in `apps/mobile/dist`. This validates the Expo bundle; it does not compile or sign an IPA.

The Playwright workflow test runs the exported application at an iPhone-sized viewport against API fixtures. It covers sign-in, card creation, SSE output, question answers, messaging, approval, team isolation in the UI, and expired sessions. It is not a substitute for testing the native app against a real hosted account. To use system Chromium, set `CHROMIUM_PATH=/usr/bin/chromium`.

## Native builds

From `apps/mobile`, using an authenticated EAS CLI:

```sh
npx eas-cli login
npx eas-cli init
npx eas-cli build --platform ios --profile simulator
npx eas-cli build --platform ios --profile development
npx eas-cli build --platform ios --profile production
```

`eas init` links this app to your Expo project. Confirm ownership of `ai.usebento.mobile` before provisioning Apple credentials. Simulator builds do not need Apple signing; physical-device and production builds do. The EAS post-install hook builds the shared workspace packages before bundling.

Native directories are generated and ignored. Validate generation locally with:

```sh
pnpm exec expo prebuild --platform ios --no-install
```

On a Mac with Xcode and CocoaPods, use `pnpm exec expo run:ios` to compile and launch. On Linux, use EAS for the native build.

Before TestFlight, verify real browser sign-in and Keychain restoration, foreground/background recovery, questions from a running agent, approval behavior, large transcripts, VoiceOver, and team removal. Prepare the final app icon and App Store privacy/account requirements before public release.
