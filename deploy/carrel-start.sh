#!/bin/sh
# carrel-deployd (from land) runs this from the release directory on every
# deploy and rollback, as the nas user, with /srv/apps/nas/env loaded. The
# release holds the built server and web app.
set -eu
export NAS_DIST="$PWD/dist"
exec bun build/server.js
