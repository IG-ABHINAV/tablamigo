#!/usr/bin/env bash
# Throwaway PostGIS for the automated suites (TESTING.md, "Automated suites"). Never the dev database on 5434.
#   bash apps/api/scripts/test-db.sh up      # start (or reuse) the container on 127.0.0.1:5499, create + migrate the three test DBs
#   bash apps/api/scripts/test-db.sh reset   # drop and recreate the three test databases, then migrate (a clean slate)
#   bash apps/api/scripts/test-db.sh down    # remove the container and its data
# Databases, one per suite that leaves rows behind:
#   tablamigo_test          vitest unit/integration/e2e
#   tablamigo_e2e_test      src/scripts/e2e-scenarios.ts (counts every email the scheduler sends, so no other suite may write here)
#   tablamigo_browser_test  the web-app browser pass (apps/mobile/e2e-web; leaves its @qa.test personas behind, which would
#                           get scheduler emails in the scenarios' database and fail "Second scheduler runs send nothing new")
set -euo pipefail
NAME=${TEST_DB_CONTAINER:-tablamigo-suite-db}
PORT=${TEST_DB_PORT:-5499}
IMAGE=postgis/postgis:16-3.4
API_DIR="$(cd "$(dirname "$0")/.." && pwd)"
URL_BASE="postgres://tablamigo:tablamigo-test@127.0.0.1:${PORT}"

psql_in() { docker exec -i "$NAME" psql -v ON_ERROR_STOP=1 -U tablamigo -d postgres -qtAc "$1"; }
migrate() { (cd "$API_DIR" && DATABASE_URL="$URL_BASE/$1" npx tsx src/db/migrate.ts >/dev/null 2>&1) && echo "migrated $1"; }

case "${1:-up}" in
  up|reset)
    if ! docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
      docker run -d --name "$NAME" -e POSTGRES_USER=tablamigo -e POSTGRES_PASSWORD=tablamigo-test -e POSTGRES_DB=postgres \
        -p "127.0.0.1:${PORT}:5432" "$IMAGE" >/dev/null
    fi
    docker start "$NAME" >/dev/null
    # Over TCP: a fresh container's init server answers on the socket only, then restarts, so a socket check passes too early.
    for _ in $(seq 60); do docker exec "$NAME" pg_isready -h 127.0.0.1 -U tablamigo -d postgres >/dev/null 2>&1 && break; sleep 1; done
    for db in tablamigo_test tablamigo_e2e_test tablamigo_browser_test; do
      [ "$1" = reset ] && psql_in "drop database if exists $db with (force)"
      [ "$(psql_in "select 1 from pg_database where datname = '$db'")" = 1 ] || psql_in "create database $db"
      migrate "$db"
    done
    echo "export DATABASE_URL=$URL_BASE/tablamigo_test"
    echo "export E2E_DATABASE_URL=$URL_BASE/tablamigo_e2e_test"
    echo "export BROWSER_DATABASE_URL=$URL_BASE/tablamigo_browser_test"
    ;;
  down) docker rm -f "$NAME" >/dev/null && echo "removed $NAME" ;;
  *) echo "usage: $0 up|reset|down" >&2; exit 2 ;;
esac
