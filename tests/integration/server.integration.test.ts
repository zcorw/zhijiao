import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import session, { type SessionData } from 'express-session';
import type { Request } from 'express';
import { Pool } from 'pg';
import { AccountService, argon2Passwords } from '@tts-workbench/account-core';
import { PostgresAccountRepository } from '@tts-workbench/account-postgres';
import { HashedSessionStore, sessionDigest } from '@tts-workbench/account-postgres/session';
import type { CipherEnvelope, Operation, VaultDescriptor } from '@zhijiao/shared';
import { createApplication } from '../../apps/server/src/app.js';
import { migrate } from '../../apps/server/src/migrate.js';
import { resetPassword } from '../../apps/server/src/account-cli.js';
import { AuthService } from '../../apps/server/src/auth.js';
import { VaultService } from '../../apps/server/src/vaults.js';
import type { AppConfig } from '../../apps/server/src/config.js';
const databaseUrl = process.env.TEST_DATABASE_URL;
// Only a deliberately named disposable test database may be cleared by this suite.
if (databaseUrl && !/(test|ci)/i.test(new URL(databaseUrl).pathname)) throw new Error('TEST_DATABASE_URL must identify a disposable test database.');
const suite = databaseUrl ? describe : describe.skip;
const config: AppConfig = { database: { connectionString: databaseUrl }, origin: 'http://localhost:3000', secret: 'fictional-integration-session-secret-00000000',
  secure: false, idleMs: 60000, absoluteMs: 3600000, trustProxy: 0, port: 3000 };
