#!/usr/bin/env bash
# Run once on the target host; never prints generated server secrets.
set -Eeuo pipefail
umask 077
secret_dir=${1:-.local/secrets}
command -v openssl >/dev/null 2>&1 || { printf 'openssl is required\n' >&2; exit 1; }
mkdir -p -- "$secret_dir"
secret_dir=$(cd -- "$secret_dir" && pwd -P)
[[ ! -e "$secret_dir/db-password" && ! -e "$secret_dir/session-secret" ]] || { printf 'Refusing to replace an existing secret\n' >&2; exit 1; }
case "$secret_dir" in
  /|/var|/var/backups|/home|/root|/tmp|/srv|/opt|/etc) printf 'Select a dedicated secrets directory\n' >&2; exit 1 ;;
esac
[[ -z "$(find "$secret_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]] || { printf 'Select an empty, dedicated secrets directory\n' >&2; exit 1; }
chmod 700 -- "$secret_dir"
# Windows OpenSSL may emit CRLF; normalize so initdb, file_env and _FILE
# consumers all receive the same password bytes, including under Git Bash.
openssl rand -hex 32 | tr -d '\r\n' >"$secret_dir/db-password"
printf '\n' >>"$secret_dir/db-password"
openssl rand -hex 48 | tr -d '\r\n' >"$secret_dir/session-secret"
printf '\n' >>"$secret_dir/session-secret"
# Compose file-backed secrets are bind mounts: uid/mode remapping is not portable.
# The host's parent directory is 0700; read-only secret mounts are readable by node.
chmod 444 -- "$secret_dir/db-password" "$secret_dir/session-secret"
printf 'Created secret files in %s. Values were not printed.\n' "$secret_dir"
