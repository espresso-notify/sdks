# Espresso Notify Web SDK

Web Push for [Espresso Notify](https://espressonotify.com): subscribe a browser, link it to a user of your app and receive notifications through a service worker.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

The package is `@espresso-notify/web`. It runs on your site, in the browser of your customer, and talks to the Espresso Notify API with the **public key** (`pk_`) of your project. A secret key (`sk_`) never belongs in a web page.

## Table of contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Service worker](#service-worker)
- [Permission UX](#permission-ux)
- [Identify the user](#identify-the-user)
- [Privacy: consent, preferences and erasure](#privacy-consent-preferences-and-erasure)
- [When the client calls the API](#when-the-client-calls-the-api)
- [API reference](#api-reference)
- [Browser support](#browser-support)
- [Safari and iOS](#safari-and-ios)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)
- [License](#license)

## Requirements

- A project in the Espresso Notify dashboard with its Web Push keys (VAPID) generated: open the project, then the **Web Push** tab.
- The public key of the project (`pk_live_...` or `pk_test_...`), from the API keys of the project.
- The site is served over **HTTPS**. `http://localhost` also works, for development.
- A bundler or a plain `<script type="module">` page that can import an npm package. Node 18 or newer to run the installer command.

## Install

> **Coming soon.** `@espresso-notify/web` is not published to npm yet: it will be published at launch, and until then `npm install` and `npx` answer 404. The commands below are what you will run once it is out.

```bash
npm install @espresso-notify/web
```

Then copy the service worker into the folder your site serves (usually `public/`):

```bash
npx @espresso-notify/web public
```

The command creates `public/push/espressonotify/espresso-notify-sw.js`. Without an argument it picks the first folder it finds among `public`, `static`, `www` and the current one.

## Quick start

```ts
import { WebPushClient } from "@espresso-notify/web";

const push = new WebPushClient({ projectId: "pk_live_xxxxxxxxxxxxxxxx" });

// Call this from a click on an "Enable notifications" button.
async function enableNotifications() {
  const result = await push.trySubscribe();
  if (!result.ok) {
    console.warn("Not subscribed:", result.reason, result.message);
    return;
  }
  await push.identify("user_123"); // your own id for the user
}
```

Send the first notification with the secret key from your server (see the API documentation for `/v1/notifications/broadcast` and `/v1/notifications/personalized`).

A working app with this flow is in [`examples/web-push-test`](../examples/web-push-test).

## Service worker

The worker is a single file. The default location is fixed on purpose:

| Setting | Default | Option |
| --- | --- | --- |
| File | `/push/espressonotify/espresso-notify-sw.js` | `swPath` |
| Scope | `/push/espressonotify/` | `swScope` |

The narrow scope keeps Espresso Notify from colliding with a service worker your site already has at `/`. Push delivery does not depend on the scope, and a click opens any URL of your site.

A worker may only claim a scope at or below the folder it is served from, so the file has to be served inside the scope folder. If you serve it somewhere else, pass both options to the client and make sure the response carries `Content-Type: application/javascript` and is not cached for long:

```ts
const push = new WebPushClient({
  projectId: "pk_live_xxxxxxxxxxxxxxxx",
  swPath: "/sw/espresso.js",
  swScope: "/sw/",
});
```

The worker always shows a notification for every push, whether or not a tab of your site is open. Browsers require this (`userVisibleOnly`), and Safari revokes the subscription of a site that hides notifications. To draw your own UI next to it, listen for the copy the worker forwards to the open page:

```ts
const stop = push.onPush((payload) => {
  console.log(payload.title, payload.body);
});
// stop() removes the listener
```

On a click the worker opens the `web_url` of the notification (only a page of your site or an `https` page), focuses a tab that already shows it, and reports `opened` and `clicked` to the API compiled into the package.

## Permission UX

A browser shows the permission prompt only for a click or a tap, and a visitor who refuses is hard to bring back. Ask in two steps:

1. Show your own "Enable notifications" control, only when `push.isSupported()` is true, and explain what the visitor will get.
2. Call `push.trySubscribe()` from that control's click handler. It asks for the permission when it is still `default`, and says why it could not subscribe instead of throwing.

```ts
const support = push.getSupport();
if (!support.supported) {
  // support.reason: "no_service_worker" | "no_push_manager" | "no_notification" | "ios_requires_installed_app"
}

switch (push.getPermissionState()) {
  case "default":      // not asked yet: show your button
  case "granted":      // subscribed or ready to: call trySubscribe() to refresh the registration
  case "denied":       // blocked: the browser will not ask again; show how to unblock in the site settings
  case "unsupported":  // no Web Push here
}
```

`trySubscribe()` resolves `{ ok: true }` or `{ ok: false, reason, message? }` with one of `unsupported`, `permission_denied`, `permission_dismissed`, `no_service_worker`, `vapid_key_missing`, `invalid_consent` or `server_error`. Never call it on page load.

To record what the visitor accepted, see [Consent](#consent) below.

A visitor who denied the permission can only re-enable it in the browser settings of the site. Your page cannot reset it.

## Identify the user

`identify` links the browser to a user of your app, so you can send to that user and apply their preferences:

```ts
await push.identify("user_123", { name: "Ana" });
```

`externalId` is your own id for the user, the same value you pass to the React Native SDK. Call it after the subscription exists (after `trySubscribe()` or `subscribe()`); it does nothing before. A repeated `subscribe()` never unlinks the user or erases the metadata. `identify` is sent only when the user, the name, the proof, the subscription, the time zone or your `appVersion` changed, or in a new session (see below), so calling it on every page load is cheap.

When the project verifies identities, compute `HMAC-SHA256(externalId, project secret)` as lower-case hex **on your server** and pass it:

```ts
await push.identify("user_123", { identityHash: hashFromYourServer });
```

The secret that signs the hash never goes to the browser.

## Privacy: consent, preferences and erasure

These calls use the public key only, like the rest of the client, and need no signature: the proof that a call comes from this browser is its push endpoint, which the client reads from the subscription and sends in the body, never in a URL. The cookie banner, the settings page and the "delete my data" button of your site call them directly.

### Consent

Pass `consent` when the visitor accepted a text you can name, and the API stores the time of the server, the `version` (up to 64 characters) and the `source` (up to 32) on the subscription:

```ts
await push.trySubscribe({ consent: { version: "terms-2026-10", source: "banner" } });
```

Without `consent` nothing is recorded and a record stored earlier is kept; the SDK never assumes a consent. A `version` or `source` over the limit fails before any call, and before the permission prompt, with `invalid_consent`. The record is deleted with the subscription by `unsubscribe()` and `forgetDevice()`. The type of the option is `ConsentInfo`.

### Preferences

A person can leave a category of notifications without leaving all of them. The preferences belong to the person the browser is linked to by `identify`, so call `identify` first; before it, both calls reject `user_not_found` (404).

```ts
await push.setPreferences([{ categoryIdentifier: "promotions", optedOut: true }]);
const current = await push.getPreferences(); // [{ categoryIdentifier: "promotions", optedOut: true }]
```

`setPreferences` takes 1 to 50 items of type `NotificationPreference`, each with a `categoryIdentifier` of 1 to 64 bytes and a boolean `optedOut`, and checks the list before any call (`validatePreferences` is the same check, exported). A category the project does not have, or one a person cannot leave, is refused by the API and the call rejects with `EspressoNotifyHttpError`. The opt-outs are the same ones the React Native SDK and the dashboard read, so a choice made in one place holds in the others.

### Erase the browser

`forgetDevice()` is the call behind a "delete my data" button (LGPD, GDPR):

```ts
await push.forgetDevice();
// when the project verifies identities, pass the proof computed on your server
await push.forgetDevice({ identityHash: hashFromYourServer });
```

It erases this browser's subscription, its delivery records, the events stored under it and, when no other device is left, the person (external id and name). The category opt-outs of an erased person stay as a record with no personal data, so a later send still respects them. **It cannot be undone.** Only after the API confirms does it drop the local record and cancel the browser subscription, so a call that fails (no network, a 5xx) keeps everything and the site can try again. It rejects `no_subscription` (`EspressoNotifyError`) without calling the API when the browser has none, and `EspressoNotifyHttpError` for an answer outside 2xx: `not_found` (404) when the project has no such subscription, and 403 `identity_verification_failed` when the project requires the proof of identity and `identityHash` is missing or wrong.

`unsubscribe()` is the lighter call: it removes the subscription and its delivery records and keeps the person and the events. Use `forgetDevice()` when the visitor asks for the data to be deleted.

### Events and conversions

```ts
await push.trackEvent("order.completed"); // a business event of the person
await push.trackConversion(notificationId); // the visitor did what a notification asked
```

`trackEvent(name)` records the event for the person the browser is linked to, so goals and journeys of the project can react to it. **Journeys start from it only when the person also has a mobile device**: a person who has only a browser gets the event recorded and no journey; journeys for a person with only a browser are coming soon. `trackConversion(notificationId)` adds one to the conversion count of a notification delivered to this browser, once per browser; it carries no amount (revenue is reported from your server with the secret key). Both are silent: they never throw, keep no queue and never retry, so an event the network or the API refuses (404 `unknown_device`, 429 `rate_limited`) is lost and leaves one line in the debug console. An invalid name or id sends nothing and logs a warning. `trackEvent` allows 60 events a minute for each subscription.

## When the client calls the API

The client does not repeat what the server already knows, and it tries a call again when the failure can pass.

- **Only on change or in a new session.** After a subscription post or an `identify` works, the client remembers a hash of what it sent (the endpoint and keys of the subscription, the VAPID key it was made with, the time zone, the public key of the project, the version of the SDK, your `appVersion` and, for `identify`, the user id, the name and the proof of identity) and the session. It sends the call again only when the hash differs or the remembered call belongs to an earlier session. A skipped `subscribe()` or `trySubscribe()` resolves as if it had worked and reads no VAPID key either, so a rotation of the key is noticed in the next session.
- **A session is one tab.** A reload or another page of your site in the same tab keeps it. A new tab or window starts another, and so does a page opened or shown again 30 minutes or more after it was last seen. Where the browser has no `sessionStorage`, every page load is a session.
- **Some calls always go out.** A call that carries a `consent` record, and one that finds the endpoint a failed run of the worker left to replace.
- **Only hashes are stored.** `localStorage` holds the hashes and the ids of the latest 8 sessions of each call (key `espresso-notify:registration:` and the public key of the project); `sessionStorage` holds the id of the session and the time the page was last seen (key `espresso-notify:session`). The endpoint, the keys, the user id, the name and the proof are never stored there. Where a storage cannot be used, the calls go out every time.
- **A failure is not remembered**, so the next page load sends the call again; `unsubscribe()` forgets what was sent.
- **Retries.** The subscription post, the read of the VAPID key of a browser with no subscription yet, and `identify` are tried again when the failure can pass (a request with no answer, 408, 429 or 5xx), up to 6 times in all, waiting a random time from 0 up to 1 second that doubles with each failure up to 5 minutes, or the `Retry-After` of the answer plus a random 0 to 25% when it asks for 60 seconds or less; a longer `Retry-After` is not waited for and the call fails at once, with nothing remembered. Any other 4xx is final. The promise settles after the last try. `updateMetadata` is sent once.

## API reference

### `new WebPushClient(options)`

| Option | Type | Description |
| --- | --- | --- |
| `projectId` | `string` | Required. The public key of the project (`pk_...`). |
| `swPath` | `string` | Where the worker is served. Default `/push/espressonotify/espresso-notify-sw.js`. |
| `swScope` | `string` | The scope to register. Default `/push/espressonotify/`. |
| `appVersion` | `string` | Optional. The version of your site or app; a new value makes the next page load post the subscription and `identify` again. |

### Methods

| Method | Returns | What it does |
| --- | --- | --- |
| `isSupported()` | `boolean` | Whether this browser can do Web Push. |
| `getSupport()` | `{ supported, reason? }` | Same, with the reason when it cannot. |
| `getPermissionState()` | `"default" \| "granted" \| "denied" \| "unsupported"` | The permission of the site. Never prompts. |
| `requestPermission()` | `Promise<PermissionState>` | Prompts and returns the state afterwards. Call it from a user gesture. |
| `trySubscribe(options?)` | `Promise<SubscribeResult>` | Subscribes the browser and reports why it could not. `options.consent` (`{ version?, source? }`) records the accept of the visitor; see Consent below. |
| `subscribe(options?)` | `Promise<boolean>` | Subscribes; `false` when the browser has no service worker, throws on any other failure. Takes the same `options.consent`. |
| `unsubscribe()` | `Promise<void>` | Removes the subscription from the browser and from the project. |
| `forgetDevice(options?)` | `Promise<void>` | Erases this browser, its delivery records, its events and its user (when no other device is left) from the project, then drops the local record and the browser subscription. `options`: `identityHash`. Rejects `no_subscription` when the browser has none. Cannot be undone. |
| `getPreferences()` | `Promise<{ categoryIdentifier, optedOut }[]>` | The category opt-outs of the person this browser is linked to by `identify`. Rejects `user_not_found` (404) before `identify`. |
| `setPreferences(preferences)` | `Promise<{ updated }>` | Saves 1 to 50 opt-outs (`categoryIdentifier` of 1 to 64 bytes, boolean `optedOut`). The check runs before any call. Needs `identify` first. |
| `trackEvent(name)` | `Promise<void>` | Reports a business event (`order.completed`) of the person this browser is linked to. The name is 1 to 64 letters, digits, `_`, `.`, `:` or `-`; `opened`, `clicked`, `received`, `dismissed`, `converted` and `app_opened` are refused. Silent: never throws, no queue, no retry. Journeys react only when the person also has a mobile device (browser-only: coming soon). |
| `trackConversion(notificationId)` | `Promise<void>` | Reports the `converted` event of a notification delivered to this browser, counted once per browser. Silent: never throws. |
| `getSubscription()` | `Promise<PushSubscription \| null>` | The subscription of this browser. Does not prompt. |
| `identify(externalId, options?)` | `Promise<void>` | Links the browser to a user. `options`: `name`, `identityHash`. |
| `updateMetadata(metadata)` | `Promise<void>` | Stores a metadata object on the subscription. |
| `onPush(handler)` | `() => void` | Receives the payload of each push while a page is open. Returns the function that stops listening. |

The same `isSupported`, `getSupport`, `getPermissionState` and `requestPermission` are also exported as functions, and `SubscribeError` is exported for code that uses `subscribe()`.

The types `PermissionState`, `SupportInfo`, `UnsupportedReason`, `SubscribeResult`, `SubscribeFailureReason`, `ConsentInfo` and `NotificationPreference` are exported too.

`EspressoNotifyError` (with `code`, today `no_subscription`) is the error of a call that cannot be made from this browser. `EspressoNotifyHttpError` is the error of a call the API answered with a status outside 2xx; it carries `status` and `code` (for example `404` and `user_not_found`). `validatePreferences(list)` and `isValidEventName(name)` are the checks the preference and event methods run before they call the network, exported so a form can run them too.

### Notification fields

You choose them in the send call of the API: `title`, `body`, `icon_url`, `image_url`, `web_url`, `ttl` and `priority`. The whole push is limited to 3993 bytes.

## Browser support

| Browser | Support |
| --- | --- |
| Chrome and Edge, desktop | Yes |
| Chrome, Android | Yes |
| Firefox, desktop and Android | Yes. Ask for the permission from a click. |
| Safari 16 or newer, on macOS 13 or newer | Yes, after a user gesture. |
| Safari, iOS and iPadOS 16.4 or newer | Only for a site added to the Home Screen. See below. |
| Samsung Internet | Chromium based; not verified. |
| In-app web views, browsers without a service worker or `PushManager` | No. `getSupport()` says why. |

These rows come from the standards and the browsers' documentation. The SDK is covered by automated tests with a simulated browser; it has not been verified on a real push service of each browser.

## Safari and iOS

On iPhone and iPad, Web Push exists only for a site the visitor **added to the Home Screen** (Share, then Add to Home Screen), and the permission prompt has to come from a tap inside that installed app. In a Safari tab, `getSupport()` returns `ios_requires_installed_app`: show instructions to install the site instead of a subscribe button. The site needs a web app manifest (`display: standalone`) and HTTPS.

Every push has to show a notification. The worker does, but a push the browser cannot display can make Safari revoke the subscription.

## Limitations

- No collapse `topic` header, and no count for each button: a click on a button counts as a click on the notification. Buttons depend on the browser (the worker passes at most `Notification.maxActions`, never more than 3).
- The quiet hours and `delivery_mode` of a send use the time zone the browser reports; a subscription made by an older SDK, or by a browser that cannot say its zone, uses the zone of the project rule for the quiet hours and UTC for `delivery_mode`.
- A subscription not linked to a user (never called `identify`) receives only sends to everyone, not to a segment.
- There is no delivery receipt for Web Push; opens and clicks are reported when the visitor clicks.
- Revoking the VAPID keys of a project deletes its subscriptions. To change the keys and keep the subscribers, rotate them in the dashboard: the old keys keep working for a window (30 days by default) and `subscribe()` / `trySubscribe()` moves each browser to the new key in its next session (a new tab, or a page opened 30 minutes or more after it was last seen), so call it on every visit of a visitor whose permission is `granted`.
- When the browser changes or expires the push subscription while the site is closed (`pushsubscriptionchange`), the service worker subscribes again with the same key and the server moves the user, the metadata and the time zone to the new subscription. It needs the current `sw.js` (copy it again after an update) and a visit in which the page subscribed with this version, because the page stores the public key of the project and the endpoint in IndexedDB for it. A project that verifies identities does not carry the user over: call `identify` again. If the worker cannot finish, the next `trySubscribe()` does.
- `trackEvent()` starts a journey or reaches a goal only for a person who also has a mobile device, because the journey engine enters a person through a mobile device; for a person with only a browser the event is recorded and nothing starts (coming soon). Events are not queued or retried.
- `forgetDevice()` and `setPreferences()` act on the project of the key only: the same browser subscribed to another project of your account is not touched.
- The package does not sign its requests; do not turn on required request signing for a project that has web subscriptions.
- A web subscription seen in the last 30 days counts as an active device in the plan limit (MAU), unless its user already has an active app device.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `trySubscribe()` returns `no_service_worker` | The worker file answers 404 or is served outside its scope. Run `npx @espresso-notify/web public` and serve the folder at the root of the domain, or set `swPath` and `swScope`. |
| `vapid_key_missing` | The project has no Web Push keys. Generate them in the dashboard, Web Push tab. |
| The prompt never appears | It was not called from a click, or the permission is already `denied`. Check `getPermissionState()`. |
| `ios_requires_installed_app` | The visitor is in a Safari tab. Ask them to add the site to the Home Screen. |
| The browser call is refused with 403 `origin_not_allowed` | The project lists allowed web origins and yours is not among them. Add the origin (`https://shop.example`) in the Web Push settings. |
| The subscription disappears | The push service answered 404 or 410: the visitor removed it or it expired. The server deletes it; subscribe again. |
| Opens and clicks stay at zero | The server has no `PUBLIC_API_URL`, or the worker copy was not built with the API URL. Use the worker from this package. |
| Notifications stop on Safari | A push that was not shown made Safari revoke the subscription. Keep the worker from this package, which always shows one. |

## Security notes

- Use the public key (`pk_`) only. The API answers a browser call only on the routes that take it.
- The worker reports clicks only to the API URL compiled into it, never to one named in a push, and opens only a page of your site or an `https` page.
- Restrict the origins that may use your public key in the Web Push settings of the project.

## License

MIT
