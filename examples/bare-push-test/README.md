# Espresso Push Test — Bare React Native

Single-screen bare React Native app exercising the Espresso Notify SDK
(`@espresso-notify/react-native`) via the imperative `PushClient` + `BareProvider` (FCM token)
path, with `react-native-notify-kit` for foreground display and event tracking.

Documentation: [React Native CLI guide](https://docs.espressonotify.com/docs/react-native/bare) · [SDK reference](https://docs.espressonotify.com/docs/react-native/reference) · Package: [`@espresso-notify/react-native`](https://www.npmjs.com/package/@espresso-notify/react-native) · [Website](https://espressonotify.com) · [Dashboard](https://espressonotify.com/login) · [Repository](https://github.com/espresso-notify/sdks)

## Versions

| Package | Version |
| --- | --- |
| React Native | 0.87.1 (`@react-native/*` 0.87.1, CLI 20.2.0) |
| React | 19.2.3 |
| `@react-native-firebase/app`, `/messaging` | 26.4.0 |
| `react-native-notify-kit` | 10.8.0 |
| `@react-native-clipboard/clipboard` | 1.16.3 (needs the `Podfile` fix below on the iOS 27 SDK) |
| TypeScript | ^6.0.3 |

## Prerequisites

- Node.js 22.11 or newer and npm.
- iOS: Xcode 27 with an iOS 27 simulator, and CocoaPods 1.16 (`pod --version`).
- Android: Android SDK with an emulator image (API 36 was used), and JDK 21 in `JAVA_HOME`.
- A project and its public key (`pk_`, from the [dashboard](https://espressonotify.com/login)) if you want the SDK
  calls to reach the API. Not needed to open the app or see the permission dialog.

## What works without accounts

No Firebase, Apple Developer or EAS account is needed to:

- build and open the app on the iOS Simulator and the Android emulator;
- see the screen and request the notification permission (the system dialog shows).

Without the Firebase files the app opens, asks for the permission through
`react-native-notify-kit`, and the `error` row says
`Firebase is not configured: add google-services.json (Android) / GoogleService-Info.plist (iOS) to get an FCM token`.

An account is needed for:

- the FCM token: a Firebase project with its config files, and on iOS an APNs key from an Apple
  Developer account uploaded to Firebase;
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
cd examples/bare-push-test
npm install @espresso-notify/react-native@latest
rm .npmrc
```

In an app of your own, run `npm install @espresso-notify/react-native` (or the setup wizard) and follow the
[React Native CLI guide](https://docs.espressonotify.com/docs/react-native/bare).

**Another API (optional).** The SDK bakes the API URL in at build time. To point it at an API you run yourself, build the
folder with that URL:

```bash
npm ci --prefix sdk          # once
ESPRESSO_API_URL=http://localhost:8080 npm run build --prefix sdk
```

Use `http://10.0.2.2:8080` for the Android emulator and `http://<your-LAN-IP>:8080` for a physical device (the API
listening on `0.0.0.0`). This rewrites `sdk/dist/` locally (the versioned build points at the production API). Do not
commit it; `git checkout -- sdk/dist` restores the versioned build.

### 2. Install

```bash
cd examples/bare-push-test
npm install
```

`.npmrc` sets `install-links=true`, so npm copies the SDK package into `node_modules` instead of
linking `../../sdk` (Metro cannot follow that link, and it would pull a second `react`). After you
rebuild the SDK, refresh the copy: `rm -rf node_modules/@espresso-notify && npm install`.

### 3. Generate the native projects

This folder ships **source only**. Generate `android/` and `ios/` once with the same React Native
version and the project name `barepushtest` (the name `index.js` registers), then copy the two
iOS files from `native/ios/` over the generated ones:

```bash
npx @react-native-community/cli@20.2.0 init barepushtest --version 0.87.1 \
  --directory .tmp-native --skip-install --install-pods false --skip-git-init
cp -R .tmp-native/android .tmp-native/ios .tmp-native/Gemfile .
rm -rf .tmp-native
cp native/ios/AppDelegate.swift ios/barepushtest/AppDelegate.swift
cp native/ios/Podfile ios/Podfile
```

`android/`, `ios/` and `Gemfile` are git-ignored. What the two iOS files change:

- `AppDelegate.swift`: apps built with the iOS 27 SDK abort at launch unless they adopt the UIScene
  life cycle, and the 0.87 template still creates the window in the app delegate. This version
  creates it in a `SceneDelegate`. It also calls `FirebaseApp.configure()` only when
  `GoogleService-Info.plist` is in the app bundle, so the app opens before Firebase is set up.
- `Podfile`: dynamic frameworks (React Native Firebase 26 resolves the Firebase iOS SDK through
  Swift Package Manager, which needs them), and `-framework CoreServices` for the clipboard module.
  With the iOS 27 SDK, `MobileCoreServices` no longer brings in the `UTType*` symbols that
  `@react-native-clipboard/clipboard` 1.16.3 (the latest) calls, and its framework fails to link.

### 4. Build and open

iOS:

```bash
(cd ios && pod install)      # or: bundle install && (cd ios && bundle exec pod install)
npm run ios
```

Android:

```bash
npm run android
```

The debug APK carries every CPU architecture (about 118 MB). On an emulator with little free
storage, `npm run android -- --active-arch-only` builds only the emulator's (about 40 MB).

The debug build loads JavaScript from Metro on port 8081; stop any other Metro server first. If you
must use another port (`npx react-native start --port 8083`), point the installed app at it:

- iOS Simulator: `xcrun simctl spawn booted defaults write org.reactjs.native.example.barepushtest RCT_jsLocation localhost:8083`
  (passing `--port` at build time did not change the port with the prebuilt React Native 0.87 core);
- Android emulator: dev menu → Settings → Debug server host → `10.0.2.2:8083`.

The app asks for the notification permission on start; the **Request permission** button asks
again.

## Firebase (FCM token)

Follow the [React Native Firebase getting-started guide](https://rnfirebase.io/). In this example:

- **iOS:** add `GoogleService-Info.plist` to the `barepushtest` target in Xcode. The
  `AppDelegate.swift` from `native/ios/` configures Firebase when the file is there. Upload an
  APNs key (`.p8`) in Firebase Console → Cloud Messaging.
- **Android:** place `google-services.json` at `android/app/google-services.json` and apply the
  `com.google.gms.google-services` Gradle plugin (classpath in `android/build.gradle`, `apply plugin`
  in `android/app/build.gradle`), as the guide shows.

In an app of your own the setup wizard (`npx @espresso-notify/react-native@latest setup`, in the root
folder of the app) makes the Podfile, Gradle and `AppDelegate` Firebase edits for you, each between
`espresso-notify` markers with a copy of the original next to the file, and prints what stays
yours. This example keeps its own `Podfile` and `AppDelegate.swift` because of the iOS 27 and
clipboard changes above. The Android build fails until `google-services.json` is in place.

The `.example` files in this folder show the shape of each file.

## Project key

Set `PROJECT_ID` in `src/config.ts` to your `pk_live_…` key. Without it the app uses a placeholder;
the screen and the permission dialog still work.

> Foreground tap / received / dismissed are auto-tracked by the SDK's `BareDisplayAdapter`.
> Background tap is wired in `index.js` via `notifyKit.onBackgroundEvent`.

## What the screen does

Seven sections: status · permission · push token (copy) · identify/logout (`usePushIdentity`) ·
received list (notify-kit `onForegroundEvent` / `DELIVERED`) · tracking+metadata buttons · event log.

## Check what the JavaScript network tools show (manual check)

The SDK sends its requests through a small native module of its own, so the JavaScript network tools of a development
build should not list them. This keeps the SDK out of those tools and nothing more: a proxy or a native profiler still
sees the traffic, and a release build has no such tools. Nothing here is automated: check it on your own device.

1. Start your API (or use the production one; step 1 builds the SDK for it) and the tools: Reactotron with its `networking` plugin on and React
   Native DevTools with its Network panel (React Native 0.83 or newer; this example is on 0.87).
2. Build and open a development build. In the **Status** section the **transport** row reads `native` when the module is
   built into the app. It reads `js` in Expo Go and in a build where the module is not linked, which is expected.
3. Use the app: ask for the permission, identify a user, press `trackAppOpened`, `updateMetadata` and `registerCategories`.
   These buttons need the client, which needs the Firebase files (see Firebase above). Without them the **transport** row
   reads `native (no client yet)` and nothing is sent.
4. Expect no request of the SDK in the two tools. The calls of your own code stay.
5. Control: put the device behind Charles or Proxyman (an API over plain `http` needs no certificate on the device).
   The requests of the SDK must show there. If they do not, the proxy is not seeing the device and step 4 proves nothing.
6. Repeat with `privateTransport: 'js'` in the options of `new PushClient({...})` in `src/pushClient.ts`: the **transport** row reads
   `js` and the requests of the SDK must now show in both tools, which proves the tools were working. To keep
   that mode out of Reactotron, add the API host to `ignoreUrls` of its plugin, for example
   `networking({ ignoreUrls: /api\.example\.com/ })` with the host your app calls.

Write down what you saw (the tool, its version, the build) in your notes.

## Sending a test push

Receiver only. Trigger sends from the [dashboard](https://espressonotify.com/login) or the [`/v1` API](https://docs.espressonotify.com/docs/api/sending). Include `notificationId` in the
push `data` payload so tracking resolves the right id.

### The push was accepted but nothing popped up on the Android emulator

Check first that it arrived. On an Android 16 emulator (Google Play image, no Google account signed in), a
push that FCM accepted was posted by FCM and was sitting in the notification shade, unread, while nothing had popped up:

1. Pull down the notification shade on the emulator. The push is listed under `barepushtest`.
2. Or ask the system, from the repository root, with the serial of the emulator (never a bare `adb`, which fails or picks a
   phone when more than one device is connected):

   ```bash
   adb -s emulator-5554 shell dumpsys notification | grep -A3 "pkg=com.barepushtest"
   ```

   An FCM push shows as a `NotificationRecord` with the tag `FCM-Notification:<number>` and the channel
   `fcm_fallback_notification_channel`.

Why no banner: a push sent without a `channel_id` goes to that channel, which has default importance, and Android shows a
default-importance notification in the shade and the status bar but does not pop a banner. This example creates no channel
of its own. A phone can differ because its maker may add banners. To see a banner on the emulator, create a channel with
high importance in the app (with `react-native-notify-kit`) and send its `channel_id`, or set it as the default channel
with the `com.google.firebase.messaging.default_notification_channel_id` entry in `AndroidManifest.xml`.

Two things that do stop a push from showing: the app is in the foreground (the system does not show a push that arrives
while the app is open; `react-native-notify-kit` shows it from the foreground handler), and an emulator image without
Google Play services.
