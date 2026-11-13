# Tablamigo

A free app for solo travellers to meet nearby: post a plan on a map, join with one tap, chat with the group.

- Web app: https://tablamigo.hookstep.in/app
- Android: https://play.google.com/store/apps/details?id=com.tablamigo.app
- Website: https://tablamigo.hookstep.in

Tablamigo is built by Hookstep, Mumbai, India.

## Open source

Tablamigo is open source under the GNU Affero General Public License v3.0. You can read the code, run your own copy, change it and share your changes. If you run a modified Tablamigo as a service for other people, the AGPL asks you to offer those users the source of your modified version.

The Android app on Google Play and the web app at tablamigo.hookstep.in are built from this repository.

## What is in this repo

| Folder | What it is |
|---|---|
| `apps/api` | Fastify 5 + TypeScript API, PostgreSQL with PostGIS (`postgres`), Zod validation, Socket.IO for chat, vitest tests |
| `apps/mobile` | Expo / React Native app with Expo Router. The same code ships as the Android app and the web app (`/app`) |
| `apps/web` | Static marketing site, built by `apps/web/build.py` and checked by `check.py` |

## Quickstart

You need Node.js, Docker and (for the website) Python 3.

```bash
npm install
npm run db                                  # Postgres + PostGIS on port 5434
cp apps/api/.env.example apps/api/.env
npm run migrate
npm run seed                                # optional demo plans and people
npm run api                                 # http://localhost:4100

cd apps/mobile && npm install && npm run web
```

With no email key set, sign-in codes are printed in the API console. Face-verification models are downloaded on first build by `apps/api/scripts/fetch-face-models.mjs`. Google sign-in, Play Billing, Razorpay, AdMob, push notifications and the R2 media bucket need your own accounts and keys; leave them unset for local work. Full setup, tests and PR rules are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing

Start with issues labelled [`good first issue`](../../issues?q=is%3Aopen+label%3A%22good+first+issue%22) and read [CONTRIBUTING.md](./CONTRIBUTING.md). Report security problems through [SECURITY.md](./SECURITY.md), not public issues.

## Security

Please report vulnerabilities privately to support@hookstep.in, see [SECURITY.md](SECURITY.md).

## License

[GNU AGPL v3.0](./LICENSE). Third-party fonts (Plus Jakarta Sans, Ionicons) keep their own licences (SIL OFL 1.1 and MIT); the OFL text is in `apps/mobile/public/fonts/OFL.txt`. Face-verification test photos in `apps/api/src/test-fixtures/faces/` are public-domain images from Wikimedia Commons, listed in `sources.json`.

The Tablamigo name and logo are not covered by the AGPL. You may fork and rebrand the code, but please do not publish a fork under the Tablamigo name, logo or the `com.tablamigo.app` package id.

## Contributors

Thanks to everyone who has contributed. New here? Start with an issue labelled `good first issue`.

<a href="https://github.com/hookstep/tablamigo/graphs/contributors"><img src="https://contrib.rocks/image?repo=hookstep/tablamigo" alt="Contributors to tablamigo" /></a>
