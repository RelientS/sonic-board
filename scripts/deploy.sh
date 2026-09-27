#!/usr/bin/env bash
# Deploy the current commit to the production origin.
#
#   scripts/deploy.sh [ssh-target]        (default ubuntu@43.133.8.106)
#
# Steps: package HEAD with git archive, create /srv/sonic-board/releases/<sha>
# from the live release (reusing its node_modules), sync the source, run
# tests, typecheck and the production build on the server, smoke-test the new
# release on a side port, then switch the `current` symlink atomically,
# restart the service and health-check it. A failed health check rolls back
# to the previous release. Lint runs elsewhere (the server's eslint is
# broken); run `npm run lint` before deploying.
set -euo pipefail

TARGET=${1:-ubuntu@43.133.8.106}
ROOT=/srv/sonic-board
SIDE_PORT=3112

cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain)" ]; then
  echo "note: uncommitted changes are not deployed (packaging HEAD only)" >&2
fi
SHA=$(git rev-parse HEAD)
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
git archive HEAD | tar -x -C "$STAGE"
# mktemp makes a 0700 directory and rsync copies that mode onto the release
# root, which would hide public/audio from Caddy (it serves it from disk).
chmod 755 "$STAGE"

echo "== preparing release $SHA"
ssh "$TARGET" "set -e
  test -d $ROOT/releases/$SHA && { echo 'release exists; reusing'; exit 0; }
  cp -a \"\$(readlink -f $ROOT/current)\" $ROOT/releases/$SHA
  rm -rf $ROOT/releases/$SHA/.vinext $ROOT/releases/$SHA/dist"
rsync_opts=(-a --delete --exclude=/node_modules --exclude=/public/audio/nam --exclude=/.next --exclude=/.wrangler)
rsync "${rsync_opts[@]}" "$STAGE/" "$TARGET:$ROOT/releases/$SHA/"

echo "== install, test, typecheck, build on the server"
ssh "$TARGET" "set -e; cd $ROOT/releases/$SHA
  npm ci --no-audit --no-fund > /tmp/sb-deploy-install.log 2>&1 || { tail -20 /tmp/sb-deploy-install.log; exit 1; }
  npm test > /tmp/sb-deploy-test.log 2>&1 || { grep -E '^not ok|^# (pass|fail)' /tmp/sb-deploy-test.log | head -20; exit 1; }
  grep -E '^# (pass|fail)' /tmp/sb-deploy-test.log
  npm run typecheck > /tmp/sb-deploy-typecheck.log 2>&1 || { tail -20 /tmp/sb-deploy-typecheck.log; exit 1; }
  npm run build > /tmp/sb-deploy-build.log 2>&1 || { tail -30 /tmp/sb-deploy-build.log; exit 1; }"

echo "== smoke test on port $SIDE_PORT"
ssh "$TARGET" "set -e; cd $ROOT/releases/$SHA
  SMOKE=\$(mktemp -d)
  (SONIC_DATA_DIR=\$SMOKE NODE_ENV=production nohup npm start -- --port $SIDE_PORT --hostname 127.0.0.1 > /tmp/sb-smoke.log 2>&1 &)
  ok=0
  for i in \$(seq 1 40); do curl -sf -o /dev/null http://127.0.0.1:$SIDE_PORT/ && { ok=1; break; }; sleep 1; done
  code_page=\$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:$SIDE_PORT/)
  code_agent=\$(curl -s -o /dev/null -w %{http_code} -X POST -H 'content-type: application/json' -d '{}' http://127.0.0.1:$SIDE_PORT/api/tone-agent)
  pid=\$(ss -ltnp | grep ':$SIDE_PORT ' | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2)
  [ -n \"\$pid\" ] && kill \$pid
  rm -rf \$SMOKE
  echo \"page \$code_page, anonymous agent \$code_agent\"
  [ \$ok = 1 ] && [ \$code_page = 200 ] && [ \$code_agent = 401 ]"

echo "== switching"
ssh "$TARGET" "set -e
  previous=\$(readlink -f $ROOT/current)
  sudo ln -sfn $ROOT/releases/$SHA $ROOT/current.new
  sudo mv -T $ROOT/current.new $ROOT/current
  sudo systemctl restart sonic-board
  healthy=0
  for i in \$(seq 1 30); do curl -sf -o /dev/null http://127.0.0.1:3111/ && { healthy=1; break; }; sleep 1; done
  if [ \$healthy != 1 ]; then
    echo 'health check failed; rolling back' >&2
    sudo ln -sfn \"\$previous\" $ROOT/current.new
    sudo mv -T $ROOT/current.new $ROOT/current
    sudo systemctl restart sonic-board
    exit 1
  fi
  echo \"live: $SHA (previous: \$previous)\""
