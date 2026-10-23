# Espresso Notify SDKs

Open source SDKs of [Espresso Notify](https://espressonotify.com), a push notification platform for iOS, Android and the web.

| Folder | Package | For | Links |
| ------ | ------- | --- | ----- |
| [`sdk/`](sdk) | [`@espresso-notify/react-native`](https://www.npmjs.com/package/@espresso-notify/react-native) | iOS and Android apps built with Expo or React Native | [Documentation](https://docs.espressonotify.com/docs/react-native) |
| [`sdk-web/`](sdk-web) | [`@espresso-notify/web`](https://www.npmjs.com/package/@espresso-notify/web) | browsers: subscribe, identify the user and receive notifications through a service worker | [Documentation](https://docs.espressonotify.com/docs/sdks/web) |

[Website](https://espressonotify.com) · [Documentation](https://docs.espressonotify.com) · [Dashboard](https://espressonotify.com/login) · [SDK changelog](https://docs.espressonotify.com/docs/support#sdk-changelog)

Both are MIT licensed. The documentation is at [docs.espressonotify.com](https://docs.espressonotify.com), and each folder has its own README.

## Examples

Three small apps show each SDK end to end. Each one has a README with the steps, and each README says how to use the npm package instead of the folder of this repository.

| Folder | Shows | Guide |
| ------ | ----- | ----- |
| [`examples/web-push-test/`](examples/web-push-test) | a plain Vite page that subscribes a browser, identifies a user and lists what it receives | [Web quickstart](https://docs.espressonotify.com/docs/sdks/web/quickstart) |
| [`examples/expo-push-test/`](examples/expo-push-test) | an Expo development build with the `usePushNotifications` hook | [Expo quickstart](https://docs.espressonotify.com/docs/react-native/expo) |
| [`examples/bare-push-test/`](examples/bare-push-test) | a React Native CLI app with Firebase Cloud Messaging | [React Native CLI guide](https://docs.espressonotify.com/docs/react-native/bare) |

[`examples/react-native-integration.ts`](examples/react-native-integration.ts) is a short file with the hook and the client side by side.

## Status

**The packages are published on npm** from version `0.0.1`: `npm install @espresso-notify/react-native` and `npm install @espresso-notify/web`. Each version is published from this repository, with an npm provenance statement.

## What this repository is

This is a **read-only mirror**. The code of the SDKs is developed in a private repository together with the Espresso Notify service, and a workflow copies the two SDK folders and the example apps here, one way, with each commit. That has three consequences:

- Files in this repository are replaced on every sync. A pull request cannot be merged here, because the next sync would overwrite it. Open an issue instead and describe the change you want.
- Every commit here carries the subject of the commit it came from (never its body), and a `Monorepo-Commit:` line with its hash.
- The packages are built and published **from this repository**, by the workflows in [`.github/workflows`](.github/workflows), with an npm provenance statement. That is the reason the mirror is public: a published version links back to the exact commit and the workflow run that produced it.

## Verify what you install

Each package ships its built code (`dist`) in this repository, and CI rebuilds it from the source and fails if a single byte differs. To check a published version yourself, read [`SECURITY.md`](SECURITY.md), and the one inside each package folder, for the steps (`npm audit signatures`, and `npm run verify:dist` after `npm ci --ignore-scripts`).

## Reporting a vulnerability

Do not open a public issue for a vulnerability. See [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE).
