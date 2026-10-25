#!/usr/bin/env bash
# Execute copied deployment scripts with mocked Docker/age/flock only.
set -Eeuo pipefail

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
mkdir -p "$repo_root/.local"
work_root=$(mktemp -d "$repo_root/.local/deploy-test.XXXXXX")
old_image="ghcr.io/zcorw/zhijiao@sha256:$(printf 'a%.0s' {1..64})"
new_image="ghcr.io/zcorw/zhijiao@sha256:$(printf 'b%.0s' {1..64})"
project=zhijiao-deploy-test

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

prepare_case() {
  case_root="$work_root/$1 deployment with spaces"
  mkdir -p "$case_root/scripts/ops" "$case_root/bin" "$case_root/log" "$case_root/state" "$case_root/backups"
  cp "$repo_root/scripts/ops/common.sh" "$repo_root/scripts/ops/deploy.sh" "$case_root/scripts/ops/"
  printf 'services: {}\n' >"$case_root/compose.yaml"
  if [[ "$2" == overlay ]]; then printf 'services: {}\n' >"$case_root/compose.deepseek.yaml"; fi
  printf 'APP_ORIGIN=https://fictional.example.invalid\nAPP_IMAGE=%s\n' "$old_image" >"$case_root/.env"
  printf 'APP_IMAGE=%s\n' "$old_image" >"$case_root/state/deployment-$project.env"
  printf 'fictional-public-recipient\n' >"$case_root/recipient"
  cat >"$case_root/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" == compose ]] || exit 81
number=0
if [[ -f "$MOCK_LOG_DIR/count" ]]; then read -r number <"$MOCK_LOG_DIR/count"; fi
number=$((number + 1))
printf '%s\n' "$number" >"$MOCK_LOG_DIR/count"
printf '%s\0' "$@" >"$MOCK_LOG_DIR/$number.args"
printf '%s\n' "${APP_IMAGE:-}" >"$MOCK_LOG_DIR/$number.image"
operation=
for argument in "$@"; do
  case "$argument" in config|pull|stop|exec|run|up) operation=$argument; break ;; esac
done
[[ -n "$operation" ]] || exit 82
printf '%s\n' "$operation" >>"$MOCK_LOG_DIR/commands"
if [[ "$operation" == "${MOCK_FAIL_COMMAND:-}" ]]; then exit 83; fi
if [[ "$operation" == exec ]]; then printf 'fictional-database-backup\n'; fi
if [[ "$operation" == run ]]; then
  # Migration may start only after a completed backup and checksum exist.
  shopt -s nullglob
  backups=("$BACKUP_DIR"/zhijiao-*.dump.age)
  [[ ${#backups[@]} == 1 && -s "${backups[0]}" && -s "${backups[0]}.sha256" ]] || exit 84
  printf 'complete\n' >"$MOCK_LOG_DIR/migration-saw-backup"
fi
MOCK
  cat >"$case_root/bin/age" <<'MOCK'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ "${1:-}" == --encrypt && "${2:-}" == --recipients-file && -f "${3:-}" ]] || exit 85
printf 'fictional-encrypted-backup\n'
cat
MOCK
  cat >"$case_root/bin/flock" <<'MOCK'
#!/usr/bin/env bash
exit 0
MOCK
  chmod +x "$case_root/bin/docker" "$case_root/bin/age" "$case_root/bin/flock"
}

run_case() {
  local failure=$1 expected_status=$2
  local actual_status=0
  env PATH="$case_root/bin:$PATH" \
    ENV_FILE="$case_root/.env" DEPLOY_STATE_DIR="$case_root/state" \
    COMPOSE_PROJECT_NAME="$project" BACKUP_DIR="$case_root/backups" \
    AGE_RECIPIENT_FILE="$case_root/recipient" BACKUP_RETENTION_DAYS=30 \
    MOCK_LOG_DIR="$case_root/log" MOCK_FAIL_COMMAND="$failure" \
    APP_IMAGE="$old_image" \
    bash "$case_root/scripts/ops/deploy.sh" "$new_image" >"$case_root/deploy.log" 2>&1 || actual_status=$?
  if [[ "$expected_status" == success ]]; then
    [[ "$actual_status" == 0 ]] || fail "deployment failed; see $case_root/deploy.log"
    [[ "$(cat "$case_root/state/deployment-$project.env")" == "APP_IMAGE=$new_image" ]] || fail 'successful deployment did not save the new image'
    [[ -f "$case_root/log/migration-saw-backup" ]] || fail 'migration did not observe a completed backup'
  else
    [[ "$actual_status" != 0 ]] || fail "mock $failure failure was ignored"
    [[ "$(cat "$case_root/state/deployment-$project.env")" == "APP_IMAGE=$old_image" ]] || fail 'failed deployment replaced the previous image state'
    [[ ! -e "$case_root/state/deployment-$project.env.incomplete" ]] || fail 'failed deployment left a new state candidate'
  fi
}

assert_calls() {
  local overlay=$1 expected_commands=$2
  local actual_commands number index
  actual_commands=$(paste -sd ',' "$case_root/log/commands")
  [[ "$actual_commands" == "$expected_commands" ]] || fail "unexpected command order: $actual_commands"
  local prefix=(compose --project-directory "$case_root" --project-name "$project" --env-file "$case_root/.env" --env-file "$case_root/state/deployment-$project.env" -f "$case_root/compose.yaml")
  if [[ "$overlay" == overlay ]]; then prefix+=(-f "$case_root/compose.deepseek.yaml"); fi
  read -r number <"$case_root/log/count"
  for ((index = 1; index <= number; index++)); do
    local arguments=()
    mapfile -d '' -t arguments <"$case_root/log/$index.args"
    [[ ${#arguments[@]} -gt ${#prefix[@]} ]] || fail 'Docker command lost its Compose prefix'
    local argument_index
    for ((argument_index = 0; argument_index < ${#prefix[@]}; argument_index++)); do
      [[ "${arguments[argument_index]}" == "${prefix[argument_index]}" ]] || fail "Compose argument $argument_index changed or split on spaces"
    done
    [[ "$(cat "$case_root/log/$index.image")" == "$new_image" ]] || fail 'an old environment/state image overrode the requested digest'
    # The next argument must be the operation, not an extra/unexpected -f file.
    case "${arguments[${#prefix[@]}]}" in config|pull|stop|exec|run|up) ;; *) fail 'unexpected Compose override or operation' ;; esac
  done
}

prepare_case with-overlay overlay
run_case '' success
assert_calls overlay 'config,pull,stop,exec,run,up'
printf 'PASS: overlay survives configuration, pull, backup, migration and startup; paths with spaces and new image state remain correct.\n'

prepare_case without-overlay base
run_case '' success
assert_calls base 'config,pull,stop,exec,run,up'
printf 'PASS: an absent optional overlay preserves the base deployment flow.\n'

for failure in config pull run up; do
  prepare_case "failed-$failure" overlay
  run_case "$failure" failure
  case "$failure" in
    config) expected='config' ;;
    pull) expected='config,pull' ;;
    run) expected='config,pull,stop,exec,run' ;;
    up) expected='config,pull,stop,exec,run,up' ;;
  esac
  assert_calls overlay "$expected"
  printf 'PASS: %s failure stops the sequence and preserves the previous deployment state.\n' "$failure"
done

printf '6 mock deployment cases passed. No Docker engine, real age encryption, network or VPS was used.\n'
printf 'Fictional test evidence: %s\n' "$work_root"
