# Security of the `@espresso-notify/web` package

The published package contains the contents of `sdk-web/dist`, which is generated from `sdk-web/src` and kept in the repository.
`dist` is compiled JavaScript, so it cannot be reviewed by reading it; what you can verify is that it is exactly what the source builds to,
and, once the package is published, who built and published it.

## Status

**The package is not published on npm yet.** Until it is, there is no provenance to check, and you read and build the code from the public mirror, https://github.com/espresso-notify/sdks. The steps below are what applies from the first publication on.

The mirror is a one-way copy of the repository where the SDK is developed together with the Espresso Notify service, made on every change. Each commit in the mirror carries the subject of the commit it came from and a `Monorepo-Commit:` line with its hash. The package is built and published **from the mirror**, which is public so that npm can sign the provenance of each version.

## Verify the package you installed

1. **Provenance and signatures.** The package is published by the workflow `.github/workflows/publish-sdk.yml` of the public mirror, with `npm publish --provenance`, from GitHub Actions, with an OIDC identity and no token on a developer machine. In your app, after installing:

   ```bash
   npm audit signatures
   ```

   It checks the registry signature and the provenance attestation of every installed package (npm 9.5 or newer). The npm page of the package shows "Built and signed on GitHub Actions" and links to the commit and the workflow run. If the attestation names another repository than https://github.com/espresso-notify/sdks, another workflow or a commit that is not on `main`, do not use that version.

2. **Rebuild from the tag and compare.** A release is the tag `web-v<version>` of the mirror. Check out that tag, rebuild, and compare byte by byte with what you have:

   ```bash
   git clone https://github.com/espresso-notify/sdks.git mirror && cd mirror
   git checkout web-v<version>
   cd sdk-web && npm ci --ignore-scripts && npm run verify:dist         # tracked dist == rebuilt dist
   diff -r dist /path/to/your/node_modules/@espresso-notify/web/dist
   ```

   `verify:dist` (`scripts/verify-dist.mjs` of the mirror) rebuilds in a temporary copy with the production API URL and fails if any file differs, is missing or is extra. The build is deterministic: `typescript` is pinned to an exact version.

3. **The same check runs on every push and pull request** to the mirror (job `dist-reproducible` of `.github/workflows/ci.yml`), and again before every publish, so a `dist` that is not the build of its source does not reach the registry.

4. **The API URL.** The built package talks only to `https://api.espressonotify.com`; `sdk/__tests__/committed-dist.test.ts (it covers both packages)` fails on a development URL in the tracked `dist`. `npm pack` and the publish job refuse a `dist`, on disk or inside the tarball, that still holds the placeholder the build leaves for the API URL when `ESPRESSO_API_URL` is not set (the name of that placeholder is in `inject-url.mjs`) (`prepack` runs `node ../scripts/verify-dist.mjs --no-placeholder .`).

## What a browser can call with the public key

The package runs in the browser of your visitor, so it holds only the public key (`pk_`), and the constructor refuses a secret key (`sk_`). It does not sign its requests and has no device attestation, which a browser does not have. These are the routes it calls, all under `/v1/web-push/` except the last, and what each can do:

| Route | What it does |
| --- | --- |
| `POST /v1/web-push/subscribe` and `/v1/web-push/vapid-key` | Registers the subscription (with the optional consent record) and reads the public VAPID key. |
| `DELETE /v1/web-push/device` | `forgetDevice()`: erases the subscription, its delivery records and events and, when no other device is left, the person. |
| `POST /v1/web-push/preferences` and `/v1/web-push/preferences/query` | `setPreferences()` and `getPreferences()`: the category opt-outs of the person behind the subscription. |
| `POST /v1/web-push/event` | `trackEvent()`: a business event of the person behind the subscription, 60 a minute for each subscription. |
| `POST /v1/notifications/track-web` | The worker (`opened`, `clicked`) and `trackConversion()` (`converted`): counted once for each browser, and only for a notification delivered to it. |

The proof that a call speaks for a browser is the **endpoint** of its push subscription, a secret URL of the push service that only the browser, the sender of the push and the Espresso Notify server know. It is a capability: whoever has it can erase the subscription, read and write its preferences and report events, so it travels in the body of the request and never in a URL, where access logs and proxies would keep it, and it is not printed by the SDK. The API answers 404 in the same way for an unknown endpoint and for the endpoint of another project, so a sweep of endpoints learns nothing, and limits the routes by network address and by site.

When the project asks for the proof of identity (mode `required`), `forgetDevice({ identityHash })` needs it too: without it the API answers 403 `identity_verification_failed` and erases nothing. The hash is `HMAC-SHA256(externalId, project secret)` computed on **your server**; the secret never goes to the page. A public key alone can therefore never erase a person whose project requires the proof. Restrict the web origins that may use the key in the Web Push settings of the project: a call from another origin is refused with 403 `origin_not_allowed`.

## Report a vulnerability

Report it privately: use the "Report a vulnerability" button in the Security tab of the public mirror, or write to the maintainers (CaffeeeLabs) through the contact on https://espressonotify.com. Do not open a public issue for a vulnerability.
