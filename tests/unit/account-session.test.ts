import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import type { AccountService } from '@tts-workbench/account-core';
import { resolveAccountSession } from '../../vendor/nest-account/packages/account-postgres/src/session.js';
import { csrfMiddleware } from '../../apps/server/src/auth.js';
import type { AppConfig } from '../../apps/server/src/config.js';
const account = { id: 'test', login: 'test', displayName: 'Test', status: 'active' };
function request(idleMs: number | undefined, expiry: number, original = 86400000) {
  return { session: { accountId: 'test', absoluteExpiresAt: expiry, idleMs, cookie: { originalMaxAge: original, maxAge: original }, destroy: vi.fn(cb => cb()) } } as unknown as Request;
}
describe('upstream account session idle contract', () => {
  it('retains configured idleMs instead of resetting to one day', async () => {
    const req = request(60000, 1000000);
    await resolveAccountSession(req, { getAccount: async () => account } as unknown as AccountService, 1000);
    expect(req.session.cookie.maxAge).toBe(60000);
  });
  it('bounds rolling cookie by absolute expiry and falls back to original configured age', async () => {
    const req = request(undefined, 25000, 60000);
    await resolveAccountSession(req, { getAccount: async () => account } as unknown as AccountService, 1000);
    expect(req.session.cookie.maxAge).toBe(24000);
  });
  it('destroys at the exact expiry boundary', async () => {
    const req = request(60000, 1000);
    expect(await resolveAccountSession(req, { getAccount: async () => account } as unknown as AccountService, 1000)).toBeUndefined();
    expect(req.session.destroy).toHaveBeenCalledOnce();
  });
});
describe('CSRF input boundaries', () => {
  it('rejects same-character-length non-ASCII input without throwing', () => {
    const status = vi.fn().mockReturnThis(); const json = vi.fn(); const next = vi.fn();
    const req = { method: 'POST', headers: { origin: 'http://localhost:3000' }, session: { csrfToken: 'a'.repeat(43) }, get: () => 'é'.repeat(43) } as unknown as Request;
    csrfMiddleware({ origin: 'http://localhost:3000' } as AppConfig)(req, { status, json } as unknown as Response, next);
    expect(status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled();
  });
});
