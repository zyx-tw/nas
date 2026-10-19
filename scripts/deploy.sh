#!/usr/bin/env bash
# Test and build on the sandbox, then ship build/ and dist/ to the nas CT and restart.
set -euo pipefail
cd "$(dirname "$0")/.."
rsync -a --delete --exclude node_modules --exclude .git --exclude dist --exclude build --exclude data ./ sandbox:work/nas/
ssh sandbox 'set -o pipefail; cd ~/work/nas && export PATH=$HOME/.bun/bin:$PATH && bun install --frozen-lockfile >/dev/null && bun test server 2>&1 | tail -3 && bun run build >/dev/null 2>&1 && rm -rf build && bun build server/index.ts --target bun --outfile build/server.js >/dev/null'
ssh sandbox 'cd ~/work/nas && tar czf - build dist' | ssh nas 'set -e; sudo rm -rf /opt/nas.new /opt/nas.old; sudo mkdir /opt/nas.new; sudo tar xzf - -C /opt/nas.new; [ -d /opt/nas ] && sudo mv /opt/nas /opt/nas.old; sudo mv /opt/nas.new /opt/nas; sudo systemctl restart nas; sleep 1; systemctl is-active nas'
