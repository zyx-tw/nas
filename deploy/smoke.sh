#!/usr/bin/env bash
# The release bundle as deployed: copy /release out of the image and run it
# with the same Bun the CT has. ci runs it with the image loaded as
# ghcr.io/zyx1121/nas:ci.
set -euo pipefail
image=${1:-ghcr.io/zyx1121/nas:ci}
dir=$(mktemp -d)
cid=$(docker create "$image" /none)
docker cp "$cid:/release/." "$dir/"
docker rm "$cid" >/dev/null
trap 'docker logs nas || true' EXIT

docker run -d --name nas -p 127.0.0.1:8080:8080 -v "$dir:/app:ro" -w /app \
  -e NAS_DATA=/tmp/nas -e NAS_DIST=/app/dist -e NAS_PORT=8080 \
  -e NAS_ORIGIN=http://localhost:8080 -e NAS_SHARE_ORIGIN=http://127.0.0.1:8080 \
  oven/bun:1.4.2 bun build/server.js >/dev/null
for i in $(seq 1 30); do curl -s -o /dev/null localhost:8080/ && break; sleep 0.5; done

code() { curl -s -o /dev/null -w "%{http_code}" "localhost:8080$1"; }
test "$(code /)" = 200
test "$(code /api/files)" = 401
trap - EXIT
docker rm -f nas >/dev/null
echo "smoke passed"
