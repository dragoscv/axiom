#!/usr/bin/env bash
# Startup script of an ephemeral AXIOM visual/a11y VM (launched by scripts/visual-cloud/run.mjs).
# Boots from brivio's image family `brivio-e2e-runner` (Node, Playwright OS deps, gcloud).
#
# Contract — everything under gs://<bucket>/axiom/runs/<id>/:
#   in:  config.env (BASE_URL, PW_VERSION, AXE_VERSION, SERVE_VERSION), capture.mjs, site.tgz (optional)
#   out: log (streamed every 15 s), results.tgz, meta.json, exit-code (written LAST)
# The VM deletes itself in the EXIT trap; run.mjs also deletes it in `finally`
# and --max-run-duration is the backstop.
set -uo pipefail

md() { curl -fsS -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/instance/$1"; }
RUN="$(md attributes/run-prefix)"
NAME="$(md name)"
ZONE="$(md zone | awk -F/ '{print $NF}')"
W=/opt/axiom-visual
LOG=/var/log/axiom-visual.log
T0=$(date +%s)
: > "$LOG"; chmod 644 "$LOG"
exec > >(tee -a "$LOG") 2>&1
phase() { echo "::phase $1 $(( $(date +%s) - T0 ))s"; }

finish() {
  local code=$?
  [ -f /tmp/cap-exit ] && code="$(cat /tmp/cap-exit)"
  phase "done exit=$code"
  # Never `kill 0`: that signals the whole process group, including
  # google_metadata_script_runner, and the trap dies before uploading anything.
  for p in "${SYNC_PID:-}" "${SERVE_PID:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  [ -d "$W/out" ] && tar -czf /tmp/results.tgz -C "$W/out" . && gcloud storage cp -q /tmp/results.tgz "$RUN/results.tgz"
  printf '{"machine":"%s","zone":"%s","seconds":%s,"exit":%s}\n' \
    "$(md machine-type | awk -F/ '{print $NF}')" "$ZONE" "$(( $(date +%s) - T0 ))" "$code" > /tmp/meta.json
  gcloud storage cp -q /tmp/meta.json "$RUN/meta.json"
  gcloud storage cp -q "$LOG" "$RUN/log"
  echo "$code" > /tmp/exit-code && gcloud storage cp -q /tmp/exit-code "$RUN/exit-code"
  gcloud compute instances delete "$NAME" --zone "$ZONE" --quiet --delete-disks=all
}
trap finish EXIT

( while sleep 15; do gcloud storage cp -q "$LOG" "$RUN/log" 2>/dev/null; done ) &
SYNC_PID=$!

phase boot
mkdir -p "$W/out" && cd "$W"
gcloud storage cp -q "$RUN/config.env" "$W/config.env" || exit 1
gcloud storage cp -q "$RUN/capture.mjs" "$W/capture.mjs" || exit 1
set -a; . "$W/config.env"; set +a
node --version

if gcloud storage cp -q "$RUN/site.tgz" /tmp/site.tgz 2>/dev/null; then
  # The Astro site is built with base /axiom: serve a parent dir so URLs match production.
  mkdir -p /srv/site/axiom && tar -xzf /tmp/site.tgz -C /srv/site/axiom
  [ -f /srv/site/axiom/404.html ] && cp /srv/site/axiom/404.html /srv/site/404.html
  nohup npx -y "serve@${SERVE_VERSION}" -l 4321 /srv/site > /tmp/serve.log 2>&1 &
  SERVE_PID=$!
  for _ in $(seq 1 60); do curl -fsS -o /dev/null http://localhost:4321/axiom/ && break; sleep 2; done
  curl -fsS -o /dev/null http://localhost:4321/axiom/ || { echo "serve did not come up"; cat /tmp/serve.log; exit 1; }
  BASE_URL="http://localhost:4321/axiom/"
  phase served
fi

export PLAYWRIGHT_BROWSERS_PATH=/opt/axiom-visual/browsers CI=1
npm init -y >/dev/null
npm install --no-audit --no-fund --loglevel=error "playwright@${PW_VERSION}" "@axe-core/playwright@${AXE_VERSION}" || exit 1
npx playwright install --with-deps chromium >/tmp/pw-install.log 2>&1 || { tail -30 /tmp/pw-install.log; exit 1; }
npx playwright --version
phase install

echo "capturing $BASE_URL"
node capture.mjs --base "$BASE_URL" --out "$W/out"; echo $? > /tmp/cap-exit
phase captured
exit 0
