#!/usr/bin/env bash
# Run manually with an approved GHCR digest. No remote login or production trigger.
set -Eeuo pipefail
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
[[ $# == 1 && "$1" =~ ^ghcr\.io/zcorw/zhijiao@sha256:[a-f0-9]{64}$ ]] || fail "Usage: bash scripts/ops/deploy.sh ghcr.io/zcorw/zhijiao@sha256:<64 hex characters>"
upgrade_lock
export APP_IMAGE="$1"
"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" pull app
# Backup is mandatory; the first install uses the documented initial setup flow.
"${COMPOSE[@]}" stop app
backup_database
# Writers are stopped before the snapshot. A failure leaves manual recovery.
"${COMPOSE[@]}" run --rm --no-deps app node apps/server/dist/migrate.js
"${COMPOSE[@]}" up --detach --no-deps --no-build --wait --wait-timeout 90 app
# Persist only a digest, after health succeeds, for subsequent local operations.
state_tmp="$STATE_FILE.incomplete"
printf 'APP_IMAGE=%s\n' "$APP_IMAGE" >"$state_tmp"
mv -- "$state_tmp" "$STATE_FILE"
printf 'Healthy deployment: %s\n' "$APP_IMAGE"
printf 'Saved local image selection: %s\n' "$STATE_FILE"
