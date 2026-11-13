#!/usr/bin/env bash
# Browser pass over the web app against a local API and a throwaway local test database (E2E_DATABASE_URL, required).
#   apps/mobile/e2e-web/run.sh [desktop|mobile|both] [scenario,...]
# Builds the web export pointing at the local API (out/web), serves it on :8099/app, starts the API on :4199 with
# every outside service faked, seeds the personas and drives headless Chrome. Screenshots of failures: out/shots.
# Set ADMIN_HTML=<path to apps/web/src/admin.html> to include the admin panel.
# E2E_DATABASE_URL is required: a migrated local test database that passes the API's test-db guard (db.mjs), e.g.
#   bash apps/api/scripts/test-db.sh up && E2E_DATABASE_URL=$BROWSER_DATABASE_URL bash apps/mobile/e2e-web/run.sh both
# CI points it at its service container. The dev database on 5434 is refused.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p out
# Refuse before the slow export when the database is missing or not a throwaway test database.
node -e "import('./db.mjs').catch(e => { console.error(e.message); process.exit(1); })"
# E2E_SKIP_EXPORT=1 reuses out/web from an earlier run (the export takes a few minutes).
if [ -z "${E2E_SKIP_EXPORT:-}" ] || [ ! -f out/web/index.html ]; then
  (cd .. && rm -rf e2e-web/out/web && EXPO_PUBLIC_API_URL=http://127.0.0.1:4199 npx expo export -p web --output-dir e2e-web/out/web --clear > e2e-web/out/build.log 2>&1)
fi
node server.mjs > out/server.log 2>&1 & API=$!
node static.mjs > out/static.log 2>&1 & WEB=$!
trap 'kill $API $WEB 2>/dev/null' EXIT
for i in $(seq 60); do curl -fs http://127.0.0.1:4199/health >/dev/null && break; sleep 0.5; done
node drive.mjs "${1:-both}" ${2:-}
