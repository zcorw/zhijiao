function identifier(value:string):string{
  if(!/^[a-z][a-z0-9_]{0,47}$/.test(value))throw new Error('INVALID_SQL_IDENTIFIER');return value;
}
export function validateTablePrefix(value:string):string{
  if(!/^[a-z][a-z0-9_]{0,30}_$/.test(value))throw new Error('INVALID_TABLE_PREFIX');return value;
}
/** Execute within the host migration transaction. Existing tables are never renamed. */
export function vaultSchema(options:{tablePrefix?:string;ownerTable?:string;ownerColumn?:string}={}):string{
  const prefix=validateTablePrefix(options.tablePrefix??'ev_');
  const ownerReference=options.ownerTable?`REFERENCES ${identifier(options.ownerTable)}(${identifier(options.ownerColumn??'id')})`:'';
  return `
CREATE TABLE IF NOT EXISTS ${prefix}vaults (
  id uuid PRIMARY KEY, owner_id uuid NOT NULL ${ownerReference},
  key_bundle jsonb NOT NULL, key_bundle_revision bigint NOT NULL DEFAULT 1 CHECK(key_bundle_revision>0),
  cursor bigint NOT NULL DEFAULT 0 CHECK(cursor>=0), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ${prefix}key_bundles (
  vault_id uuid NOT NULL REFERENCES ${prefix}vaults(id), revision bigint NOT NULL, bundle jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(vault_id,revision));
CREATE TABLE IF NOT EXISTS ${prefix}versions (
  vault_id uuid NOT NULL REFERENCES ${prefix}vaults(id), record_id uuid NOT NULL, revision bigint NOT NULL CHECK(revision>0),
  key_version integer NOT NULL, format_version integer NOT NULL, lane text NOT NULL CHECK(lane IN('directory','records','assets')),
  tombstone boolean NOT NULL, variant text CHECK(variant IN('main','thumb')), nonce text NOT NULL,
  ciphertext bytea NOT NULL, cursor bigint NOT NULL CHECK(cursor>0), created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(vault_id,record_id,revision), UNIQUE(vault_id,cursor));
CREATE TABLE IF NOT EXISTS ${prefix}current (
  vault_id uuid NOT NULL,record_id uuid NOT NULL,revision bigint NOT NULL,
  PRIMARY KEY(vault_id,record_id), FOREIGN KEY(vault_id,record_id,revision) REFERENCES ${prefix}versions(vault_id,record_id,revision));
CREATE TABLE IF NOT EXISTS ${prefix}changelog (
  vault_id uuid NOT NULL,cursor bigint NOT NULL,record_id uuid NOT NULL,revision bigint NOT NULL,
  PRIMARY KEY(vault_id,cursor), FOREIGN KEY(vault_id,record_id,revision) REFERENCES ${prefix}versions(vault_id,record_id,revision));
CREATE TABLE IF NOT EXISTS ${prefix}operations (
  vault_id uuid NOT NULL REFERENCES ${prefix}vaults(id),operation_id uuid NOT NULL,request_hash text NOT NULL,result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(vault_id,operation_id));
CREATE INDEX IF NOT EXISTS ${prefix}versions_lane_cursor ON ${prefix}versions(vault_id,lane,cursor);
`;
}
