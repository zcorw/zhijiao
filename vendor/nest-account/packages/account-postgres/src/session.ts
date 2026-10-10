import { createHash } from 'node:crypto';
import session, { type SessionData } from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { Pool, PoolClient } from 'pg';
import type { Request } from 'express';
import type { AccountService, Account } from '@tts-workbench/account-core';
declare module 'express-session' {
  interface SessionData {
    accountId?: string;
    authVersion?: string;
    sessionId?: string;
    createdAt?: number;
    lastSeenAt?: number;
    userAgent?: string;
    absoluteExpiresAt?: number;
    idleMs?: number;
    csrfToken?: string;
    csrfIssuedAt?: number;
  }
}
const PgStore = connectPgSimple(session);
export const sessionDigest = (id: string) => createHash('sha256').update(id).digest('hex');
export class RevokedSessionError extends Error { constructor() { super('SESSION_REVOKED'); } }
/** Upstream hashed adapter, extended with transactional auth-version and durable revocation checks. */
export class HashedSessionStore extends PgStore {
  private readonly accountPool: Pool;
  private readonly idleMs: number;
  constructor(options: ConstructorParameters<typeof PgStore>[0] & { pool: Pool; idleMs?: number }) {
    super(options); this.accountPool = options.pool; this.idleMs = options.idleMs ?? 86400000;
  }
  private async transaction<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.accountPool.connect();
    try { await db.query('BEGIN'); const value = await work(db); await db.query('COMMIT'); return value; }
    catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
  private async lock(db: PoolClient, sid: string, accountId?: string): Promise<{ auth_version: string; status: string } | undefined> {
    const account = accountId ? (await db.query('SELECT auth_version::text,status FROM ac_accounts WHERE id=$1 FOR UPDATE', [accountId])).rows[0] : undefined;
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['session:' + sid]);
    return account;
  }
  override get(id: string, cb: (error: any, data?: SessionData | null) => void): void {
    const sid = sessionDigest(id);
    void this.accountPool.query(`SELECT s.sess FROM ac_sessions s LEFT JOIN ac_accounts a ON a.id::text=s.sess->>'accountId'
      WHERE s.sid=$1 AND s.expire>now() AND NOT EXISTS(SELECT 1 FROM ac_session_revocations r WHERE r.sid=s.sid)
      AND ((s.sess->>'accountId') IS NULL OR (a.status='active' AND a.auth_version::text=s.sess->>'authVersion'
        AND (s.sess->>'absoluteExpiresAt')::numeric > extract(epoch from now())*1000))`, [sid])
      .then(result => cb(null, result.rows[0]?.sess ?? null), error => cb(error));
  }
  override set(id: string, data: SessionData, cb?: (error?: any) => void): void {
    const sid = sessionDigest(id);
    void this.transaction(async db => {
      const account = await this.lock(db, sid, data.accountId);
      const revoked = (await db.query('SELECT 1 FROM ac_session_revocations WHERE sid=$1', [sid])).rowCount;
      if (revoked || (data.accountId && (!account || account.status !== 'active' || account.auth_version !== data.authVersion))) throw new RevokedSessionError();
      const now = Date.now();
      if (data.accountId && (!data.lastSeenAt || now - data.lastSeenAt >= (data.idleMs ?? this.idleMs))) throw new RevokedSessionError();
      const existing = (await db.query('SELECT expire FROM ac_sessions WHERE sid=$1', [sid])).rows[0];
      if (existing && new Date(existing.expire).getTime() <= now) throw new RevokedSessionError();
      const expiry = Math.min(data.cookie.expires ? new Date(data.cookie.expires).getTime() : now + this.idleMs,
        now + (data.idleMs ?? this.idleMs), data.absoluteExpiresAt ?? Infinity);
      if (expiry <= now) throw new RevokedSessionError();
      await db.query(`INSERT INTO ac_sessions(sid,sess,expire) VALUES($1,$2,$3)
        ON CONFLICT(sid) DO UPDATE SET sess=EXCLUDED.sess,expire=EXCLUDED.expire`, [sid, JSON.stringify({ ...data, lastSeenAt: now }), new Date(expiry)]);
    }).then(() => cb?.(), error => cb?.(error));
  }
  override destroy(id: string, cb?: (error?: any) => void): void {
    const sid = sessionDigest(id);
    void this.transaction(async db => {
      const row = (await db.query("SELECT sess->>'accountId' AS account_id FROM ac_sessions WHERE sid=$1", [sid])).rows[0];
      await this.lock(db, sid, row?.account_id);
      await db.query('INSERT INTO ac_session_revocations(sid) VALUES($1) ON CONFLICT DO NOTHING', [sid]);
      await db.query('DELETE FROM ac_sessions WHERE sid=$1', [sid]);
    }).then(() => cb?.(), error => cb?.(error));
  }
  override touch(id: string, data: SessionData, cb?: (error?: any) => void): void {
    const sid = sessionDigest(id);
    void this.transaction(async db => {
      const account = await this.lock(db, sid, data.accountId);
      if (data.accountId && (!account || account.status !== 'active' || account.auth_version !== data.authVersion)) return;
      const now = Date.now();
      const expiry = Math.min(now + (data.idleMs ?? this.idleMs), data.absoluteExpiresAt ?? Infinity);
      // UPDATE never creates a row; a late rolling response cannot revive a revoked session.
      await db.query(`UPDATE ac_sessions SET expire=$2,sess=jsonb_set(sess::jsonb,'{lastSeenAt}',to_jsonb($3::bigint))::json
        WHERE sid=$1 AND expire>now() AND NOT EXISTS(SELECT 1 FROM ac_session_revocations WHERE sid=$1)`, [sid, new Date(expiry), now]);
    }).then(() => cb?.(), error => cb?.(error));
  }
}
export function createAccountSession(options: { pool: Pool; secret: string; secure: boolean; idleMs?: number; cookieName?: string }) {
  if (options.secret.length < 32) throw new Error('Session secret must contain at least 32 characters');
  const store = new HashedSessionStore({ pool: options.pool, tableName: 'ac_sessions', createTableIfMissing: false,
    pruneSessionInterval: 86400, idleMs: options.idleMs });
  return { store, middleware: session({ store, secret: options.secret, name: options.cookieName ?? 'zj_session', resave: false,
    saveUninitialized: false, rolling: true, cookie: { httpOnly: true, sameSite: 'lax', secure: options.secure, path: '/', maxAge: options.idleMs ?? 86400000 } }) };
}
export async function resolveAccountSession(req: Request, accounts: AccountService, now = Date.now()): Promise<Account | undefined> {
  if (!req.session?.accountId) return undefined;
  const account = await accounts.getAccount(req.session.accountId);
  if (!req.session.absoluteExpiresAt || now >= req.session.absoluteExpiresAt || !account || account.status !== 'active') {
    await new Promise<void>((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve())); return undefined;
  }
  req.session.cookie.maxAge = Math.min(req.session.idleMs ?? req.session.cookie.originalMaxAge ?? 86400000, req.session.absoluteExpiresAt - now);
  return account;
}
