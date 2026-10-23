# Espresso Push Test — Web

A plain Vite app (no framework) that exercises `@espresso-notify/web`: it registers the service
worker, asks for the notification permission **on a click**, subscribes the browser, identifies a
user and lists the notifications the page receives.

Documentation: [Web quickstart](https://docs.espressonotify.com/docs/sdks/web/quickstart) · [Web SDK](https://docs.espressonotify.com/docs/sdks/web) · [SDK reference](https://docs.espressonotify.com/docs/sdks/web/reference) · Package: [`@espresso-notify/web`](https://www.npmjs.com/package/@espresso-notify/web) · [Website](https://espressonotify.com) · [Dashboard](https://espressonotify.com/login) · [Repository](https://github.com/espresso-notify/sdks)

## Run it

```bash
cd examples/web-push-test
cp .env.example .env      # then put the public key (pk_) of your project in .env
npm install
npm run dev               # http://localhost:5173
```

You need a project with Web Push keys generated (dashboard, project, **Web Push** tab) and its
**public** key. `.env` is git-ignored; `.env.example` holds placeholders only. Never put a secret key
(`sk_`) here: Vite ships every `VITE_` variable to the browser.

| Variable | What it is |
| --- | --- |
| `VITE_ESPRESSO_PROJECT_ID` | The public key of the project (`pk_...`). |
| `VITE_ESPRESSO_API_URL` | The API the SDK talks to. Default `https://api.espressonotify.com`; use `http://localhost:8080` for an API running on your machine. |

The API URL is compiled into the SDK and into the service worker, so it is not read at run time.
`npm run dev` and `npm run build` first run `npm run prepare:sdk`, which builds
`@espresso-notify/web` from `../../sdk-web` with that URL, puts it in `node_modules` like an
installed package and installs the service worker with the package's own command
(`public/push/espressonotify/espresso-notify-sw.js`). The committed `sdk-web/dist` is not touched.

In your own app, none of that is needed (this is the npm package instead of the `../../sdk-web` build above):

```bash
npm install @espresso-notify/web
npx @espresso-notify/web public
```

## Try it

1. Open the page and click **Enable notifications**. The browser asks for the permission only now.
2. Type your own id for the user and click **Identify**.
3. Send a notification from the dashboard or from your server with the secret key. The system
   notification comes from the service worker; the page also lists it, through `onPush`.

An API running on your machine accepts browser calls from `http://localhost` origins. If the project lists allowed
web origins, add `http://localhost:5173` (or the port you use) or the call is refused with 403
`origin_not_allowed`.

## Browsers

Chrome, Edge, Firefox and Safari 16.4+ on macOS work from a normal tab. On iPhone and iPad, Web Push
only works for a page added to the Home Screen: the app ships a web app manifest, and the page tells
the visitor what to do when it detects a Safari tab. Serve the page over HTTPS to test on a phone
(for example through a tunnel).

## Build

```bash
npm run build     # type-checks, builds the SDK, then builds the app into dist/
```
