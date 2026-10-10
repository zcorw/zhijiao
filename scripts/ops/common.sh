#!/usr/bin/env bash
# Shared helpers for manually invoked Linux VPS operations. Never enables tracing.
set -Eeuo pipefail
umask 077

OPS_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
ENV_FILE=${ENV_FILE:-"$OPS_ROOT/.env"}
COMPOSE_PROJECT_NAME=${COMPOSE_PROJECT_NAME:-zhijiao}
DEPLOY_STATE_DIR=${DEPLOY_STATE_DIR:-"$OPS_ROOT/.local"}

fail() { printf '%s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "Required program not found: $1"; }
need docker
[[ -f "$ENV_FILE" ]] || fail "Compose environment file not found: $ENV_FILE"
[[ "$COMPOSE_PROJECT_NAME" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || fail "Invalid Compose project name"
COMPOSE=(docker compose --project-directory "$OPS_ROOT" --project-name "$COMPOSE_PROJECT_NAME" --env-file "$ENV_FILE")
STATE_FILE="$DEPLOY_STATE_DIR/deployment-$COMPOSE_PROJECT_NAME.env"
if [[ -f "$STATE_FILE" ]]; then
  # Compose parses this as data; do not source configuration as shell code.
  COMPOSE+=(--env-file "$STATE_FILE")
fi
COMPOSE+=(-f "$OPS_ROOT/compose.yaml")

upgrade_lock() {
  need flock
  mkdir -p -- "$DEPLOY_STATE_DIR"
  exec 9>"$DEPLOY_STATE_DIR/upgrade-$COMPOSE_PROJECT_NAME.lock"
  flock -n 9 || fail "Another upgrade or backup is running for this project"
}

prepare_backup_dir() {
  need realpath
  [[ -n "${BACKUP_DIR:-}" && "$BACKUP_DIR" == /* ]] || fail "BACKUP_DIR must be an explicitly selected absolute directory"
  [[ "$BACKUP_DIR" != *$'\n'* ]] || fail "Invalid backup directory"
  mkdir -p -- "$BACKUP_DIR"
  BACKUP_DIR=$(realpath -e -- "$BACKUP_DIR")
  case "$BACKUP_DIR" in
    /|/var|/var/backups|/home|/root|/tmp|/srv|/opt|"$OPS_ROOT") fail "Select a dedicated child directory for backups" ;;
  esac
  [[ -d "$BACKUP_DIR" && ! -L "$BACKUP_DIR" ]] || fail "Backup directory must resolve to a directory"
  if [[ -e "$BACKUP_DIR/.zhijiao-backup-root" ]]; then
    [[ -f "$BACKUP_DIR/.zhijiao-backup-root" && ! -L "$BACKUP_DIR/.zhijiao-backup-root" ]] || fail "Invalid backup directory marker"
    [[ "$(cat -- "$BACKUP_DIR/.zhijiao-backup-root")" == "zhijiao-encrypted-backups-v1" ]] || fail "Backup directory marker mismatch"
  else
    printf '%s\n' 'zhijiao-encrypted-backups-v1' >"$BACKUP_DIR/.zhijiao-backup-root"
  fi
}

backup_database() {
  need age
  need sha256sum
  prepare_backup_dir
  [[ -n "${AGE_RECIPIENT_FILE:-}" && -f "$AGE_RECIPIENT_FILE" ]] || fail "AGE_RECIPIENT_FILE must contain the separately managed public age recipient(s)"
  BACKUP_RETENTION_DAYS=${BACKUP_RETENTION_DAYS:-30}
  [[ "$BACKUP_RETENTION_DAYS" =~ ^[0-9]{1,4}$ ]] || fail "Invalid backup retention"
  (( 10#$BACKUP_RETENTION_DAYS >= 1 && 10#$BACKUP_RETENTION_DAYS <= 3650 )) || fail "Backup retention must be between 1 and 3650 days"
  local output partial
  output="$BACKUP_DIR/zhijiao-$(date -u +%Y%m%dT%H%M%SZ)-$$.dump.age"
  partial="$output.incomplete"
  [[ ! -e "$partial" && ! -e "$output" ]] || fail "Backup filename already exists"
  # Custom-format pg_dump takes one MVCC snapshot of the whole database.
  # Only encrypted bytes reach the host filesystem; password stays inside db.
  if ! "${COMPOSE[@]}" exec -T db sh -ec \
    'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; exec pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom --no-owner --no-acl' \
    | age --encrypt --recipients-file "$AGE_RECIPIENT_FILE" >"$partial"; then
    rm -f -- "$partial"
    fail "Backup failed; no retention cleanup or upgrade will proceed"
  fi
  [[ -s "$partial" ]] || fail "Encrypted backup was empty"
  mv -- "$partial" "$output"
  (cd -- "$BACKUP_DIR" && sha256sum -- "$(basename -- "$output")" >"$(basename -- "$output").sha256")
  # Only exact generated filenames directly inside the verified backup root.
  # No recursion, symlink traversal, database history deletion, or remote deletion.
  find "$BACKUP_DIR" -regextype posix-extended -maxdepth 1 -type f \
    -regex '.*/zhijiao-[0-9]{8}T[0-9]{6}Z-[0-9]+\.dump\.age(\.sha256)?' \
    -mmin "+$((10#$BACKUP_RETENTION_DAYS * 1440))" -delete
  printf 'Encrypted backup: %s\n' "$output"
}
