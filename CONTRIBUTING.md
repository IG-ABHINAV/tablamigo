# Contributing to Tablamigo

Thanks for helping. Tablamigo is a free app for solo travellers to meet nearby: plans on a map, one-tap join, group chat. This repo holds the API, the mobile and web app, and the marketing website.

| Folder | What it is |
|---|---|
| `apps/api` | Fastify + TypeScript API, Postgres/PostGIS, tests with vitest |
| `apps/mobile` | Expo / React Native app (Android and the web app at `/app`) |
| `apps/web` | Static marketing site, built by `build.py` |

Please read the [Code of Conduct](CODE_OF_CONDUCT.md). Pull requests from forks run CI on GitHub-hosted runners only, after a maintainer approves the first run. Report security problems privately, see [SECURITY.md](SECURITY.md).

## Run it locally

You need Node.js (the maintainers use Node 24), Docker, and Python 3 if you touch the website.

```bash
git clone https://github.com/hookstep/tablamigo.git
cd tablamigo
npm install                         # installs apps/api (npm workspace)

npm run db                          # Docker Postgres + PostGIS on port 5434
cp apps/api/.env.example apps/api/.env
npm run migrate                     # applies apps/api/src/db/migrations
npm run seed                        # optional demo plans and people (@demo.tablamigo)
npm run api                         # API on http://localhost:4100
```

Check it: `curl http://localhost:4100/health` should answer `{"ok":true,"db":"ok"}`. With no email key set, sign-in codes are printed in the API console instead of being emailed.

Run the app in a browser (Expo web):

```bash
cd apps/mobile
npm install
npm run web                         # talks to http://localhost:4100 by default
```

For an Android emulator or a real phone use `npx expo start`; on a phone set `EXPO_PUBLIC_API_URL` to your computer's LAN address (see `apps/mobile/.env.example`).

The website:

```bash
npm run web:build && npm run web:check
npm run web:serve                  # preview on http://127.0.0.1:5199
```

Every outside service (email, push, payments, AI moderation, photo storage) is optional locally and switches itself off when its key is empty. Never commit a real key: `.env` files are git-ignored and the `.env.example` files hold placeholders only.

## Tests

The API tests run against your local Docker database (the one `npm run db` starts, migrated), never a remote one.

```bash
cd apps/api
npx vitest run                      # all API tests (npm test also type-checks and fetches the face models once)
npx vitest run src/plans.test.ts    # one file
npx tsc --noEmit -p .               # typecheck (npm run typecheck also covers the test files)
npm run e2e                         # multi-account scenario run against a throwaway local API

cd ../mobile
npx tsc --noEmit -p .               # typecheck the app
npm run test:unit                   # node --test e2e-web/*.test.mjs
```

The browser pass in `apps/mobile/e2e-web/run.sh` needs Playwright; point `PLAYWRIGHT_FROM` at a folder that has `node_modules/playwright`.

## Pull requests

- **Small PRs, one issue per PR.** A PR that fixes three things is three PRs.
- **Link the issue** (`Closes #123`) and say how you tested it.
- **A test for every rule.** If you add or change behaviour in the API, add or update a vitest test that fails without your change.
- **Run the checks** above before you push: the API tests if you touched the API, the typechecks for the code you touched.
- **No secrets, no personal data.** No real emails, tokens, keys, phone numbers or screenshots of real people in code, tests, issues or PRs.
- **Match the style around you.** Read the neighbouring code first; comments in this repo explain why, not what.
- **Don't change unrelated files**, reformat whole files, or bump dependencies in a feature PR.
- Prices, the paywall and Plus copy are product decisions. Open an issue and agree the change with a maintainer before touching them.

## Claiming an issue

Comment on the issue that you'd like to work on it. We then assign it to you, and please wait for that before you start. If we haven't seen a PR or an update within **7 days** of assigning, we may give the issue to someone else, and you're welcome to take another.

## License

By contributing you agree that your contribution is licensed under the [GNU AGPL-3.0](LICENSE), the same as the rest of the project.
