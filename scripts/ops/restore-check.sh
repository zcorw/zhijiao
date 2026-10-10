#!/usr/bin/env bash
# Restores ONLY to an isolated, initially empty PostgreSQL Compose project.
# Leaves that project stopped from external application access for manual checks.
set -Eeuo pipefail
[[ -n "${RESTORE_PROJECT:-}" && "$RESTORE_PROJECT" =~ ^zhijiao-restore-[a-z0-9][a-z0-9_-]{0,35}$ ]] || { printf 'Set RESTORE_PROJECT=zhijiao-restore-<unique rehearsal id>\n' >&2; exit 1; }
export COMPOSE_PROJECT_NAME="$RESTORE_PROJECT"
source "$(dirname -- "${BASH_SOURCE[0]}")/common.sh"
[[ $# == 1 && -f "$1" ]] || fail "Usage: bash scripts/ops/restore-check.sh /absolute/path/backup.dump.age"
[[ -n "${AGE_IDENTITY_FILE:-}" && -f "$AGE_IDENTITY_FILE" ]] || fail "AGE_IDENTITY_FILE must point to the independently held backup identity"
need age
need sha256sum
need realpath
upgrade_lock
backup_file=$(realpath -e -- "$1")
[[ -f "$backup_file.sha256" ]] || fail "Ciphertext checksum sidecar is required"
read -r checksum checksum_name <"$backup_file.sha256"
# GNU sha256sum uses a leading '*' for binary mode (the Windows default).
checksum_name=${checksum_name#\*}
[[ "$checksum" =~ ^[a-f0-9]{64}$ && "$checksum_name" == "$(basename -- "$backup_file")" ]] || fail "Invalid ciphertext checksum sidecar"
actual_checksum=$(sha256sum -- "$backup_file")
[[ "${actual_checksum%% *}" == "$checksum" ]] || fail "Ciphertext checksum mismatch"
# Verify every authentication tag before handing any plaintext to PostgreSQL.
age --decrypt --identity "$AGE_IDENTITY_FILE" "$backup_file" >/dev/null
"${COMPOSE[@]}" up --detach --no-build --wait --wait-timeout 90 db
table_count=$("${COMPOSE[@]}" exec -T db sh -ec \
  'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; exec psql --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --tuples-only --no-align --command="SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('\''pg_catalog'\'', '\''information_schema'\'');"')
[[ "$table_count" == "0" ]] || fail "Restore target is not empty; no data was overwritten"
# pg_restore uses a single transaction; any pipeline failure fails the rehearsal.
age --decrypt --identity "$AGE_IDENTITY_FILE" "$backup_file" \
  | "${COMPOSE[@]}" exec -T db sh -ec \
    'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; exec pg_restore --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --no-owner --no-acl --single-transaction --exit-on-error'
printf 'Restored into isolated project %s; application was not started.\n' "$RESTORE_PROJECT"
printf 'Next: invalidate restored sessions, verify account/vault/history/assets and perform a clean-device unlock. See docs/operations.md.\n'
