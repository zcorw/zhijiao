import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { Module, Global, Controller, Get, Inject, Catch, HttpException, ServiceUnavailableException, type ExceptionFilter, type ArgumentsHost } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import express from 'express';
import helmet from 'helmet';
import { Pool } from 'pg';
import { AccountModule, argon2Passwords } from '@tts-workbench/account-core';
import { PostgresAccountRepository } from '@tts-workbench/account-postgres';
import { createAccountSession } from '@tts-workbench/account-postgres/session';
import { DATABASE, CONFIG } from './database.js';
import { AuthController, AuthService, AuthGuard, csrfMiddleware } from './auth.js';
import { VaultController, VaultService } from './vaults.js';
import type { AppConfig } from './config.js';
@Catch()
class PrivateErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse();
    if (error instanceof HttpException) return response.status(error.getStatus()).json(error.getResponse());
    const status = (error as { status?: number })?.status === 413 ? 413 : 500;
    return response.status(status).json({ code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR' });
  }
}
@Controller('health')
class HealthController {
  constructor(@Inject(DATABASE) private readonly pool: Pool) {}
  @Get() async health() {
    try { if (!(await this.pool.query('SELECT version FROM zj_schema WHERE version=1')).rowCount) throw new Error('Schema unavailable'); }
    catch { throw new ServiceUnavailableException({ status: 'unavailable' }); }
    return { status: 'ok' };
  }
}
export async function createApplication(config: AppConfig, pool: Pool): Promise<{ app: NestExpressApplication; close: () => Promise<void> }> {
  @Global() @Module({ providers: [{ provide: CONFIG, useValue: config }, { provide: DATABASE, useValue: pool }], exports: [CONFIG, DATABASE] })
  class InfrastructureModule {}
  @Module({ imports: [InfrastructureModule, AccountModule.registerAsync({ inject: [DATABASE], useFactory: (database: Pool) => ({
    repository: new PostgresAccountRepository(database), passwords: argon2Passwords, randomId: randomUUID,
  }) })], controllers: [AuthController, VaultController, HealthController], providers: [AuthService, AuthGuard, VaultService] })
  class ApplicationModule {}
  const app = await NestFactory.create<NestExpressApplication>(ApplicationModule, { logger: false, bodyParser: false });
  app.setGlobalPrefix('api'); app.useGlobalFilters(new PrivateErrorFilter()); app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet({ referrerPolicy: { policy: 'no-referrer' }, contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'blob:', 'data:'],
    connectSrc: ["'self'"], fontSrc: ["'self'"], workerSrc: ["'self'"], objectSrc: ["'none'"], frameAncestors: ["'none'"],
    baseUri: ["'none'"], upgradeInsecureRequests: config.secure ? [] : null,
  } } }));
  app.use('/api', (_req: express.Request, res: express.Response, next: express.NextFunction) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', express.json({ limit: '16mb' }));
  const sessions = createAccountSession({ pool, secret: config.secret, secure: config.secure, idleMs: config.idleMs });
  app.use('/api', sessions.middleware, (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    if (req.session?.accountId && req.session.absoluteExpiresAt)
      req.session.cookie.maxAge = Math.max(0, Math.min(config.idleMs, req.session.absoluteExpiresAt - Date.now()));
    next();
  }, csrfMiddleware(config));
  const staticDir = resolve(config.staticDir ?? fileURLToPath(new URL('../../web/dist/', import.meta.url)));
  if (existsSync(resolve(staticDir, 'index.html'))) {
    const server = app.getHttpAdapter().getInstance();
    server.use(express.static(staticDir, { index: false, setHeaders: (res: express.Response, path: string) => {
      res.setHeader('Cache-Control', ['sw.js', 'index.html'].includes(basename(path)) ? 'no-cache' : 'public,max-age=3600');
    } }));
    server.get(/^(?!\/api(?:\/|$)).*/, (_req: express.Request, res: express.Response) => { res.set('Cache-Control', 'no-cache'); res.sendFile(resolve(staticDir, 'index.html')); });
  }
  await app.init();
  return { app, close: async () => { sessions.store.close(); await app.close(); } };
}
