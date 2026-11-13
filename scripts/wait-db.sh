#!/usr/bin/env bash
# `docker compose up -d` returns as soon as the container is created. A fresh postgis/postgis volume boots a temporary
# init server that answers on the unix socket only, then restarts into the real server, so `npm run migrate` run straight
# after `npm run db` gets no usable connection (issue #10: ECONNREFUSED; on Docker Desktop for Windows the port proxy
# accepts the socket instead, and the driver hangs until the real server is up). Wait for the real server the way
# apps/api/scripts/test-db.sh already does: over TCP, because a socket check passes during the init phase, before port
# 5432 listens. 180s, not 60: a cold volume on this machine runs initdb plus the PostGIS extensions for ~4 minutes.
set -euo pipefail
NAME=${DB_CONTAINER:-tablamigo-db}
LIMIT=${DB_WAIT_SECONDS:-180}
if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "wait-db: container $NAME is not running; did npm run db succeed?" >&2
  exit 1
fi
for _ in $(seq "$LIMIT"); do
  docker exec "$NAME" pg_isready -h 127.0.0.1 -U tablamigo >/dev/null 2>&1 && exit 0
  sleep 1
done
echo "wait-db: $NAME accepted no TCP connection within ${LIMIT}s" >&2
exit 1