function bundle(vaultId: string) {
  return { formatVersion: 1, vaultId, keyVersion: 1, kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: 600000, salt: randomBytes(16).toString('base64') },
    passphrase: { nonce: randomBytes(12).toString('base64'), ciphertext: randomBytes(48).toString('base64') },
    recovery: { nonce: randomBytes(12).toString('base64'), ciphertext: randomBytes(48).toString('base64') }, createdAt: new Date().toISOString() };
}
function cipher(vaultId: string, recordId = randomUUID(), revision = '1', lane: CipherEnvelope['lane'] = 'records'): CipherEnvelope {
  return { vaultId, recordId, revision, keyVersion: 1, formatVersion: 1, lane, tombstone: false, nonce: randomBytes(12).toString('base64'),
    ciphertext: randomBytes(48).toString('base64'), ...(lane === 'assets' ? { variant: 'thumb' as const } : {}) };
}
suite('server real PostgreSQL contracts', () => {
  let pool: Pool; let server: Awaited<ReturnType<typeof createApplication>>; let base: string;
  let accounts: AccountService; let ownerId: string; let store: HashedSessionStore;
  class Client {
    cookie = ''; csrf = '';
    async call(path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) {
      const response = await fetch(base + path, { method, headers: { cookie: this.cookie, origin: config.origin,
        'content-type': 'application/json', 'x-csrf-token': this.csrf, ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const cookie = response.headers.getSetCookie().find(value => value.startsWith('zj_session='));
      if (cookie) this.cookie = cookie.split(';')[0];
      return response;
    }
    async login(password = 'fictional-password-for-tests') {
      const challenge = await this.call('/auth/csrf'); this.csrf = (await challenge.json()).csrfToken;
      const prior = this.cookie; const response = await this.call('/auth/login', 'POST', { login: 'fictional', password });
      if (response.ok) this.csrf = (await response.json()).csrfToken;
      return { response, prior };
    }
    async vault() {
      const id = randomUUID(); const response = await this.call('/vaults', 'POST', { id, keyBundle: bundle(id) });
      expect(response.status).toBe(201); return await response.json() as VaultDescriptor;
    }
    async operation(vaultId: string, mutations: Operation['mutations'], operationId = randomUUID()) {
      return this.call(`/vaults/${vaultId}/operations`, 'POST', { operationId, mutations });
    }
  }
  const set = (sid: string, data: SessionData) => new Promise<void>((resolve, reject) => store.set(sid, data, error => error ? reject(error) : resolve()));
  const get = (sid: string) => new Promise<SessionData | null | undefined>((resolve, reject) => store.get(sid, (error, data) => error ? reject(error) : resolve(data)));
  const destroy = (sid: string) => new Promise<void>((resolve, reject) => store.destroy(sid, error => error ? reject(error) : resolve()));
  function sessionData(authVersion = '1'): SessionData {
    return { cookie: new session.Cookie({ maxAge: 60000 }), accountId: ownerId, authVersion, sessionId: randomUUID(), idleMs: 60000,
      createdAt: Date.now(), lastSeenAt: Date.now(), absoluteExpiresAt: Date.now() + 3600000 };
  }
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl });
    await migrate(pool); server = await createApplication(config, pool);
    await server.app.listen(0, '127.0.0.1'); base = (await server.app.getUrl()) + '/api';
    accounts = new AccountService({ repository: new PostgresAccountRepository(pool), passwords: argon2Passwords, randomId: randomUUID });
    store = new HashedSessionStore({ pool, tableName: 'ac_sessions', createTableIfMissing: false, pruneSessionInterval: false, idleMs: 60000 });
  });
  beforeEach(async () => {
    const db = await pool.connect();
    try {
      await db.query('BEGIN'); await db.query('SELECT id FROM ac_accounts FOR UPDATE');
      for (const table of ['zj_operations', 'zj_changelog', 'zj_current', 'zj_versions', 'zj_key_bundles', 'zj_vaults', 'zj_login_limits', 'ac_sessions', 'ac_session_revocations', 'ac_accounts'])
        await db.query(`DELETE FROM ${table}`);
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
    ownerId = (await accounts.createAccount({ login: 'fictional', displayName: 'Fictional Person', password: 'fictional-password-for-tests' })).id;
  });
  afterAll(async () => { store?.close(); await server?.close(); await pool?.end(); });
  it('runs idempotent controlled migrations and enforces a single account', async () => {
    await migrate(pool);
    await expect(accounts.createAccount({ login: 'second', displayName: 'Second', password: 'fictional-password-for-tests' })).rejects.toMatchObject({ code: 'ALREADY_EXISTS' });
    expect((await pool.query('SELECT count(*)::int AS n FROM ac_accounts')).rows[0].n).toBe(1);
  });
  it('returns private health responses and sets Secure cookies through an explicitly trusted HTTPS proxy', async () => {
    const response = await fetch(base + '/health'); expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    const secure = await createApplication({ ...config, origin: 'https://fictional.invalid', secure: true, trustProxy: 1, absoluteMs: 30000 }, pool);
    try {
      await secure.app.listen(0, '127.0.0.1'); const url = (await secure.app.getUrl()) + '/api';
      const csrf = await fetch(url + '/auth/csrf', { headers: { 'x-forwarded-proto': 'https' } });
      const token = (await csrf.json()).csrfToken;
      const login = await fetch(url + '/auth/login', { method: 'POST', headers: { 'x-forwarded-proto': 'https', origin: 'https://fictional.invalid',
        cookie: csrf.headers.getSetCookie()[0].split(';')[0], 'content-type': 'application/json', 'x-csrf-token': token },
        body: JSON.stringify({ login: 'fictional', password: 'fictional-password-for-tests' }) });
      expect(login.status).toBe(200); const cookie = login.headers.getSetCookie()[0]; expect(cookie).toContain('Secure'); expect(cookie).toContain('HttpOnly');
      const expires = cookie.match(/Expires=([^;]+)/)![1]; expect(new Date(expires).getTime() - Date.now()).toBeLessThanOrEqual(30000);
    } finally { await secure.close(); }
  });
  it('rotates SID, rejects public registration/unauthenticated access, Origin and CSRF, and logs out', async () => {
    const client = new Client(); expect((await client.call('/vaults')).status).toBe(401);
    const { response, prior } = await client.login(); expect(response.status).toBe(200); expect(client.cookie).not.toBe(prior);
    expect(response.headers.get('set-cookie')).toContain('HttpOnly'); expect(response.headers.get('set-cookie')).toContain('SameSite=Lax');
    const old = new Client(); old.cookie = prior; expect((await old.call('/auth/me')).status).toBe(401);
    expect((await client.call('/auth/register', 'POST', {})).status).toBe(404);
    expect((await client.call('/auth/logout', 'POST', {}, { origin: 'https://evil.invalid' })).status).toBe(403);
    expect((await client.call('/auth/logout', 'POST', {}, { 'x-csrf-token': '' })).status).toBe(403);
    expect((await client.call('/auth/logout', 'POST', {}, { 'x-csrf-token': 'é'.repeat(43) })).status).toBe(403);
    expect((await client.call('/auth/logout', 'POST')).status).toBe(204);
    expect((await client.call('/auth/me')).status).toBe(401);
  });
  it('accepts gzip JSON credentials in the login flow', async () => {
    const client = new Client(); const challenge = await client.call('/auth/csrf');
    const token = (await challenge.json()).csrfToken;
    const response = await fetch(base + '/auth/login', { method: 'POST', headers: {
      cookie: client.cookie, origin: config.origin, 'x-csrf-token': token,
      'content-type': 'application/json', 'content-encoding': 'gzip',
    }, body: gzipSync(JSON.stringify({ login: 'fictional', password: 'fictional-password-for-tests' })) });
    expect(response.status).toBe(200);
    expect((await response.json()).account.id).toBe(ownerId);
  });
  it('survives unauthenticated gzip requests with trailing bytes after the compressed frame', async () => {
    // The NUL ends gzip decoding early; later chunks must not reach an unguarded finished decoder.
    const payload = Buffer.concat([gzipSync('{"probe":"fictional"}'), Buffer.from([0]), Buffer.alloc(100 * 1024, 0x58)]);
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(base + '/auth/login', { method: 'POST', agent: false, headers: {
        origin: config.origin, 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': payload.length,
      } }, response => {
        response.on('error', reject); response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.setTimeout(5000, () => request.destroy(new Error('Compressed request did not finish')));
      request.end(payload);
    });
    expect(status).toBe(403);
    // Decoder errors can arrive after the response; allow those callbacks to run before checking liveness.
    await delay(200);
    const health = await fetch(base + '/health'); expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });
  });
  it('lists sessions and persistently revokes single/other sessions', async () => {
    const one = new Client(); const two = new Client(); const three = new Client(); await one.login(); await two.login(); await three.login();
    const list = await (await one.call('/auth/sessions')).json(); expect(list).toHaveLength(3);
    const other = list.find((entry: { current: boolean }) => !entry.current);
    expect((await one.call('/auth/sessions/' + other.id, 'DELETE')).status).toBe(204);
    expect((await one.call('/auth/sessions/revoke-others', 'POST')).status).toBe(204);
    expect((await one.call('/auth/me')).status).toBe(200); expect((await two.call('/auth/me')).status).toBe(401); expect((await three.call('/auth/me')).status).toBe(401);
    expect((await pool.query('SELECT count(*)::int n FROM ac_session_revocations')).rows[0].n).toBeGreaterThanOrEqual(2);
  });
  it('authenticates analysis status and protects analysis submission with Origin and CSRF', async () => {
    const client = new Client();
    expect((await client.call('/analysis/status')).status).toBe(401);
    await client.login();
    const status = await client.call('/analysis/status');
    expect(status.status).toBe(200); expect(status.headers.get('cache-control')).toBe('no-store');
    expect(await status.json()).toEqual({ available: false });
    const input = { title: '虚构交往', content: '我与小岚见面。' };
    expect((await client.call('/analysis/interaction', 'POST', input, { origin: 'https://other.invalid' })).status).toBe(403);
    expect((await client.call('/analysis/interaction', 'POST', input, { 'x-csrf-token': '' })).status).toBe(403);
    expect((await client.call('/analysis/interaction', 'POST', { ...input, currentUser: 'supplied' })).status).toBe(400);
    const unavailable = await client.call('/analysis/interaction', 'POST', input);
    expect(unavailable.status).toBe(503); expect(await unavailable.json()).toEqual({ code: 'AI_NOT_CONFIGURED' });
  });
  it('persists SID digests and never revives a destroyed SID despite racing/late saves', async () => {
    for (let n = 0; n < 8; n++) {
      const sid = randomUUID(); const data = sessionData(); await set(sid, data);
      const seconds = Number((await pool.query('SELECT extract(epoch FROM expire-now()) AS seconds FROM ac_sessions WHERE sid=$1', [sessionDigest(sid)])).rows[0].seconds);
      expect(seconds).toBeGreaterThan(55); expect(seconds).toBeLessThanOrEqual(60);
      expect((await pool.query('SELECT sid FROM ac_sessions WHERE sid=$1', [sid])).rowCount).toBe(0);
      expect((await pool.query('SELECT sid FROM ac_sessions WHERE sid=$1', [sessionDigest(sid)])).rowCount).toBe(1);
      await Promise.allSettled([destroy(sid), set(sid, data)]);
      expect(await get(sid)).toBeNull(); await expect(set(sid, data)).rejects.toThrow('SESSION_REVOKED');
    }
  });
  it('uses persisted idle and absolute deadlines, including exact expiry rejection', async () => {
    const sid = randomUUID(); const data = sessionData(); data.absoluteExpiresAt = Date.now() + 10000; await set(sid, data);
    const remaining = Number((await pool.query('SELECT extract(epoch FROM expire-now()) AS seconds FROM ac_sessions WHERE sid=$1', [sessionDigest(sid)])).rows[0].seconds);
    expect(remaining).toBeGreaterThan(5); expect(remaining).toBeLessThanOrEqual(10);
    await pool.query('UPDATE ac_sessions SET expire=now() WHERE sid=$1', [sessionDigest(sid)]); expect(await get(sid)).toBeNull();
    await expect(set(sid, data)).rejects.toThrow('SESSION_REVOKED');
    const idleExpired = sessionData(); idleExpired.lastSeenAt = Date.now() - 60000; await expect(set(randomUUID(), idleExpired)).rejects.toThrow('SESSION_REVOKED');
    const expired = sessionData(); expired.absoluteExpiresAt = Date.now(); await expect(set(randomUUID(), expired)).rejects.toThrow('SESSION_REVOKED');
  });
  it('invalidates existing/racing sessions on password reset and preserves independent key bundles', async () => {
    const client = new Client(); await client.login(); const vault = await client.vault(); const sid = randomUUID(); const data = sessionData(); await set(sid, data);
    await Promise.allSettled([resetPassword(pool, 'new-fictional-test-password'), set(sid, data)]);
    expect(await get(sid)).toBeNull(); await expect(set(randomUUID(), data)).rejects.toThrow('SESSION_REVOKED');
    expect((await client.call('/auth/me')).status).toBe(401);
    expect((await pool.query('SELECT key_bundle FROM zj_vaults WHERE id=$1', [vault.id])).rows[0].key_bundle).toEqual(vault.keyBundle);
    const current = new Client(); expect((await current.login('new-fictional-test-password')).response.status).toBe(200);
    const stale = new Client(); expect((await stale.login()).response.status).toBe(401);
  });
  it('rejects a credential verification that overlaps password reset', async () => {
    let verified!: () => void; let proceed!: () => void;
    const verificationStarted = new Promise<void>(resolve => { verified = resolve; });
    const barrier = new Promise<void>(resolve => { proceed = resolve; });
    const accountService = new AccountService({ repository: new PostgresAccountRepository(pool), randomId: randomUUID,
      passwords: { hash: argon2Passwords.hash, verify: async (hash, password) => { const valid = await argon2Passwords.verify(hash, password); verified(); await barrier; return valid; } } });
    const auth = new AuthService(pool, config, accountService);
    const pending = auth.login({ ip: '127.0.0.1' } as Request, { login: 'fictional', password: 'fictional-password-for-tests' });
    await verificationStarted; await resetPassword(pool, 'new-fictional-test-password'); proceed();
    await expect(pending).rejects.toThrow();
    expect((await pool.query('SELECT count(*)::int n FROM ac_sessions')).rows[0].n).toBe(0);
  });
  it('revokes a pending login when revoking other sessions while retaining the current session', async () => {
    const client = new Client(); await client.login();
    let verified!: () => void; let proceed!: () => void;
    const started = new Promise<void>(resolve => { verified = resolve; }); const barrier = new Promise<void>(resolve => { proceed = resolve; });
    const accountService = new AccountService({ repository: new PostgresAccountRepository(pool), randomId: randomUUID,
      passwords: { hash: argon2Passwords.hash, verify: async (hash, password) => { const valid = await argon2Passwords.verify(hash, password); verified(); await barrier; return valid; } } });
    const auth = new AuthService(pool, config, accountService);
    const pending = auth.login({ ip: '127.0.0.1' } as Request, { login: 'fictional', password: 'fictional-password-for-tests' });
    await started; expect((await client.call('/auth/sessions/revoke-others', 'POST')).status).toBe(204); proceed();
    await expect(pending).rejects.toThrow(); expect((await client.call('/auth/me')).status).toBe(200);
    expect((await pool.query('SELECT count(*)::int n FROM ac_sessions WHERE sess->>\'accountId\'=$1', [ownerId])).rows[0].n).toBe(1);
  });
  it('serializes competing CAS batches, preserves immutable snapshots, and returns idempotent results', async () => {
    const client = new Client(); await client.login(); const vault = await client.vault(); const first = cipher(vault.id); const second = { ...first, ciphertext: randomBytes(48).toString('base64') };
    const results = await Promise.all([client.operation(vault.id, [{ expectedRevision: '0', envelope: first }]), client.operation(vault.id, [{ expectedRevision: '0', envelope: second }])]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    const snapshot = await (await client.call(`/vaults/${vault.id}/changes?lane=records&limit=1`)).json(); expect(snapshot.highWatermark).toBe('1');
    const original = snapshot.envelopes[0]; const operationId = randomUUID(); const next = { ...original, revision: '2', ciphertext: randomBytes(48).toString('base64') };
    const result = await (await client.operation(vault.id, [{ expectedRevision: '1', envelope: next }], operationId)).json();
    const retry = await (await client.operation(vault.id, [{ expectedRevision: '1', envelope: next }], operationId)).json(); expect(retry).toEqual(result);
    expect((await client.operation(vault.id, [{ expectedRevision: '1', envelope: { ...next, tombstone: true } }], operationId)).status).toBe(409);
    const fixed = await (await client.call(`/vaults/${vault.id}/changes?lane=records&until=1`)).json(); expect(fixed.envelopes).toEqual([original]);
    expect(await (await client.call(`/vaults/${vault.id}/records/${first.recordId}/history`)).json()).toHaveLength(2);
    const rollbackRecord = cipher(vault.id);
    expect((await client.operation(vault.id, [{ expectedRevision: '0', envelope: rollbackRecord }, { expectedRevision: '0', envelope: cipher(vault.id, first.recordId) }])).status).toBe(409);
    expect((await pool.query('SELECT 1 FROM zj_current WHERE record_id=$1', [rollbackRecord.recordId])).rowCount).toBe(0);
  });
  it('atomically writes directory with records, keeps lane cursor boundaries, and prevents offline tombstone revival', async () => {
    const client = new Client(); await client.login(); const vault = await client.vault(); const directory = cipher(vault.id, randomUUID(), '1', 'directory'); const record = cipher(vault.id);
    expect((await client.operation(vault.id, [{ expectedRevision: '0', envelope: directory }, { expectedRevision: '0', envelope: record }])).status).toBe(201);
    const page = await (await client.call(`/vaults/${vault.id}/changes?lane=directory`)).json(); expect(page.envelopes).toEqual([directory]); expect(page.after).toBe('2'); expect(page.hasMore).toBe(false);
    const deleted = { ...record, revision: '2', tombstone: true };
    expect((await client.operation(vault.id, [{ expectedRevision: '1', envelope: deleted }])).status).toBe(201);
    expect((await client.operation(vault.id, [{ expectedRevision: '1', envelope: { ...record, revision: '2' } }])).status).toBe(409);
    expect((await client.operation(vault.id, [{ expectedRevision: '2', envelope: { ...record, revision: '3' } }])).status).toBe(201);
    expect(await (await client.call(`/vaults/${vault.id}/records/${record.recordId}/history`)).json()).toHaveLength(3);
  });
  it('enforces every vault route ownership, validates bundle bounds, and covers all asset/key-bundle versions', async () => {
    const client = new Client(); await client.login(); const vault = await client.vault(); const asset = cipher(vault.id, randomUUID(), '1', 'assets');
    await expect(new VaultService(pool).get(vault.id, randomUUID())).rejects.toThrow();
    await client.operation(vault.id, [{ expectedRevision: '0', envelope: asset }]); await client.operation(vault.id, [{ expectedRevision: '1', envelope: { ...asset, revision: '2' } }]);
    expect(await (await client.call(`/vaults/${vault.id}/assets`)).json()).toHaveLength(2);
    expect(await (await client.call(`/vaults/${vault.id}/assets/${asset.recordId}?revision=1`)).json()).toEqual(asset);
    expect((await client.call(`/vaults/${vault.id}/changes?lane=records`)).status).toBe(200);
    const replacement = bundle(vault.id); replacement.kdf.iterations = 599999;
    expect((await client.call(`/vaults/${vault.id}/key-bundle`, 'PUT', { expectedRevision: '1', keyBundle: replacement })).status).toBe(400);
    replacement.kdf.iterations = 600000; expect((await client.call(`/vaults/${vault.id}/key-bundle`, 'PUT', { expectedRevision: '1', keyBundle: replacement })).status).toBe(200);
    expect(await (await client.call(`/vaults/${vault.id}/key-bundles`)).json()).toHaveLength(2);
    const foreignId = randomUUID();
    for (const path of [`/vaults/${foreignId}`, `/vaults/${foreignId}/changes?lane=directory`, `/vaults/${foreignId}/assets`, `/vaults/${foreignId}/assets/${asset.recordId}?revision=1`, `/vaults/${foreignId}/key-bundles`, `/vaults/${foreignId}/records/${asset.recordId}/history`])
      expect((await client.call(path)).status).toBe(404);
    expect((await client.call(`/vaults/${foreignId}/key-bundle`, 'PUT', { expectedRevision: '1', keyBundle: bundle(foreignId) })).status).toBe(404);
    expect((await client.operation(foreignId, [{ expectedRevision: '0', envelope: cipher(foreignId) }])).status).toBe(404);
    const unknownRecord = randomUUID(); expect((await client.call(`/vaults/${vault.id}/assets/${unknownRecord}?revision=1`)).status).toBe(404);
  });
  it('rejects disabled accounts and persistently rate-limits credential attempts', async () => {
    const client = new Client(); await client.login(); await accounts.disableAccount(ownerId);
    expect((await client.call('/auth/me')).status).toBe(401);
    const attempts = new Client(); let response!: Response;
    for (let n = 0; n < 11; n++) response = (await attempts.login('fictional-wrong-password')).response;
    expect(response.status).toBe(429);
  });
  it('retains prior encrypted keys on rotation and rejects stale-device key-version writes', async () => {
    const client = new Client(); await client.login(); const vault = await client.vault(); const first = cipher(vault.id); const opId = randomUUID();
    const original = await (await client.operation(vault.id, [{ expectedRevision: '0', envelope: first }], opId)).json();
    const rotated = { ...bundle(vault.id), keyVersion: 2, previousKeys: [{ keyVersion: 1, nonce: randomBytes(12).toString('base64'), ciphertext: randomBytes(48).toString('base64') }] };
    expect((await client.call(`/vaults/${vault.id}/key-bundle`, 'PUT', { expectedRevision: '1', keyBundle: { ...rotated, previousKeys: [] } })).status).toBe(400);
    expect((await client.call(`/vaults/${vault.id}/key-bundle`, 'PUT', { expectedRevision: '1', keyBundle: rotated })).status).toBe(200);
    expect(await (await client.operation(vault.id, [{ expectedRevision: '0', envelope: first }], opId)).json()).toEqual(original);
    const stale = await client.operation(vault.id, [{ expectedRevision: '1', envelope: { ...first, revision: '2' } }]);
    expect(stale.status).toBe(409); expect(await stale.json()).toMatchObject({ code: 'KEY_VERSION_CONFLICT', keyVersion: 2, keyBundleRevision: '2' });
    expect((await client.operation(vault.id, [{ expectedRevision: '1', envelope: { ...first, revision: '2', keyVersion: 2 } }])).status).toBe(201);
    expect(await (await client.call(`/vaults/${vault.id}/records/${first.recordId}/history`)).json()).toHaveLength(2);
    expect((await client.call(`/vaults/${vault.id}/key-bundle`, 'PUT', { expectedRevision: '2', keyBundle: bundle(vault.id) })).status).toBe(400);
  });
  it('pages a fixed high-watermark through immutable versions while new edits commit', async () => {
    const client = new Client(); await client.login(); const vault = await client.vault();
    const first = cipher(vault.id); const second = cipher(vault.id); const directory = cipher(vault.id, randomUUID(), '1', 'directory');
    await client.operation(vault.id, [{ expectedRevision: '0', envelope: first }, { expectedRevision: '0', envelope: second }, { expectedRevision: '0', envelope: directory }]);
    const page1 = await (await client.call(`/vaults/${vault.id}/changes?lane=records&limit=1`)).json();
    expect(page1).toMatchObject({ after: '1', highWatermark: '3', hasMore: true, envelopes: [first] });
    await client.operation(vault.id, [{ expectedRevision: '1', envelope: { ...second, revision: '2' } }]);
    const page2 = await (await client.call(`/vaults/${vault.id}/changes?lane=records&limit=1&after=${page1.after}&until=${page1.highWatermark}`)).json();
    expect(page2).toMatchObject({ after: '3', highWatermark: '3', hasMore: false, envelopes: [second] });
    const incremental = await (await client.call(`/vaults/${vault.id}/changes?lane=records&after=3`)).json();
    expect(incremental.envelopes).toHaveLength(1); expect(incremental.envelopes[0].revision).toBe('2');
    expect((await client.call(`/vaults/${vault.id}/changes?lane=records&until=9223372036854775807`)).status).toBe(400);
    expect((await client.call(`/vaults/${vault.id}/changes?lane=records&after=9223372036854775808`)).status).toBe(400);
  });
});
