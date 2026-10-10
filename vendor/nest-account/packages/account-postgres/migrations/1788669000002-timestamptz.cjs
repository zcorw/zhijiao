exports.up = pgm => {
  // Legacy timestamp-without-zone rows cannot promise a consistent instant across hosts.
  pgm.sql('INSERT INTO ac_session_revocations(sid) SELECT sid FROM ac_sessions ON CONFLICT DO NOTHING');
  pgm.sql('DELETE FROM ac_sessions');
  pgm.sql("ALTER TABLE ac_sessions ALTER COLUMN expire TYPE timestamptz USING expire AT TIME ZONE 'UTC'");
};
exports.down = () => { throw new Error('Session expiry migration is irreversible; restore a pre-upgrade backup for rollback.'); };
