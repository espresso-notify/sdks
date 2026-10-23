# Changelog

All notable changes to `@espresso-notify/web` are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the package follows [Semantic Versioning](https://semver.org/).

## Unreleased

The `package.json` is at `0.0.2`, so what is below is what the next release, `0.0.2`, will contain. When it is published this section becomes `0.0.2` with the date, and a new Unreleased section opens above it.

### Changed

- The "Homepage" button of the npm page opens the documentation of the Web SDK, and the README starts with the links of the website, the documentation, the dashboard, the changelog and the repository.
- The README no longer says that the package is not on npm yet.
- `SECURITY.md` says that the workflow of the public repository only stages a version, and that a maintainer approves it on npmjs.com with two-factor authentication.

## 0.0.1 - 2026-10-23

The first release, published to npm with provenance from the public repository `espresso-notify/sdks`.

### Added

Privacy, preferences and events (the browser can do what the React Native SDK does, with the public key only):

- `forgetDevice(options?)` erases this browser, its delivery records and events and, when no other device is left, its user, then drops the local record and the browser subscription. It sends the `identityHash` when the project verifies identities, keeps the subscription and the local record when the call fails so the site can try again, and rejects with `no_subscription` when the browser has none.
- `getPreferences()` and `setPreferences(preferences)` read and save the category opt-outs of the person this browser is linked to by `identify`. A list of 1 to 50 items, each a `categoryIdentifier` of 1 to 64 bytes and a boolean `optedOut`, is checked before any call.
- `trySubscribe({ consent })` and `subscribe({ consent })` record the acceptance of the visitor on the subscription: the time of the server, a `version` (up to 64 characters) and a `source` (up to 32). A size over the limit fails with `invalid_consent` before the permission prompt and before any call. Without `consent` nothing is recorded and a record stored earlier is kept.
- `trackEvent(name)` reports a business event of the person this browser is linked to, and `trackConversion(notificationId)` reports the `converted` event of a notification delivered to this browser. Neither throws, queues or retries. Journeys react to an event only when the person also has a mobile device.
- `EspressoNotifyHttpError` (with `status` and `code`) is the error of a call the API answered outside 2xx, `EspressoNotifyError` (with `code`, today `no_subscription`) is the error of a call that cannot be made from this browser, and `validatePreferences(list)` and `isValidEventName(name)` are the checks the methods run before the network, exported so a form can run them too.

Reliability (the same behaviour as the React Native SDK):

- The subscription post, the read of the VAPID key and `identify` are tried again when the failure can pass (no answer, 408, 429 or 5xx): up to 6 tries in all, with a random wait from 0 up to 1 second that doubles with each failure up to 5 minutes, or the `Retry-After` of the answer plus a random 0 to 25% when it asks for 60 seconds or less. A longer `Retry-After` is not waited for: the call fails at once with the same error and nothing is remembered. Any other 4xx is final.
- The subscription post and `identify` go out only when something changed (the subscription, the VAPID key, the time zone, the version of the SDK, `appVersion`, and for `identify` the user, the name and the proof) or in a new session: a new tab or window, or a page opened or shown again 30 minutes or more after it was last seen. Only hashes are stored, in `localStorage` and `sessionStorage`, and a failure is not remembered.
- The `appVersion` option of `WebPushClient`: a new value makes the next page load post the subscription and `identify` again.

The rest of the surface of the first release:

- `WebPushClient` with `trySubscribe()`, `subscribe()`, `unsubscribe()`, `identify()`, `updateMetadata()`, `getSubscription()`, `isSupported()`, `getSupport()`, `getPermissionState()`, `requestPermission()` and `onPush()`, the functions of the same names for support and permission, and `SubscribeError`.
- The service worker, with the installer `npx @espresso-notify/web <folder>`: it shows a notification for every push, opens the `web_url` of a click and reports `opened` and `clicked`, shows action buttons, `tag` and `badge`, and subscribes again with the same key on `pushsubscriptionchange`.
- The browser time zone goes with the subscription, a subscription moves to a rotated VAPID key in the next session.

### Security

- A secret key (`sk_`) is refused by the constructor, and none of the new methods reaches the network with it.
- The built package talks only to `https://api.espressonotify.com`, and `npm pack` refuses a `dist` that still holds the placeholder of the API URL.
- The tarball holds `dist`, `README.md`, `LICENSE`, `SECURITY.md` and this `CHANGELOG.md`, and nothing else.
