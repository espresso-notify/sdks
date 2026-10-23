# Security of the `@espresso-notify/react-native` package

The published package contains the contents of `sdk/dist`, which is generated from `sdk/src` and kept in the repository.
`dist` is readable: the plain output of `tsc` (CommonJS) with the production API URL filled in, and the type declarations (`.d.ts`) next to it.
The SDK is open source (MIT) and is not obfuscated. What you can verify is that `dist` is exactly what the source builds to and, once
the package is published, who built and published it. Nothing in the SDK is secret: the project key (`pk_`) is public by design, a secret
key (`sk_`) is refused by the client, and the integration is protected by the server and the options you turn on (request signing,
device attestation, certificate pinning), not by hiding code.

## What the private transport is, and is not

By default the package sends its requests through a small native module of its own (`privateTransport: 'auto'`), so that they do not appear in the JavaScript network tools of a development build: Reactotron, the Network panel of React Native DevTools, Rozenite and the Expo Network panel. That is hygiene for your development tools, **not a security boundary**, and nothing in the package relies on it as one. It does not hide the traffic from a proxy (Charles, Proxyman, mitmproxy) or from a native profiler, a release build has none of those JavaScript tools to hide from, and the call of `expo-notifications` to `exp.host` for an Expo push token stays visible (`tokenStrategy: 'device'` avoids it). Where the module is not linked (Expo Go, the web, tests), the package sends through `fetch` and those requests do show in the tools. What protects the integration is still the server and the options you turn on: request signing, device attestation and certificate pinning.

The package also writes nothing sensitive to a log or to an error message: no push token, external id, identity hash, key or payload, and no query string in the path of an HTTP error. The preferences read sends its identifiers in a request body, never in a URL.

## Status

**The package is not published on npm yet.** Until it is, there is no provenance to check, and you read and build the code from the public mirror, https://github.com/espresso-notify/sdks. The steps below are what applies from the first publication on.

The mirror is a one-way copy of the repository where the SDK is developed together with the Espresso Notify service, made on every change. Each commit in the mirror carries the subject of the commit it came from and a `Monorepo-Commit:` line with its hash. The package is built and published **from the mirror**, which is public so that npm can sign the provenance of each version.

## Verify the package you installed

1. **Provenance and signatures.** The package is published by the workflow `.github/workflows/publish-sdk.yml` of the public mirror, with `npm publish --provenance`, from GitHub Actions, with an OIDC identity and no token on a developer machine. In your app, after installing:

   ```bash
   npm audit signatures
   ```

   It checks the registry signature and the provenance attestation of every installed package (npm 9.5 or newer). The npm page of the package shows "Built and signed on GitHub Actions" and links to the commit and the workflow run. If the attestation names another repository than https://github.com/espresso-notify/sdks, another workflow or a commit that is not on `main`, do not use that version.

2. **Rebuild from the tag and compare.** A release is the tag `react-native-v<version>` of the mirror. Check out that tag, rebuild, and compare byte by byte with what you have:

   ```bash
   git clone https://github.com/espresso-notify/sdks.git mirror && cd mirror
   git checkout react-native-v<version>
   cd sdk && npm ci --ignore-scripts && npm run verify:dist         # tracked dist == rebuilt dist
   diff -r dist /path/to/your/node_modules/@espresso-notify/react-native/dist
   ```

   `verify:dist` (`scripts/verify-dist.mjs` of the mirror) rebuilds in a temporary copy with the production API URL and fails if any file differs, is missing or is extra. The build is deterministic: `tsc` plus the URL injection of `inject-url.mjs`, with `typescript` pinned to an exact version.

3. **The same check runs on every push and pull request** to the mirror (job `dist-reproducible` of `.github/workflows/ci.yml`), and again before every publish, so a `dist` that is not the build of its source does not reach the registry.

4. **The API URL.** The built package talks only to `https://api.espressonotify.com`; `sdk/__tests__/committed-dist.test.ts` fails on a development URL in the tracked `dist`. `npm pack` and the publish job refuse a `dist`, on disk or inside the tarball, that still holds the placeholder the build leaves for the API URL when `ESPRESSO_API_URL` is not set (the name of that placeholder is in `inject-url.mjs`) (`prepack` runs `node ../scripts/verify-dist.mjs --no-placeholder .`).

## Report a vulnerability

Report it privately: use the "Report a vulnerability" button in the Security tab of the public mirror, or write to the maintainers (CaffeeeLabs) through the contact on https://espressonotify.com. Do not open a public issue for a vulnerability.
