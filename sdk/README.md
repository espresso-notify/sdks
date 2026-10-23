# Espresso Notify React Native SDK

Official SDK for integrating [Espresso Notify](https://espressonotify.com) push notifications into **Expo** and **bare React Native** apps.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## Table of Contents

- [Overview](#overview)
- [Installation](#installation)
- [Expo Quickstart (hook)](#expo-quickstart-hook)
- [Expo Quickstart (imperative)](#expo-quickstart-imperative)
- [Expo Config Plugin](#expo-config-plugin)
- [Bare React Native Quickstart](#bare-react-native-quickstart)
- [Push Credentials (FCM / APNs)](#push-credentials-fcm--apns)
- [API Reference](#api-reference)
  - [PushClient](#pushclient)
  - [Devices](#devices)
  - [usePushNotifications](#usepushnotifications)
  - [usePushIdentity](#usepushidentity)
  - [capabilities()](#capabilities)
  - [Certificate Pinning](#certificate-pinning)
  - [Adapter Interfaces](#adapter-interfaces)
- [Private transport](#private-transport)
- [Event Tracking](#event-tracking)
- [Security Notes](#security-notes)

---

## Overview

One package, two operating modes:

| Mode | Token acquisition | Display / events |
|---|---|---|
| **Expo** | `expo-notifications` (`getExpoPushTokenAsync` or `getDevicePushTokenAsync`) | `expo-notifications` listeners |
| **Bare React Native** | `@react-native-firebase/messaging` (`getToken`) | `react-native-notify-kit` |

The SDK detects which libraries are available at runtime via `require` and selects the right adapters automatically. You can also override any adapter explicitly via constructor config.

**Requirements:**
- React Native 0.79+ (Expo SDK 53+). The hooks live at the `@espresso-notify/react-native/hooks` subpath, which Metro resolves only through `package.json` `exports`; Metro enables `exports` by default from RN 0.79 (Metro 0.82). On older versions `/hooks` does not resolve.
- **Expo Go is not supported for push notifications** since Expo SDK 53. You need a [development build](https://docs.expo.dev/develop/development-builds/introduction/).
- Peer dependencies: `react-native` >= 0.79.0 (required) and `react` >= 19.0.0. Every other peer (`expo-*`, `@react-native-firebase/*`, `react-native-notify-kit`, `react-native-secure-sign`, `react-native-ssl-public-key-pinning`, `react-native-ios-appattest`) is an optional peer, so a React Native CLI app does not get Expo modules from npm: install what your mode uses. In an Expo app `expo-notifications` and `expo-constants` are required; without `expo-notifications` the hook fails with an `[espresso-notify]` error that gives `npx expo install expo-notifications`.
- No runtime dependencies. The Expo packages the SDK reads have a floor, the version Expo SDK 53 ships (the SDK of React Native 0.79): `expo-notifications` 0.31, `expo-constants` 17.1, `expo-application` 6.1, `expo-device` 7.1, `expo-localization` 16.1, `expo-secure-store` 14.2 and `expo-crypto` 14.1. The Expo config plugin loads `expo/config-plugins`, so it needs `expo` 53 or newer in the app (every Expo app has it). For request signing, `expo-secure-store` or `@react-native-async-storage/async-storage` keeps the device id and the public key across app starts; with neither they live in memory and the device id changes on every cold start.
- Random bytes. The device id and the nonce of a signed request come from `crypto.getRandomValues` when the app has it (Hermes does not), else from the SDK's own native module (`SecureRandom` on Android, `SecRandomCopyBytes` on iOS), else from `expo-crypto`. Only an app with none of the three gets `Math.random`, with one warning per app run.

---

## Installation

> **Coming soon.** `@espresso-notify/react-native` is not published to npm yet: it will be published at launch, and until then `npm install` answers 404. The commands below are what you will run once it is out.

### Setup wizard

The same command sets up an Expo app (Expo SDK 53 or newer) and a React Native CLI app (`react-native` without `expo`, React Native 0.79 or newer); the folder decides which. In an Expo app it does the install and the config plugin:

```bash
npx @espresso-notify/react-native@latest setup
```

It runs `npx expo install` for the SDK and the six Expo packages, adds the config plugin to `app.json` or `app.config.json` (it never edits `app.config.js` / `app.config.ts`: when the file does not mention the plugin, and no `app.json` that lists it is spread into it with `...config`, it prints the line, says `1 manual step left` and exits with `2`; when the file mentions the plugin, or spreads the `config` of an `app.json` that lists it, it asks you to check it and exits with `0`, and never says the project is set up), checks `extra.eas.projectId`, refuses a secret key (`sk_`), prints the `usePushNotifications` snippet and the manual checklist (Firebase file and FCM V1 key, APNs key, development build). In a React Native CLI app it installs `@espresso-notify/react-native`, `@react-native-firebase/app`, `@react-native-firebase/messaging` and `react-native-notify-kit` with the package manager of the project (the lock file decides; major 26 of the two Firebase packages for React Native 0.80 or newer, major 25 for 0.79), and adds the Firebase lines to `ios/Podfile` (`use_frameworks! :linkage => :dynamic`), `android/build.gradle` and `android/app/build.gradle` (the `google-services` Gradle plugin) and `AppDelegate.swift` or `.mm` (`FirebaseApp.configure()`, guarded so the app opens before `GoogleService-Info.plist` is in it). Each change sits between `espresso-notify:begin` and `espresso-notify:end` comments, the original is copied next to the file as `<file>.espresso-notify-<timestamp>.bak` first, and a file the wizard does not recognize is left alone with its step printed (exit code `0`). On macOS it asks before it runs `pod install` (`--pods` runs it without asking). It prints what stays yours: the two Firebase files (the Android build fails until `google-services.json` is in place), the Xcode capabilities, the APNs key, the service account, the background handler in `index.js` and the iOS 27 scene life cycle. It was run on 2026-10-23 on apps of the React Native 0.87.1 template (iOS 27 simulator and Android emulator) and of the 0.79.7 template (Android emulator).

Flags: `--dry-run` (change nothing), `--yes` (ask nothing, for CI), `--key <pk>` and `--pods`. Exit codes: `0` done or nothing to do, `1` refused, `2` a step failed or a step is left for you. The Expo flow runs the same on Linux, macOS and Windows; the React Native CLI flow was run on macOS only. A second run changes nothing and says so. The manual steps follow.

### Base package

```bash
npm install @espresso-notify/react-native
# or
yarn add @espresso-notify/react-native
```

### Peer dependencies — choose your mode

**Expo (recommended for managed workflow):**

```bash
# One line. expo-notifications and expo-constants are required (push token and the
# EAS project id). expo-device, expo-application and expo-localization are optional:
# the SDK works without them, but the device then registers without its app version,
# OS version, language and time zone (without expo-localization, quiet hours and
# best-hour sending cannot use the time zone of the device). expo-secure-store keeps
# the device id and the signing key across restarts; without it (and without
# @react-native-async-storage/async-storage) they live in memory only, with a warning.
npx expo install expo-notifications expo-constants expo-device expo-application expo-localization expo-secure-store
```

The Expo config plugin applies the `expo-notifications` plugin for you: list only `"@espresso-notify/react-native"` in `plugins` (an optional `notifications` plugin option is forwarded as the options of `expo-notifications`). An app that still lists `expo-notifications` keeps its own entry.

**Bare React Native:**

```bash
# Required for FCM token acquisition and permissions
npm install @react-native-firebase/messaging

# Required for foreground display and event tracking
npm install react-native-notify-kit
```

**Optional — certificate pinning (both modes):**

```bash
npm install react-native-ssl-public-key-pinning
```

The package also ships a small native module that sends the SDK's requests (see [Private transport](#private-transport)). It links by itself, with no line in your `Podfile`, `settings.gradle` or `MainApplication`, but it is native code: after you install the package, build the app again (`pod install` and a native build in a React Native CLI app; `npx expo prebuild` and a native build, or an EAS Build, in an Expo app). Where it is not linked, the SDK sends through `fetch`.

> The SDK **never throws** when optional packages are absent. Missing Expo packages trigger one console warning per app run, in development builds only (never in production), listing what metadata fields are unavailable. Missing Firebase/notify-kit simply means `capabilities().pushProvider === 'none'` — the transport layer (register/identify/track) still works if you supply the push token explicitly.

---

## Expo Quickstart (hook)

The `usePushNotifications` hook is the simplest integration path. Place it once in your root layout — it handles permissions, token acquisition, registration, user identification/logout, token refresh, and cleanup automatically.

```tsx
// app/_layout.tsx (Expo Router) or App.tsx
import { usePushNotifications } from '@espresso-notify/react-native/hooks'
import { Stack } from 'expo-router'

function RootLayout() {
  const { userId } = useAuth() // your auth context

  usePushNotifications({
    projectId: 'pk_live_xxxxxxxxxxxx', // Your public project key from the dashboard
    externalId: userId ?? null,        // Reactive — hook manages identify/unregister
  })

  return <Stack />
}
```

The Expo push token needs your EAS project id. The SDK reads it from `extra.eas.projectId` in `app.json` / `app.config` (written by `eas init`), then from `Constants.easConfig.projectId`. Without either, pass it yourself:

```tsx
usePushNotifications({
  projectId: 'pk_live_xxxxxxxxxxxx',
  expoProjectId: 'your-eas-project-uuid',
})
```

If no project id is found, the hook does not register the device and `error.code` is `'EXPO_PROJECT_ID_MISSING'`.

What happens automatically:

| Event | Action |
|---|---|
| App opens (no user) | `requestPermission` → `getToken` → anonymous `register()` (tried again up to 6 times with a random wait when it fails with no answer, 408, 429 or 5xx) |
| `userId: null → "u1"` | `identify("u1")` |
| `userId: "u1" → null` | `unregister()` — token stays, device becomes anonymous |
| `userId: "u1" → "u2"` | `identify("u2")` — account switch, no re-registration needed |
| Token rotated by OS | `register()` the new token with your `metadata`, `identify()` the current user on it, then `recordLifecycle('subscription', ...)`, in this order (a token registered alone is anonymous). With a bare `PushClient` you do the same in your `onTokenRefresh` handler |
| App returns to foreground | Permission re-check + `recordLifecycle('permission', ...)` if changed. `register()` and `identify()` again only when the token, the app version or the user changed, or after 30 s or more out of the foreground (a new session); a call that failed is tried again here |
| Component unmounts | `destroy()` — all listeners cleaned up |

**Accessing the client for advanced use:**

```tsx
const { client, isReady, pushToken, permissionStatus, error } = usePushNotifications({
  projectId: 'pk_live_xxxxxxxxxxxx',
  externalId: userId ?? null,
  userName: user?.name ?? null,     // Passed to identify() automatically
  metadata: { plan: 'premium' },    // Device-level metadata sent on register
  autoRequestPermission: true,      // Set false to control permission prompt timing
  tokenStrategy: 'expo',            // 'expo' (default) or 'device' (raw FCM/APNs token)
})

// Wait for ready before using the client
if (isReady && client) {
  await client.devices.updateMetadata({ theme: 'dark' })
  await client.devices.registerCategories()
}
```

**Using `tokenStrategy: 'device'`** (raw FCM/APNs token):

```tsx
usePushNotifications({
  projectId: 'pk_live_xxxxxxxxxxxx',
  externalId: userId ?? null,
  tokenStrategy: 'device', // Gets raw FCM (Android) or APNs (iOS) token
  // Requires FCM service account + APNs .p8 uploaded in Dashboard → Project → Push Credentials
})
```

---

## Expo Quickstart (imperative)

If you prefer to manage the lifecycle yourself rather than using the hook:

```tsx
import { PushClient, resolvePushProvider } from '@espresso-notify/react-native'
import { Platform } from 'react-native'

async function initPush(userId: string | null) {
  // Resolve the provider (auto-detects expo-notifications or firebase)
  const provider = resolvePushProvider({ tokenStrategy: 'expo' })
  if (!provider) throw new Error('No push provider available')

  // Request permission
  const status = await provider.requestPermissions()
  if (status !== 'granted') return

  // Get token
  const tokenData = await provider.getToken()
  if (!tokenData) return

  const client = new PushClient({
    projectId: 'pk_live_xxxxxxxxxxxx',
    pushToken: tokenData.token,
    platform: Platform.OS === 'ios' ? 'ios' : 'android',
    provider: tokenData.provider, // 'expo' | 'fcm' | 'apns'
  })

  // Register device anonymously
  await client.devices.register({ metadata: { locale: 'en-US' } })

  // Identify user if logged in
  if (userId) {
    await client.devices.identify({ externalId: userId })
  }

  // Register notification action categories (optional)
  await client.devices.registerCategories()

  // Call client.destroy() when done (e.g., app unmount or hot reload)
  return client
}
```

---

## Expo Config Plugin

The SDK includes an Expo config plugin that sets up native push notification configuration during `npx expo prebuild` or EAS Build.

Add it to `app.json`:

```json
{
  "expo": {
    "plugins": [
      [
        "@espresso-notify/react-native",
        {
          "apsEnvironment": "production",
          "enableBackgroundRemoteNotifications": true,
          "androidPostNotifications": true
        }
      ]
    ]
  }
}
```

Then run:

```bash
npx expo prebuild
```

**Plugin options:**

| Option | Type | Default | Description |
|---|---|---|---|
| `apsEnvironment` | `'development' \| 'production'` | `'development'` | iOS APNs entitlement (`aps-environment`). Use `'production'` for App Store / TestFlight builds. |
| `enableBackgroundRemoteNotifications` | `boolean` | `true` | Adds `remote-notification` to `UIBackgroundModes` in iOS `Info.plist`. Required for background push delivery. |
| `androidPostNotifications` | `boolean` | `true` | Adds `android.permission.POST_NOTIFICATIONS` to `AndroidManifest.xml`. Required on Android 13+ (API 33+). |

> **Expo Go is not supported.** Push notifications require a development build (`npx expo run:ios` / `npx expo run:android` or EAS Build). The config plugin only applies during `prebuild`/native build.

---

## Bare React Native Quickstart

In bare React Native (no `expo-notifications`), the SDK auto-detects `@react-native-firebase/messaging` and `react-native-notify-kit`.

The [setup wizard](#setup-wizard) does the install and the native Firebase edits for you; the steps below are the same setup by hand.

**1. Set up Firebase in your project** following the [RNFirebase getting started guide](https://rnfirebase.io/). Place `google-services.json` (Android) and `GoogleService-Info.plist` (iOS) in your project.

**2. Check what was detected:**

```ts
import { capabilities } from '@espresso-notify/react-native'

console.log(capabilities())
// {
//   expoNotifications: false,
//   firebaseMessaging: true,
//   notifyKit: true,
//   pushProvider: 'bare',
//   displayAdapter: 'bare',
// }
```

**3. Initialize and register:**

```ts
import { PushClient, BareProvider } from '@espresso-notify/react-native'
import { Platform } from 'react-native'

const provider = new BareProvider()

// Request permissions (handles Android 13+ POST_NOTIFICATIONS + iOS prompt)
const status = await provider.requestPermissions()
if (status !== 'granted') return

// Get FCM token
const tokenData = await provider.getToken()
if (!tokenData) return

const client = new PushClient({
  projectId: 'pk_live_xxxxxxxxxxxx',
  pushToken: tokenData.token,
  platform: Platform.OS === 'ios' ? 'ios' : 'android',
  provider: tokenData.provider, // 'fcm'
})

await client.devices.register()
```

**4. Handle background events (required for bare RN):**

For background tap tracking, register `react-native-notify-kit`'s background handler **before `AppRegistry`** in your `index.js`:

```js
// index.js
import { AppRegistry } from 'react-native'
import notifyKit from 'react-native-notify-kit'
import App from './App'

// Must be called before AppRegistry.registerComponent
notifyKit.onBackgroundEvent(async ({ type, detail }) => {
  // Handle background notification events here
  // The SDK's auto-tracking handles foreground events automatically
})

AppRegistry.registerComponent('MyApp', () => App)
```

> Foreground tap events, delivery (DELIVERED), and dismiss (DISMISSED) are wired automatically by the SDK via `BareDisplayAdapter`.

---

## Push Credentials (FCM / APNs)

**When do you need credentials in the dashboard?**

| Token type | Sender | Dashboard credentials needed? |
|---|---|---|
| `expo` (Expo Push Token) | Expo Push API | No — Expo handles delivery |
| `fcm` (raw FCM token, `tokenStrategy: 'device'` or bare RN) | Firebase Cloud Messaging | Yes — FCM service account JSON |
| `apns` (raw APNs token, iOS + `tokenStrategy: 'device'`) | Apple APNs HTTP/2 | Yes — APNs .p8 key |

**Uploading credentials:**

Go to **Dashboard → Project → Push Credentials** and upload:

- **Android / FCM:** Your Firebase project's service account JSON (`google-services-server.json` — the server-side key from Firebase Console → Project Settings → Service Accounts → Generate new private key). This is different from the `google-services.json` file used in the app.
- **iOS / APNs:** Your `.p8` key file, plus Key ID, Team ID, and Bundle ID from Apple Developer Portal → Keys.

The SDK automatically includes the `provider` field (`'expo'`, `'fcm'`, or `'apns'`) in every `register()` call so the backend can route the token to the correct sender without any additional configuration.

---

## API Reference

### PushClient

```ts
import { PushClient } from '@espresso-notify/react-native'

const client = new PushClient(config: ClientConfig)
```

**`ClientConfig`:**

| Field | Type | Required | Description |
|---|---|---|---|
| `projectId` | `string` | Yes | Your public project key (`pk_live_...`). Throws if you pass a `sk_` key. |
| `pushToken` | `string` | No | Push token to use for all calls. Can be set later via `client.pushToken = ...`. |
| `platform` | `'ios' \| 'android'` | No | Device platform. Can be set later via `client.platform = ...`. |
| `provider` | `'expo' \| 'fcm' \| 'apns'` | No | Token provider discriminator. Sent to backend so it routes to the right sender. Set automatically when using `resolvePushProvider()`. |
| `autoTrack` | `boolean` | No | Auto-track `opened`, `received`, `dismissed`, and `app_opened` events. Default: `true`. |
| `transport` | `Transport` | No | Custom HTTP transport, used in place of both stacks below. Default: the native module when it is linked, else `FetchTransport` (uses `fetch` with Bearer auth). |
| `privateTransport` | `'auto' \| 'native' \| 'js'` | No | Which stack sends the SDK's requests. `'auto'` (default) uses the native module when it is linked and `fetch` when it is not; `'native'` uses only the module and refuses every call with `NATIVE_TRANSPORT_UNAVAILABLE`, sending nothing, when it cannot; `'js'` always uses `fetch`. A `transport` of your own wins over all three. See [Private transport](#private-transport). |
| `displayAdapter` | `DisplayAdapter` | No | Custom display adapter. Default: auto-selected (Expo or bare, based on available libraries). |
| `deviceInfo` | `DeviceInfoAdapter` | No | Custom device info adapter. Default: `ExpoDeviceInfo` (reads from `expo-device/application/localization`). |
| `onNotificationOpened` | `(event) => void \| Promise<void>` | No | Called once for every tap on a notification, also for the tap that opened the app, with `{ notificationId, data, url, actionId }`. Same as `client.onNotificationOpened(handler)`. |
| `handleDeepLinks` | `boolean` | No | Let the SDK open the `url` key of the data of a tap with `Linking.openURL`, after your handler ran, only for what `deepLinkAllowList` allows. Default: `false`. |
| `deepLinkAllowList` | `string[]` | No | The schemes (`'myapp://'`) and HTTPS origins (`'https://shop.example.com'`) that `handleDeepLinks` may open. With none, nothing opens. |
| `offlineQueue` | `{ enabled?: boolean; maxItems?: number }` | No | Keep the events that fail and send them again. Default: `{ enabled: true, maxItems: 200 }`. |

**Instance properties (readable and writable):**

```ts
client.pushToken   // string | undefined
client.platform    // 'ios' | 'android' | undefined
client.provider    // 'expo' | 'fcm' | 'apns' | undefined
client.devices     // Devices — the main interaction surface
client.transportKind // 'native' | 'js' | 'custom' — read only, which stack sends the requests
```

**`client.onNotificationOpened(handler)`** — Calls `handler` once for every tap on a notification, with `{ notificationId, data, url, actionId }`. Returns a function that removes the handler. See [Taps and links](#taps-and-links).

**`client.flush()`** — Sends the delivery reports that wait their delay and the events the offline queue holds, now. **`client.queueStats()`** — `{ pending, dropped }` of the offline queue. See [Offline queue](#offline-queue).

**`client.destroy()`** — Removes all auto-tracking listeners, stops the timer of the offline queue and hands to it the delivery reports that wait. Call this when unmounting your root component if you manage `PushClient` manually (not needed when using `usePushNotifications`).

---

### Devices

Accessed via `client.devices`.

#### `register(data)`

Registers the device with the backend. Call this at app startup.

```ts
await client.devices.register({
  pushToken: 'optional-override',         // falls back to constructor token
  platform: 'ios',                        // falls back to constructor platform
  metadata: { plan: 'free', locale: 'pt-BR' },
  deviceId: 'optional-device-id',
  appVersion: '1.2.3',                    // auto-collected from expo-application if omitted
  osVersion: '17.0',                      // auto-collected from expo-device if omitted
  user: {                                 // optional immediate user linking
    externalId: 'user_123',
    name: 'João',
    identityHash: '…',                    // optional proof of identity (see identify)
  },
})
```

Device metadata (`locale`, `timezone`, `app_version`, `os_version`) is collected automatically from `expo-localization`, `expo-application`, and `expo-device` when those packages are installed. Developer-provided values take precedence.

#### `identify(user, pushToken?)`

Links the device to a user. Call after login.

```ts
await client.devices.identify({
  externalId: 'user_123', // required
  name: 'João',           // optional
  metadata: { plan: 'premium', role: 'admin' },
  identityHash: '…',      // optional: the proof of identity, computed by YOUR backend
})
```

`identityHash` is the HMAC-SHA256 of the `externalId`, keyed by the identity secret of the project, in lower-case hex. Your backend computes it after the login and hands it to the app; the secret never goes into the app. A project in the `required` identity mode refuses (403 `identity_verification_failed`) a `register` with a user, an `identify` and a `forgetDevice` that carry no right proof. `metadata` is capped at 4096 bytes serialized: a larger one throws `EspressoNotifyError` with the code `METADATA_TOO_LARGE`, and the server answers 400 `metadata_too_large`.

#### `unregister(pushToken?)`

Moves the device to anonymous state (clears user association). The token is **not deleted** — the device continues receiving broadcast notifications. Call on logout.

```ts
await client.devices.unregister()
// On next login, just call identify() — no need to re-register
```

#### `updateMetadata(metadata, pushToken?)`

Updates device-level metadata (tags, preferences, etc.).

```ts
await client.devices.updateMetadata({ theme: 'dark', tags: ['sports'] })
```

#### `getPreferences(externalId?, pushToken?)` and `setPreferences(preferences, externalId?, pushToken?)`

Read and write the per-category opt-outs of the user of the device. The device must be identified first; without `externalId` the calls use the one of the last `identify` of the client.

```ts
const prefs = await client.devices.getPreferences() // [{ categoryIdentifier, optedOut }]
await client.devices.setPreferences([{ categoryIdentifier: 'promotions', optedOut: true }])
```

`getPreferences` calls `POST /v1/preferences/query` and sends the external id and the push token in the JSON body, never in the URL (an older SDK called `GET /v1/preferences`, which no longer exists and answers 404: update the SDK). `setPreferences` takes 1 to 50 preferences, each `categoryIdentifier` 1 to 64 bytes, and throws before the call otherwise. Both throw on a failed call.

#### `forgetDevice(options?)`

Erases the device and its data from Espresso Notify, for good (LGPD, GDPR). Sends the push token of the client unless `options.pushToken` is given, plus `options.deviceId` and `options.identityHash` when present. Throws on any answer that is not 2xx, including 404 `not_found`.

```ts
await client.devices.forgetDevice({ identityHash })
client.destroy() // the device no longer exists
```

#### `registerCategories()`

Fetches notification action categories from the backend and registers them on the device. Call once after `register()`. No-op if the environment doesn't support categories.

```ts
await client.devices.registerCategories()
```

#### Tracking methods

All tracking methods are silent — they never throw; a report that fails is kept in the offline queue and sent again (see below). They require `notificationId` to be present in the notification payload (set by the backend automatically):

```json
{ "notificationId": 42 }
```

| Method | Event | When to call |
|---|---|---|
| `trackOpen(notificationId, pushToken?)` | `opened` | User taps notification (auto when `autoTrack: true`) |
| `trackClick(notificationId, pushToken?)` | `clicked` | User taps a notification action button (auto when `autoTrack: true`) |
| `trackReceived(notificationId, pushToken?)` | `received` | Notification displayed in foreground (auto when `autoTrack: true`); waits a random 0 to 30 s and goes with other delivery reports in one request |
| `trackDismissed(notificationId, pushToken?)` | `dismissed` (waits a random 0 to 30 s, batched) | User dismisses the notification (auto with `react-native-notify-kit` when `autoTrack: true`; not reported on Expo unless the app sets `customDismissAction` on the category, else call it yourself) |
| `trackAppOpened(pushToken?)` | `app_opened` | App brought to foreground (auto when `autoTrack: true`; used for influenced-open attribution) |
| `trackConversion(notificationId, pushToken?)` | `converted` | The user did what the notification was for. Counts the conversion; it carries no amount (revenue is reported from your server with the secret key, on `POST /v1/conversions`) |
| `trackEvent(name, pushToken?)` | your own event | A business event of your app (`'order.completed'`), for journeys. 1 to 64 letters, digits, `_` `.` `:` `-`; the six names above are refused with a console warning and nothing is sent |

#### Taps and links

`onNotificationOpened` (a client option, a hook option, and `client.onNotificationOpened(handler)`) receives one object for every tap, also for the tap that opened the app, in Expo and in React Native CLI mode:

| Field | What it is |
|---|---|
| `notificationId` | The id of the notification, from `data.notificationId` |
| `data` | The data of the push: your `payload` and `notificationId` |
| `url` | The `url` key of `data`, when it is a non-empty string |
| `actionId` | The id of the action button that was tapped; `undefined` for a tap on the notification itself |

The SDK still reports `opened` by itself, before it calls your handler; an error your handler throws is swallowed. The tap that opens the app can arrive before the hook has a client: the first handler registered gets it, once. Opening the app from its icon is not a tap: a response with no request identifier and no `notificationId` is ignored, with no handler call and no `opened`.

The SDK opens `url` only when you set `handleDeepLinks: true`, only for the schemes (`'myapp://'`) and HTTPS origins (`'https://shop.example.com'`) in `deepLinkAllowList`, only for a tap on the notification itself, and never `javascript:`, `data:`, `file:`, `vbscript:`, `blob:`, `about:`, `intent:` or `content:`. With the default (`false`) your handler still receives `url`.

#### Images with the app open (Android, Expo)

A push with an `image_url` shows the large expandable picture on Android while the app is closed or in the background, because the system draws it. With the app open, `expo-notifications` draws it and shows only a thumbnail. To get the large picture in that case too, install `react-native-notify-kit` (an optional peer) and wrap the handler of your app:

```ts
import * as Notifications from 'expo-notifications'
import { createNotificationHandler } from '@espresso-notify/react-native'

Notifications.setNotificationHandler({
  handleNotification: createNotificationHandler(async () => ({
    shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false,
  })),
})
```

For a push with an https image, with the app open on Android, notify-kit draws the notification with `AndroidStyle.BIGPICTURE` and the handler tells `expo-notifications` to draw nothing, so it shows once. Every other push, iOS, and an app without notify-kit keep what your handler returns (without notify-kit, a development build logs one warning). Options: `{ bigPicture: false }` turns it off, `{ smallIcon: 'my_icon' }` names the drawable tried first (then `notification_icon`, the icon of the `expo-notifications` plugin, then `ic_launcher`). Taps on that notification reach `onNotificationOpened` and the `opened` tracking exactly like any other tap, with the original `data`. notify-kit keeps one background-event handler: the SDK registers it when the handler is created, so an app that registers its own `notifee.onBackgroundEvent` calls `handleImagePushBackgroundEvent(event)` inside it. iOS needs a Notification Service Extension in your app: see `sdk/examples/notification-service/` in the repository and the page "Images in push" of the documentation.

#### Offline queue

With the queue on (the default), the delivery reports are spread and batched: `opened` and `clicked` go at once, `received` and `dismissed` wait a random 0 to 30 s, and what goes out together is sent in requests of up to 20 events to `POST /v1/notifications/track/batch` (at most one such request every 5 s; a lone event goes to `/v1/notifications/track`). A server that answers 404 to the batch route gets one request per event for the rest of the session. The app leaving the foreground and `client.flush()` send what waits; `client.destroy()` hands it to the queue. `offlineQueue: { enabled: false }` sends every report at once, one request each.

A tracking report that fails with a network error, 408, 429 or 5xx is kept (in `expo-secure-store`, else AsyncStorage, else memory; never the push token, a user id or a key: a token rotation or an identity change waits in memory only) and sent again: 5 seconds doubling to 15 minutes, with jitter, on the return to the foreground, on the next call that succeeds and on `client.flush()`; `Retry-After` is honored; any other 4xx drops the event, except a lifecycle event answered 404 `token_not_found` (it can reach the server before the `register` of its token), which is tried 4 times in all. The stored queue is named after the project and the device id of the install (`espresso.deviceId`) and under no other name: when that id cannot be read (a secure store still locked during a launch in the background), the events of that session wait in memory only, and are merged with the stored ones, written and sent once as soon as the id can be read (the SDK tries again on the next report, flush or return to the foreground); if the app is closed first, the events that waited in memory are lost. Up to `offlineQueue.maxItems` (default 200) events are kept, the oldest dropped and counted in `client.queueStats().dropped`; an event older than 3 days is dropped. A custom event and a lifecycle event carry an `event_id` so that the server ignores a repeat. `app_opened` and the calls that throw (`register`, `identify`, ...) are not queued. `offlineQueue: { enabled: false }` restores one attempt.

#### `recordLifecycle(kind, from, to, externalId?, pushToken?)`

Records a device lifecycle event. Called automatically by the hook for token rotation and permission changes — you rarely need to call this manually.

```ts
await client.devices.recordLifecycle(
  'permission',   // 'permission' | 'subscription' | 'identity'
  'denied',       // previous state
  'granted',      // new state
)
```

---

### usePushNotifications

```ts
import { usePushNotifications } from '@espresso-notify/react-native/hooks'
```

**Config (`UsePushNotificationsConfig`):**

| Field | Type | Default | Description |
|---|---|---|---|
| `projectId` | `string` | required | Public project key (`pk_live_...`). |
| `externalId` | `string \| null` | `null` | Current user's external ID. Hook calls `identify()` on set and `unregister()` on clear. |
| `userName` | `string \| null` | `null` | User display name. Passed to `identify()` automatically. |
| `identityHash` | `string \| null` | `null` | Proof of identity of `externalId` (HMAC computed by your backend), sent with `identify()` as `identity_hash`. A hash that arrives later makes the hook identify again. |
| `metadata` | `Record<string, unknown>` | — | Device metadata sent on `register()`. |
| `pushToken` | `string` | — | Explicit push token. Skip token acquisition if provided. |
| `pushTokenProvider` | `'expo' \| 'fcm' \| 'apns'` | `'expo'` | Provider discriminator when supplying `pushToken` explicitly. |
| `platform` | `'ios' \| 'android'` | auto-detected | Device platform. Auto-detected from `react-native Platform` if omitted. |
| `autoRequestPermission` | `boolean` | `true` | Whether to call `requestPermissions()` automatically. Set `false` to control prompt timing. |
| `tokenStrategy` | `'expo' \| 'device'` | `'expo'` | Token acquisition strategy for `ExpoPushProvider`. `'device'` returns raw FCM/APNs token. Ignored if `pushToken` is provided. |
| `expoProjectId` | `string` | `extra.eas.projectId`, then `easConfig.projectId` | EAS project id for `getExpoPushTokenAsync({ projectId })`. Only used by the `'expo'` strategy. |
| `provider` | `PushProvider` | auto | Override the `PushProvider` entirely (for testing or custom token sources). |
| `enableSigning` | `boolean` | `false` | Sign every request with a per-install key (needs the optional peer `react-native-secure-sign`; without it the client logs one warning and sends unsigned). Same option as `PushClient`. The server only checks signatures for projects that require them. |
| `onNotificationOpened` | `(event) => void \| Promise<void>` | — | Called once for every tap on a notification, also for the tap that opened the app. Pass it from the first render. |
| `handleDeepLinks` | `boolean` | `false` | Let the SDK open the `url` of a tap, only for `deepLinkAllowList`. |
| `deepLinkAllowList` | `string[]` | — | Schemes and HTTPS origins `handleDeepLinks` may open. |
| `offlineQueue` | `{ enabled?: boolean; maxItems?: number }` | `{ enabled: true, maxItems: 200 }` | Keep the events that fail and send them again. |
| `privateTransport` | `'auto' \| 'native' \| 'js'` | `'auto'` | Which stack sends the requests of the client the hook creates, as the option of `PushClient` does. An invalid value becomes the `error` of the hook. See [Private transport](#private-transport). |
| `enableAttestation` | `boolean` | `false` | Run `client.devices.attest()` after `register()` and before `isReady` turns `true`. Requires `enableSigning: true` (the hook warns once if it is missing). A failed attestation never sets `error`. |

**Result (`UsePushNotificationsResult`):**

| Field | Type | Description |
|---|---|---|
| `isReady` | `boolean` | `true` after `register()` succeeds (after its retries, if it needed them). |
| `pushToken` | `string \| null` | The active push token (`null` while initializing or on error). |
| `client` | `PushClient \| null` | The `PushClient` instance for advanced use. `null` until ready. |
| `permissionStatus` | `'granted' \| 'denied' \| 'undetermined' \| null` | Current permission status. |
| `error` | `Error \| null` | Non-null if initialization failed. When no push token could be obtained it is an `EspressoNotifyError` with `code` (below) and the device is **not** registered. |

**Error codes (`EspressoNotifyError.code`):**

| Code | Meaning | Fix |
|---|---|---|
| `EXPO_PROJECT_ID_MISSING` | No EAS project id for the Expo push token. | Run `eas init` (sets `extra.eas.projectId`) or pass `expoProjectId`. |
| `PUSH_TOKEN_UNAVAILABLE` | The provider returned no token; the message carries the cause. | Check the native push setup (FCM / APNs credentials, simulator limits). |
| `UNSUPPORTED_PLATFORM` | `Platform.OS` is `web` and no `platform` was passed; nothing is registered. | Browsers use `@espresso-notify/web`, or pass `platform`. |
| `METADATA_TOO_LARGE` | (from `identify`) the user metadata is over 4096 bytes serialized. | Send less; nothing was sent. |
| `PINNING_NOT_ACTIVE` | (from any call) `requirePinning` is on and pinning is not active. | Call `enableEspressoPinning` first. |
| `NATIVE_TRANSPORT_UNAVAILABLE` | (from any call) `privateTransport` is `'native'` and the native module is not linked or speaks a contract version this SDK does not support. Nothing was sent. | Build the app again so the module is linked, or use `'auto'`. |

A call the server refuses throws an `EspressoNotifyHttpError` (a subclass of `Error`) with `status` (the HTTP status), `code` (the `code` of the JSON body, such as `identity_verification_failed` or `user_not_found`) and `path` (the path of the call, up to any `?` or `#`, so it holds no query string).

The SDK writes nothing to the console but warnings, in fixed texts that start with `[espresso-notify]`. No warning carries a push token, an external id, an identity hash, a key or a payload, the two warnings about a rejected event name or notification id do not repeat the value, and there is no debug or verbose option. The warning of a failed signing, pinning start or attestation adds the message of the error that the other package raised; the SDK does not control that text.

If the first permission answer is not `granted` (or the user later enables notifications in Settings), the hook re-reads the permission when the app returns to the foreground and registers as soon as it is `granted`.

---

### usePushIdentity

Lightweight hook for apps that manage `PushClient` manually and only want reactive identity tracking.

```ts
import { usePushIdentity } from '@espresso-notify/react-native/hooks'
import { useMemo } from 'react'

function App() {
  const client = useMemo(() => new PushClient({ projectId: 'pk_live_...' }), [])

  usePushIdentity(client, userId ?? null)
  // Calls identify() when userId is set, unregister() when cleared
}
```

```ts
usePushIdentity(client: PushClient | null, userId: string | null, identityHash?: string | null): void
```

---

### capabilities()

Introspects which native integrations were detected at runtime. Useful for debugging "why is my push token null?" across environments.

```ts
import { capabilities } from '@espresso-notify/react-native'

const caps = capabilities()
console.log(caps)
// {
//   expoNotifications: true,   // expo-notifications resolved
//   firebaseMessaging: false,  // @react-native-firebase/messaging not found
//   notifyKit: false,          // react-native-notify-kit not found
//   pushProvider: 'expo',      // which provider auto-detection selected
//   displayAdapter: 'expo',    // which display adapter auto-detection selected
//   sslPinning: false,         // neither the native module nor react-native-ssl-public-key-pinning found
//   pinningActive: false,      // certificate pinning is not on
//   nativeTransport: false,    // the native module of the SDK is not linked (Expo Go, tests, the web)
// }
```

**`Capabilities` fields:**

| Field | Type | Description |
|---|---|---|
| `expoNotifications` | `boolean` | `expo-notifications` resolved at runtime. |
| `firebaseMessaging` | `boolean` | `@react-native-firebase/messaging` resolved at runtime. |
| `notifyKit` | `boolean` | `react-native-notify-kit` resolved at runtime. |
| `pushProvider` | `'expo' \| 'bare' \| 'none'` | Which `PushProvider` auto-selection would pick. |
| `displayAdapter` | `'expo' \| 'bare' \| 'none'` | Which `DisplayAdapter` auto-selection would pick (`bare` with `react-native-notify-kit` or `@react-native-firebase/messaging`). |
| `sslPinning` | `boolean` | Certificate pinning is possible: `react-native-ssl-public-key-pinning` resolved at runtime, or the native module of the SDK is linked and supported. |
| `pinningActive` | `boolean` | Certificate pinning is on for the path the SDK takes by default, the pins of the native module when it is linked and supported, else those of the library (`enableCertificatePinning` / `enableEspressoPinning` succeeded and `disableCertificatePinning` has not run since). |
| `nativeTransport` | `boolean` | The native module of the SDK is linked and speaks a contract version this SDK supports, so `privateTransport: 'auto'` sends through it. `false` in Expo Go, on the web, in tests and in an app built before the module existed. |

---

### Certificate Pinning

> **Certificate pinning is OFF by default, on purpose.** A pin that is wrong, or a certificate that is rotated while no pin for the new one is in the app, makes every call fail until you ship a new version, which is worse than the risk pinning covers. Turn it on when your threat model needs it, and always with a backup pin. The functions below return `false` instead of throwing when the library or the pins are not right, so an app can run unpinned without a sign: read `capabilities().pinningActive`, or set `requirePinning: true` on the client (every call then fails with `PINNING_NOT_ACTIVE`, sending nothing, until pinning is active).

Pinning has two paths. With the native module of the SDK linked, the pins go to the module, which pins the requests it sends, and `react-native-ssl-public-key-pinning` is not needed for them. Without the module, and for the other `fetch` calls of your app, pinning needs that library: it patches the global networking layer once, so every later `fetch` call, including the SDK's own `FetchTransport`, is pinned. When both are there, the pins go to both.

The pins of the native module cover only the requests of the module, which are the SDK's own; for the traffic of your app itself, keep the library. On the native path the chain is validated as usual first, and the connection completes only if the SHA-256 of the Subject Public Key Info of at least one certificate of the validated chain equals one of the pins. A chain that matches none fails the call with `network request failed (pin_mismatch)` before any header or body is sent. The pins live in memory for the life of the process, so an app that starts again calls the function again. With `requirePinning: true` the guard checks the pins of the path of the client's own transport: those of the module for the native transport, those of the library for `fetch`.

```ts
import { enableEspressoPinning, disableCertificatePinning } from '@espresso-notify/react-native'

// Call once at app startup, before any network requests
await enableEspressoPinning([
  'base64sha256PinHere==',    // leaf or intermediate SPKI SHA-256 hash
  'backupPinHere==',          // backup pin for rotation — always include at least one backup
])
```

**`enableEspressoPinning(publicKeyHashes, includeSubdomains?)`**

Convenience wrapper that pins the Espresso Notify API hostname (injected at build time). Returns `true` if pinning was enabled, `false` otherwise (with a `console.warn`).

| Param | Type | Default | Description |
|---|---|---|---|
| `publicKeyHashes` | `string[]` | required | Base64 SHA-256 hashes of certificate Subject Public Key Info (SPKI). |
| `includeSubdomains` | `boolean` | `true` | Whether to pin subdomains. |

**`enableCertificatePinning(options)`**

Lower-level API for pinning arbitrary hostnames:

```ts
import { enableCertificatePinning } from '@espresso-notify/react-native'

await enableCertificatePinning({
  'api.espressonotify.com': {
    includeSubdomains: true,
    publicKeyHashes: ['pin1base64==', 'pin2base64=='],
  },
})
```

**`disableCertificatePinning()`**

Disables pinning. No-op when the library is absent.

```ts
await disableCertificatePinning()
```

> **About SPKI pins:** Extract them from a certificate with `openssl x509 -pubkey | openssl pkey -pubin -outform der | openssl dgst -sha256 -binary | base64`. Always include at least two pins (a backup) so certificate rotation doesn't break your app.

---

### Adapter Interfaces

These interfaces are the extension points for testing and custom environments. You can inject any of them into `PushClient` via `ClientConfig` or into `usePushNotifications` via the `provider` option.

#### `Transport`

Custom HTTP adapter (e.g., for mocking in tests or using a different HTTP client).

```ts
interface Transport {
  request(path: string, options?: RequestInit): Promise<unknown>
}
```

#### `PushProvider`

Custom push token and permission adapter.

```ts
interface PushProvider {
  requestPermissions(): Promise<PermissionStatus>         // required
  getToken(): Promise<PushProviderToken | null>           // required
  onTokenRefresh?(cb: (token: PushProviderToken) => void): () => void  // optional
  getPermissionStatus?(): Promise<PermissionStatus>       // optional
}

// PushProviderToken
interface PushProviderToken {
  token: string
  provider: 'expo' | 'fcm' | 'apns'
}
```

Concrete implementations exported by the SDK: `ExpoPushProvider`, `BareProvider`. Factory function: `resolvePushProvider(options?)`.

#### `DisplayAdapter`

Custom notification display and event adapter.

```ts
interface DisplayAdapter {
  onResponse(cb: (info: { notificationId?: string | number; actionId?: string }) => void): () => void
  onReceived(cb: (info: { notificationId?: string | number }) => void): () => void
  onDismissed(cb: (info: { notificationId?: string | number }) => void): () => void
  supportsCategories(): boolean
  setCategories(categories: CategoryDef[]): Promise<void>
}
```

Concrete implementations: `ExpoDisplayAdapter` (internal), `BareDisplayAdapter` (exported).

#### `DeviceInfoAdapter`

Custom device metadata collector.

```ts
interface DeviceInfoAdapter {
  collect(): {
    meta: Record<string, string>
    appVersion?: string
    osVersion?: string
  }
}
```

---

## Private transport

By default the SDK sends its requests through a small native module of its own (Android: its own OkHttp client; iOS: its own ephemeral `URLSession`), not through `fetch`. That keeps the SDK's calls out of the JavaScript network tools of a development build: Reactotron, the Network panel of React Native DevTools, Rozenite and the Expo Network panel do not list them. Signing, the offline queue, the retries and the batching stay in JavaScript; the module sends one request and holds the certificate pins.

```ts
import { PushClient, capabilities } from '@espresso-notify/react-native'

const client = new PushClient({ projectId: 'pk_live_...', privateTransport: 'auto' }) // 'auto' is the default

client.transportKind                // 'native' | 'js' | 'custom'
capabilities().nativeTransport      // true when the module is linked and supported
```

| `privateTransport` | What the client does |
|---|---|
| `'auto'` | The default. Sends through the native module when it is linked and speaks a contract version this SDK supports; otherwise sends through `fetch` and, in development, logs one warning per app run. |
| `'native'` | Sends through the native module only. Without it every call throws an `EspressoNotifyError` with the code `NATIVE_TRANSPORT_UNAVAILABLE` and nothing is sent. |
| `'js'` | Sends through `fetch`, even when the module is linked. |

`client.transportKind` tells which stack a client got: `'native'`, `'custom'` when you passed a `transport`, and `'js'` otherwise.

**It needs a native build.** The module is native code, so it is in the app only after a build: `pod install` and a native build in a React Native CLI app, `npx expo prebuild` and a native build or an EAS Build in an Expo app. A Metro reload or an EAS Update does not add it. Autolinking needs no manual step. Where the module is not linked (Expo Go, the web, Jest tests, or an app built before the module existed), `'auto'` sends through `fetch`, and those requests do show in the network tools. To keep them out of Reactotron, add the host of the API to `ignoreUrls` of its `networking` plugin. The host below is an example; use the one your app calls.

```js
import Reactotron from 'reactotron-react-native'

Reactotron.configure()
  .useReactNative({ networking: { ignoreUrls: /api\.example\.com/ } })
  .connect()
```

**It is not a security boundary.** It keeps your development tools free of the SDK's calls, and nothing more. It does not hide the traffic from a proxy such as Charles, Proxyman or mitmproxy, or from a native profiler, which see the requests of the device. A release build has none of those JavaScript tools to hide from. The call of `expo-notifications` to `exp.host` that gets an Expo push token stays visible, because that package makes it outside the SDK; `tokenStrategy: 'device'` asks for the raw FCM or APNs token instead and does not make it.

The two paths differ in two small ways. The native path gives up a request after 30 seconds, counted to the last byte of the answer, and `fetch` has no limit of its own; and the pins of the native module cover the SDK's own requests only (see [Certificate Pinning](#certificate-pinning)). The native path never follows a redirect, cancels an answer over 4 MiB, and sends and stores no cookie and no HTTP cache. A request that ends without an answer throws a plain `Error` with the message `[espresso-notify] network request failed (<code>)`, where the code is one of `timeout`, `no_connection`, `dns`, `tls`, `pin_mismatch`, `cancelled`, `response_too_large`, `invalid_request` or `unknown`; the offline queue and the retry of the hook treat it as a network error.

The module builds and runs on the iOS simulator, with the old and the new architecture. The Android builds were not run on an Android device or emulator, and which network tools list the requests has not been checked on a physical device, so this document states only what the builds and the simulator showed. The `Transport` interface above is unchanged: a `transport` of your own replaces both stacks.

---

## Event Tracking

When `autoTrack: true` (default), the SDK wires all event listeners automatically:

| Event | Trigger | Method called |
|---|---|---|
| `opened` | User taps notification (foreground or from notification tray) | `trackOpen(notificationId)` |
| `clicked` | User taps a notification action button | `trackOpen(notificationId)` (action tap is treated as open) |
| `received` | Notification delivered while app is in foreground | `trackReceived(notificationId)` |
| `dismissed` | User dismisses the notification (React Native CLI with `react-native-notify-kit`; see the platform notes) | `trackDismissed(notificationId)` |
| `app_opened` | App brought to foreground (any reason) | `trackAppOpened()` — backend correlates with recent sends for influenced-open attribution |

**Platform notes:**
- `dismissed` is not reported on Expo unless your app opts in. On iOS the system hands a dismissal to the app only for a category with `customDismissAction: true`, which the SDK never registers. If your app, or another library, sets it on the category of your pushes, the SDK records the response (the action `com.apple.UNNotificationDismissActionIdentifier`, or the `DISMISS_ACTION_IDENTIFIER` of `expo-notifications` when a version of it exposes that constant) as `dismissed`, once for each notification, never as `opened`, and `onNotificationOpened` is not called for it. Without that option nothing reaches the app, and Android never hands a dismissal to the app. In a React Native CLI app, `react-native-notify-kit` reports it on both platforms. To report it from your own code, call `trackDismissed(notificationId)`.
- `app_opened` requires no `notificationId` — the backend uses `push_token` + recent send timestamps for influenced-open attribution.

**Payload requirement:**

All per-notification events require the backend to include `notificationId` in the notification's data payload. This is set automatically by Espresso Notify when sending:

```json
{
  "data": {
    "notificationId": 42
  }
}
```

**Disabling auto-tracking:**

```ts
const client = new PushClient({ projectId: 'pk_live_...', autoTrack: false })

// Wire tracking manually
Notifications.addNotificationResponseReceivedListener(response => {
  const id = response.notification.request.content.data?.notificationId
  if (id) client.devices.trackOpen(id)
})
```

**Lifecycle events** (permission changes and token rotation) are tracked automatically by `usePushNotifications` via `recordLifecycle()` — no manual wiring needed.

---

## Security Notes

- **Use `pk_` keys in your app.** Project public keys (`pk_live_...`) are safe to embed in client-side code. The SDK throws immediately if you pass a secret key (`sk_...`).
- **Never use `sk_` keys in your app.** Secret keys must only be used on your server (e.g., when calling the REST API to send notifications).
- **Request signing and device attestation are opt-in, twice.** The app turns them on (`enableSigning`, `enableAttestation`) and the project requires them (`require_signing`, `require_attestation`); a project that does not require them accepts signed and unsigned calls alike. No project can require them from the dashboard yet.
- **Certificate pinning** is an optional hardening layer, off by default (see above). It protects against man-in-the-middle attacks on rooted/jailbroken devices. See [Certificate Pinning](#certificate-pinning) above.
- The SDK uses standard TLS for all API calls, through its native module when it is linked and through `fetch` when it is not (see [Private transport](#private-transport)). The private transport keeps the SDK out of the JavaScript development tools; it is not a security boundary, and a proxy or a native profiler still sees the traffic.
- **No identifier in a URL, none in a log.** The SDK sends no external id and no push token in a URL (`getPreferences` uses a request body), the `path` and the message of an HTTP error never hold a query string, and the only thing it writes to the console is a fixed warning that starts with `[espresso-notify]` and carries no token, identifier, key or payload.
- **The code is open source (MIT) and readable.** `dist/` is the plain output of `tsc` with the production API URL filled in, with type declarations next to it. Nothing in the SDK is protected by being hard to read, and nothing in it is secret: the project key is public by design, and what protects your integration is on the server and in the options you turn on (request signing with `enableSigning`, device attestation with `enableAttestation`, certificate pinning, and the project's allowed origins/bundle ids). See `SECURITY.md` to verify a package.
