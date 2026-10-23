# Espresso Push Test — Expo

Single-screen Expo development build that exercises the Espresso Notify React Native SDK
(`@espresso-notify/react-native`) through the `usePushNotifications` hook, the recommended Expo
integration path.

Documentation: [Expo quickstart](https://docs.espressonotify.com/docs/react-native/expo) · [SDK reference](https://docs.espressonotify.com/docs/react-native/reference) · Package: [`@espresso-notify/react-native`](https://www.npmjs.com/package/@espresso-notify/react-native) · [Website](https://espressonotify.com) · [Dashboard](https://espressonotify.com/login) · [Repository](https://github.com/espresso-notify/sdks)

The app passes `onNotificationOpened` to the hook: tap a notification (or open the app from one) and the
**last tap** row of the Status section shows its id and `url`. Taps are also reported as `opened`, and an event
that fails to send is kept by the offline queue of the SDK and sent again.

> **Expo Go is not supported.** Push notifications need native config, so the app runs as a
> development build (`npx expo run:ios` / `npx expo run:android`).

## Versions

| Package | Version |
| --- | --- |
| Expo SDK | 57 (`expo` ~57.0.26) |
| React Native | 0.86.3 (the version Expo SDK 57 ships) |
| React | 19.2.3 |
| `expo-notifications` | ~57.0.21 |
| TypeScript | ~6.0.3 |

## Prerequisites

- Node.js 22.11 or newer and npm.
- iOS: Xcode 27 with an iOS 27 simulator, and CocoaPods (`pod --version`).
- Android: Android SDK with an emulator image (API 36 was used), and JDK 21 in `JAVA_HOME`.
- A project and its public key (`pk_`, from the [dashboard](https://espressonotify.com/login)) if you want the SDK
  calls to reach the API. Not needed to open the app or see the permission dialog.

## What works without accounts

No Firebase, Apple Developer or EAS account is needed to:

- build and open the app on the iOS Simulator and the Android emulator;
- see the screen and request the notification permission (the system dialog shows).

An account is needed for:

- the push token. The Expo push token needs an EAS project (`extra.eas.projectId`) and, on a
  device, Apple (APNs) or Firebase (FCM) credentials. Without them the token stays `(none yet)`
  and the `error` row shows the SDK error (code `EXPO_PROJECT_ID_MISSING` when the EAS project
  id is not set, `PUSH_TOKEN_UNAVAILABLE` otherwise). The app does not close and does not register
  the device without a token.
- receiving a notification.

## Run it, in order

All paths are from the repository root.

### 1. The SDK

The app installs the SDK from the folder `sdk/` of this repository (`"@espresso-notify/react-native": "file:../../sdk"`).
Its `dist/` is the published build, which talks to the production API, `https://api.espressonotify.com`, so for a first
run there is nothing to build.

**Use the npm package instead.** The package is on npm, so the folder is not needed. In this example, replace the link
and drop the `.npmrc` (it only exists to copy the folder instead of linking it):

```bash
cd examples/expo-push-test
npm install @espresso-notify/react-native@latest
rm .npmrc
```

In an app of your own, run `npx expo install @espresso-notify/react-native` and follow the
[Expo quickstart](https://docs.espressonotify.com/docs/react-native/expo).

**Another API (optional).** The SDK bakes the API URL in at build time. To point it at an API you run yourself, build the
folder with the URL for your run target:

```bash
npm ci --prefix sdk          # once
ESPRESSO_API_URL=http://localhost:8080 npm run build --prefix sdk
```

| Target | `ESPRESSO_API_URL` |
| --- | --- |
| iOS Simulator | `http://localhost:8080` |
| Android emulator | `http://10.0.2.2:8080` |
| Physical device | `http://<your-LAN-IP>:8080` (the API listening on `0.0.0.0`) |

This rewrites `sdk/dist/` locally (the versioned build points at the production API). Do not commit it;
`git checkout -- sdk/dist` restores the versioned build.

### 2. Project key (optional)

```bash
cd examples/expo-push-test
cp .env.example .env         # set EXPO_PUBLIC_ESPRESSO_PROJECT_ID to your pk_live_… key
```

Without it the app uses a placeholder key; the screen and the permission dialog still work.

### 3. Install

```bash
npm install
```

`.npmrc` sets `install-links=true`, so npm copies the SDK package into `node_modules` (only
`dist/` and `app.plugin.js`, like an npm install) instead of linking `../../sdk`. That keeps a
single copy of `react` and `react-native` in the bundle. After you rebuild the SDK, refresh the
copy:

```bash
rm -rf node_modules/@espresso-notify && npm install
```

### 4. Build and open

```bash
npx expo run:ios             # or: npx expo run:android
```

`expo run:*` runs `expo prebuild` first, which generates `ios/` and `android/` (git-ignored, never
committed), then builds, installs and starts Metro. If port 8081 is taken, add `--port 8082`.

The app asks for the notification permission on start; the **Request permission** button asks
again.

## Native config

`app.json` loads two config plugins:

- `@espresso-notify/react-native`: `aps-environment`, the `remote-notification` background mode
  and `POST_NOTIFICATIONS`. It also applies the `expo-notifications` config plugin, so that one is
  not listed.
- `./plugins/with-scene-lifecycle`: apps built with the iOS 27 SDK abort at launch unless they
  adopt the UIScene life cycle. Expo SDK 57 ships `ExpoAppSceneDelegate`, but its prebuild template
  still creates the window in the app delegate. The plugin registers the scene delegate in
  `Info.plist` and moves the window out of `AppDelegate.swift`. It stops with an error if a future
  template no longer matches.

## What the screen does

One scrollable screen with seven sections:

1. **Status** — runtime capabilities, permission status, platform, resolved provider/adapter, and
   the last error.
2. **Permission** — request the OS push permission.
3. **Push token** — show the Expo push token + copy to clipboard.
4. **Identity** — type an external user id → `identify()`; logout → `unregister()` (reactive via the hook's `externalId`).
5. **Received** — live list of foreground notifications (`expo-notifications` listener).
6. **Tracking + metadata** — `trackOpen/click/received/dismissed/appOpened`, `updateMetadata`, `registerCategories`.
7. **Event log** — every SDK call with its result or error.

## Check what the JavaScript network tools show (manual check)

The SDK sends its requests through a small native module of its own, so the JavaScript network tools of a development
build should not list them. This keeps the SDK out of those tools and nothing more: a proxy or a native profiler still
sees the traffic, and a release build has no such tools. Nothing here is automated: check it on your own device.

1. Start your API (or use the production one; step 1 builds the SDK for it) and the tools: Reactotron with its `networking` plugin on, React
   Native DevTools with its Network panel (React Native 0.83 or newer; this example is on 0.86), and the Expo dev-client
   Network panel.
2. Build and open a development build. In the **Status** section the **transport** row reads `native` when the module is
   built into the app. It reads `js` in Expo Go and in a build where the module is not linked, which is expected.
3. Use the app: ask for the permission, identify a user, press `trackAppOpened`, `updateMetadata` and `registerCategories`.
4. Expect no request of the SDK in the three tools. The calls of your own code stay, and so does the call of
   `expo-notifications` to `exp.host`; `tokenStrategy: 'device'` avoids that one.
5. Control: put the device behind Charles or Proxyman (an API over plain `http` needs no certificate on the device).
   The requests of the SDK must show there. If they do not, the proxy is not seeing the device and step 4 proves nothing.
6. Repeat with `privateTransport: 'js'` in the options of `usePushNotifications` in `App.tsx`: the **transport** row reads
   `js` and the requests of the SDK must now show in all three tools, which proves the tools were working. To keep
   that mode out of Reactotron, add the API host to `ignoreUrls` of its plugin, for example
   `networking({ ignoreUrls: /api\.example\.com/ })` with the host your app calls.

Write down what you saw (the tool, its version, the build) in your notes.

## Sending a test push

This app only **receives**. Trigger a send from the [dashboard](https://espressonotify.com/login) or the
[`/v1` API](https://docs.espressonotify.com/docs/api/sending) targeting the registered token / user. The notification payload must include `notificationId` in its `data` for
tracking to resolve the right id.
