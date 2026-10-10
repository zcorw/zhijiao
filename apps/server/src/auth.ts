import { randomBytes, randomUUID, timingSafeEqual, createHmac } from 'node:crypto';
import { Body, Controller, Delete, Get, Post, Param, Req, Res, HttpCode, Injectable, Inject, UnauthorizedException, ForbiddenException, HttpException, UseGuards, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { AccountService, AccountError, credentialsSchema, type Account } from '@tts-workbench/account-core';
import { resolveAccountSession, sessionDigest } from '@tts-workbench/account-postgres/session';
import { Pool } from 'pg';
import { opaqueId, type SessionSummary } from '@zhijiao/shared';
import { DATABASE, CONFIG, transaction } from './database.js';
import type { AppConfig } from './config.js';
export interface Principal { id: string; authVersion: string; sid: string }
export interface AuthRequest extends Request { principal: Principal; account: Account }
function sessionSave(req: Request): Promise<void> { return new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve())); }
export function csrfMiddleware(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (req.headers.origin !== config.origin) return res.status(403).json({ code: 'ORIGIN_REJECTED' });
    const given = req.get('x-csrf-token'); const expected = req.session?.csrfToken;
    if (!given || !expected || !/^[A-Za-z0-9_-]{43}$/.test(given) || given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected)))
      return res.status(403).json({ code: 'CSRF_REJECTED' });
    next();
  };
}
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(DATABASE) private readonly pool: Pool, @Inject(AccountService) private readonly accounts: AccountService) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const account = await resolveAccountSession(req, this.accounts);
    if (!account || !req.session.authVersion) throw new UnauthorizedException({ code: 'AUTH_REQUIRED' });
    const sid = sessionDigest(req.sessionID);
    const valid = await this.pool.query(`SELECT 1 FROM ac_accounts a JOIN ac_sessions s ON s.sess->>'accountId'=a.id::text
      WHERE a.id=$1 AND a.status='active' AND a.auth_version::text=$2 AND s.sid=$3 AND s.expire>now()
      AND NOT EXISTS(SELECT 1 FROM ac_session_revocations WHERE sid=$3)`, [account.id, req.session.authVersion, sid]);
    if (!valid.rowCount) throw new UnauthorizedException({ code: 'AUTH_REQUIRED' });
    req.account = account; req.principal = { id: account.id, authVersion: req.session.authVersion, sid }; return true;
  }
}
@Injectable()
export class AuthService {
  constructor(@Inject(DATABASE) private readonly pool: Pool, @Inject(CONFIG) private readonly config: AppConfig, @Inject(AccountService) private readonly accounts: AccountService) {}
  async csrf(req: Request): Promise<{ csrfToken: string }> {
    req.session.csrfToken ??= randomBytes(32).toString('base64url'); req.session.csrfIssuedAt ??= Date.now();
    req.session.idleMs = this.config.idleMs; await sessionSave(req); return { csrfToken: req.session.csrfToken };
  }
  private async throttle(req: Request, login: string): Promise<void> {
    const keys = ['ip:' + (req.ip ?? 'unknown'), 'login:' + login].map(value => createHmac('sha256', this.config.secret).update(value).digest('hex'));
    for (const key of keys) {
      const result = await this.pool.query(`INSERT INTO zj_login_limits(key,window_start,attempts) VALUES($1,now(),1)
        ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN zj_login_limits.window_start<now()-interval '15 minutes' THEN 1 ELSE zj_login_limits.attempts+1 END,
        window_start=CASE WHEN zj_login_limits.window_start<now()-interval '15 minutes' THEN now() ELSE zj_login_limits.window_start END RETURNING attempts`, [key]);
      if (result.rows[0].attempts > 10) throw new HttpException({ code: 'LOGIN_RATE_LIMITED' }, 429);
    }
  }
  async login(req: Request, input: unknown): Promise<{ account: Account; csrfToken: string }> {
    const parsed = credentialsSchema.safeParse(input);
    await this.throttle(req, parsed.success ? parsed.data.login : '(invalid)');
    if (!parsed.success) throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS' });
    const snapshot = (await this.pool.query('SELECT password_hash,auth_version::text FROM ac_accounts WHERE login=$1', [parsed.data.login])).rows[0];
    let account: Account;
    try { account = await this.accounts.authenticateCredentials(parsed.data); }
    catch (error) { if (error instanceof AccountError) throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS' }); throw error; }
    // A password reset between credential verification and session issuance must invalidate this login.
    await transaction(this.pool, async db => {
      const current = (await db.query('SELECT password_hash,auth_version::text,status FROM ac_accounts WHERE id=$1 FOR UPDATE', [account.id])).rows[0];
      if (!snapshot || !current || current.status !== 'active' || current.password_hash !== snapshot.password_hash || current.auth_version !== snapshot.auth_version)
        throw new UnauthorizedException({ code: 'INVALID_CREDENTIALS' });
    });
    await new Promise<void>((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
    const now = Date.now();
    Object.assign(req.session, { accountId: account.id, authVersion: snapshot.auth_version, sessionId: randomUUID(), createdAt: now, lastSeenAt: now,
      userAgent: (req.get('user-agent') ?? '').slice(0, 200), absoluteExpiresAt: now + this.config.absoluteMs, idleMs: this.config.idleMs,
      csrfToken: randomBytes(32).toString('base64url'), csrfIssuedAt: now });
    req.session.cookie.maxAge = Math.min(this.config.idleMs, this.config.absoluteMs);
    try { await sessionSave(req); } catch { throw new UnauthorizedException({ code: 'SESSION_REVOKED' }); }
    return { account, csrfToken: req.session.csrfToken! };
  }
  async logout(req: Request): Promise<void> { await new Promise<void>((resolve, reject) => req.session.destroy(error => error ? reject(error) : resolve())); }
  async sessions(req: AuthRequest): Promise<SessionSummary[]> {
    const result = await this.pool.query(`SELECT sid,sess,expire FROM ac_sessions WHERE sess->>'accountId'=$1 AND sess->>'authVersion'=$2
      AND expire>now() AND NOT EXISTS(SELECT 1 FROM ac_session_revocations r WHERE r.sid=ac_sessions.sid) ORDER BY expire DESC`, [req.principal.id, req.principal.authVersion]);
    return result.rows.map(row => ({ id: row.sess.sessionId, current: row.sid === req.principal.sid,
      createdAt: new Date(row.sess.createdAt).toISOString(), lastSeenAt: new Date(row.sess.lastSeenAt).toISOString(),
      expiresAt: new Date(row.expire).toISOString(), userAgent: row.sess.userAgent ?? '' }));
  }
  async revoke(req: AuthRequest, id?: string): Promise<void> {
    if (id && !opaqueId.safeParse(id).success) throw new ForbiddenException({ code: 'SESSION_NOT_FOUND' });
    await transaction(this.pool, async db => {
      const current = (await db.query('SELECT auth_version::text FROM ac_accounts WHERE id=$1 FOR UPDATE', [req.principal.id])).rows[0];
      if (current?.auth_version !== req.principal.authVersion) throw new UnauthorizedException();
      const live = (await db.query('SELECT 1 FROM ac_sessions WHERE sid=$1 AND expire>now() AND NOT EXISTS(SELECT 1 FROM ac_session_revocations WHERE sid=$1)', [req.principal.sid])).rowCount;
      if (!live) throw new UnauthorizedException();
      const targets = await db.query(`SELECT sid FROM ac_sessions WHERE sess->>'accountId'=$1 AND ${id ? "sess->>'sessionId'=$2" : 'sid<>$2'}`, [req.principal.id, id ?? req.principal.sid]);
      for (const { sid } of targets.rows) {
        await db.query('INSERT INTO ac_session_revocations(sid) VALUES($1) ON CONFLICT DO NOTHING', [sid]);
        await db.query('DELETE FROM ac_sessions WHERE sid=$1', [sid]);
      }
      if (!id) {
        // Advance the epoch to also invalidate logins whose verification began before this action.
        const version = (await db.query('UPDATE ac_accounts SET auth_version=auth_version+1 WHERE id=$1 RETURNING auth_version::text', [req.principal.id])).rows[0].auth_version;
        await db.query("UPDATE ac_sessions SET sess=jsonb_set(sess::jsonb,'{authVersion}',to_jsonb($2::text))::json WHERE sid=$1", [req.principal.sid, version]);
        req.session.authVersion = version; req.principal.authVersion = version;
      }
    });
  }
}
@Controller('auth')
export class AuthController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  @Get('csrf') csrf(@Req() req: Request) { return this.auth.csrf(req); }
  @Post('login') @HttpCode(200) login(@Req() req: Request, @Body() body: unknown) { return this.auth.login(req, body); }
  @Get('me') @UseGuards(AuthGuard) me(@Req() req: AuthRequest) { return { account: req.account, csrfToken: req.session.csrfToken }; }
  @Post('logout') @HttpCode(204) async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req); res.clearCookie('zj_session', { httpOnly: true, sameSite: 'lax', path: '/' });
  }
  @Get('sessions') @UseGuards(AuthGuard) sessions(@Req() req: AuthRequest) { return this.auth.sessions(req); }
  @Delete('sessions/:id') @HttpCode(204) @UseGuards(AuthGuard) revoke(@Req() req: AuthRequest, @Param('id') id: string) { return this.auth.revoke(req, id); }
  @Post('sessions/revoke-others') @HttpCode(204) @UseGuards(AuthGuard) others(@Req() req: AuthRequest) { return this.auth.revoke(req); }
}
