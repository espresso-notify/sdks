# Security policy

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Report it privately through the **Report a vulnerability** button of the Security tab of this repository (a private security advisory), or write to the maintainers (CaffeeeLabs) through the contact on https://espressonotify.com. Say which package and version you tested, what you did and what happened. We answer as soon as we can; this policy makes no promise about the time of an answer.

## What is in this repository

This repository is a one-way mirror of the two SDKs of Espresso Notify, `@espresso-notify/react-native` (`sdk/`) and `@espresso-notify/web` (`sdk-web/`). The service itself (API, dashboard, workers) is not here. The project key (`pk_`) is public by design and a secret key (`sk_`) is refused by both clients; nothing in the SDKs is secret.

## Verify a package

The packages are not published on npm yet. From the first publication on, each version is published by the workflow [`publish-sdk.yml`](.github/workflows/publish-sdk.yml) of this repository, from a tag (`react-native-v<version>` or `web-v<version>`) on a commit of `main`, with `npm publish --provenance` and no token on a developer machine.

1. In your app, `npm audit signatures` checks the registry signature and the provenance attestation of every installed package (npm 9.5 or newer). The npm page of a version shows "Built and signed on GitHub Actions" and links to the commit and the run. If the attestation names another repository, another workflow or a commit that is not on `main`, do not use that version.
2. Check out the tag, then `cd sdk && npm ci --ignore-scripts && npm run verify:dist` (or `sdk-web`). The check rebuilds `dist` in a temporary copy and fails if any file differs, is missing or is extra.
3. The same rebuild runs on every push and pull request (job `dist-reproducible` of [`ci.yml`](.github/workflows/ci.yml)) and again before every publish.

More detail is in `sdk/SECURITY.md` and `sdk-web/SECURITY.md`.
