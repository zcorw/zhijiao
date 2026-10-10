exports.up = pgm => {
  pgm.addColumns('ac_accounts', { auth_version: { type: 'bigint', notNull: true, default: 1 } });
  pgm.createTable('ac_session_revocations', { sid: { type: 'varchar', primaryKey: true }, revoked_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') } });
  pgm.sql('INSERT INTO ac_session_revocations(sid) SELECT sid FROM ac_sessions ON CONFLICT DO NOTHING');
  pgm.sql('DELETE FROM ac_sessions');
};
exports.down = () => { throw new Error('Auth-version migration is irreversible; restore a pre-upgrade backup for rollback.'); };
