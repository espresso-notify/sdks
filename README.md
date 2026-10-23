# Espresso Notify SDKs

Open source SDKs of [Espresso Notify](https://espressonotify.com), a push notification platform for iOS, Android and the web.

| Folder | Package | For |
| ------ | ------- | --- |
| [`sdk/`](sdk) | `@espresso-notify/react-native` | iOS and Android apps built with Expo or React Native |
| [`sdk-web/`](sdk-web) | `@espresso-notify/web` | browsers: subscribe, identify the user and receive notifications through a service worker |

Both are MIT licensed. The documentation is at [docs.espressonotify.com](https://docs.espressonotify.com), and each folder has its own README.

## Status

**The packages are not published on npm yet.** This page and the install commands in the READMEs describe the first publication, version `0.0.1`. Until the packages are on npm, `npm install @espresso-notify/react-native` and `npm install @espresso-notify/web` fail with a 404.

## What this repository is

This is a **read-only mirror**. The code of the SDKs is developed in a private repository together with the Espresso Notify service, and a workflow copies the two SDK folders here, one way, with each commit. That has three consequences:

- Files in this repository are replaced on every sync. A pull request cannot be merged here, because the next sync would overwrite it. Open an issue instead and describe the change you want.
- Every commit here carries the subject of the commit it came from (never its body), and a `Monorepo-Commit:` line with its hash.
- The packages are built and published **from this repository**, by the workflows in [`.github/workflows`](.github/workflows), with an npm provenance statement. That is the reason the mirror is public: a published version links back to the exact commit and the workflow run that produced it.

## Verify what you install

Each package ships its built code (`dist`) in this repository, and CI rebuilds it from the source and fails if a single byte differs. To check a published version yourself, read [`SECURITY.md`](SECURITY.md), and the one inside each package folder, for the steps (`npm audit signatures`, and `npm run verify:dist` after `npm ci --ignore-scripts`).

## Reporting a vulnerability

Do not open a public issue for a vulnerability. See [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE).
