export const applicationSchema = `
CREATE UNIQUE INDEX IF NOT EXISTS ac_single_account ON ac_accounts ((true));
CREATE TABLE IF NOT EXISTS zj_schema (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS zj_login_limits (key text PRIMARY KEY, window_start timestamptz NOT NULL, attempts integer NOT NULL);
CREATE TABLE IF NOT EXISTS zj_vaults (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL REFERENCES ac_accounts(id),
  key_bundle jsonb NOT NULL, key_bundle_revision bigint NOT NULL DEFAULT 1 CHECK(key_bundle_revision>0),
  cursor bigint NOT NULL DEFAULT 0 CHECK(cursor>=0), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS zj_key_bundles (
  vault_id uuid NOT NULL REFERENCES zj_vaults(id), revision bigint NOT NULL, bundle jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(vault_id,revision));
CREATE TABLE IF NOT EXISTS zj_versions (
  vault_id uuid NOT NULL REFERENCES zj_vaults(id), record_id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>0),
  key_version integer NOT NULL, format_version integer NOT NULL, lane text NOT NULL CHECK(lane IN('directory','records','assets')),
  tombstone boolean NOT NULL, variant text CHECK(variant IN('main','thumb')), nonce text NOT NULL,
  ciphertext bytea NOT NULL, cursor bigint NOT NULL CHECK(cursor>0), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(vault_id,record_id,revision), UNIQUE(vault_id,cursor));
CREATE TABLE IF NOT EXISTS zj_current (
  vault_id uuid NOT NULL,record_id uuid NOT NULL,revision bigint NOT NULL,
  PRIMARY KEY(vault_id,record_id), FOREIGN KEY(vault_id,record_id,revision) REFERENCES zj_versions(vault_id,record_id,revision));
CREATE TABLE IF NOT EXISTS zj_changelog (
  vault_id uuid NOT NULL,cursor bigint NOT NULL,record_id uuid NOT NULL,revision bigint NOT NULL,
  PRIMARY KEY(vault_id,cursor), FOREIGN KEY(vault_id,record_id,revision) REFERENCES zj_versions(vault_id,record_id,revision));
CREATE TABLE IF NOT EXISTS zj_operations (
  vault_id uuid NOT NULL REFERENCES zj_vaults(id),operation_id uuid NOT NULL,request_hash text NOT NULL,result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(vault_id,operation_id));
CREATE INDEX IF NOT EXISTS zj_versions_lane_cursor ON zj_versions(vault_id,lane,cursor);
INSERT INTO zj_schema(version) VALUES(1) ON CONFLICT DO NOTHING;
`;
