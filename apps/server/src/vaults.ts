import { createHash } from 'node:crypto';
import { Body, Controller, Get, Post, Put, Param, Query, Req, Injectable, Inject, UseGuards, BadRequestException, NotFoundException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { Pool, type PoolClient } from 'pg';
import { z } from 'zod';
import { opaqueId, decimal, operationSchema, type CipherEnvelope, type OperationResult, type ChangePage, type VaultDescriptor } from '@zhijiao/shared';
import { AuthGuard, type AuthRequest, type Principal } from './auth.js';
import { DATABASE, transaction } from './database.js';
const b64 = (bytes: number) => z.string().refine(value => {
  const data = Buffer.from(value, 'base64'); return data.length === bytes && data.toString('base64') === value;
}, 'Invalid canonical base64');
const previousKeySchema = z.strictObject({ keyVersion: z.number().int().min(1).max(1000000), nonce: b64(12), ciphertext: b64(48) });
export const keyBundleSchema = z.strictObject({ formatVersion: z.literal(1), vaultId: opaqueId, keyVersion: z.number().int().min(1).max(1000000),
  kdf: z.strictObject({ name: z.literal('PBKDF2'), hash: z.literal('SHA-256'), iterations: z.number().int().min(600000).max(2000000), salt: b64(16) }),
  passphrase: z.strictObject({ nonce: b64(12), ciphertext: b64(48) }), recovery: z.strictObject({ nonce: b64(12), ciphertext: b64(48) }),
  previousKeys: z.array(previousKeySchema).max(1000).optional(), createdAt: z.iso.datetime() }).superRefine((bundle, context) => {
    const ids = new Set<number>();
    for (const old of bundle.previousKeys ?? []) {
      if (ids.has(old.keyVersion) || old.keyVersion >= bundle.keyVersion) context.addIssue({ code: 'custom', message: 'Invalid previous key version' });
      ids.add(old.keyVersion);
    }
  });
const projection = `v.vault_id AS "vaultId",v.record_id AS "recordId",v.revision::text,v.key_version AS "keyVersion",v.format_version AS "formatVersion",
  v.lane,v.tombstone,v.variant,v.nonce,v.ciphertext`;
function envelope(row: Record<string, any>): CipherEnvelope {
  const { ciphertext, variant, ...rest } = row;
  return { ...rest, ...(variant ? { variant } : {}), ciphertext: (ciphertext as Buffer).toString('base64') } as CipherEnvelope;
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value); if (!result.success) throw new BadRequestException({ code: 'INVALID_PAYLOAD' }); return result.data;
}
@Injectable()
export class VaultService {
  constructor(@Inject(DATABASE) private readonly pool: Pool) {}
  private async authenticated(db: PoolClient, principal: Principal): Promise<void> {
    const account = (await db.query('SELECT auth_version::text,status FROM ac_accounts WHERE id=$1 FOR UPDATE', [principal.id])).rows[0];
    const valid = (await db.query('SELECT 1 FROM ac_sessions WHERE sid=$1 AND expire>now() AND NOT EXISTS(SELECT 1 FROM ac_session_revocations WHERE sid=$1)', [principal.sid])).rowCount;
    if (!valid || account?.status !== 'active' || account.auth_version !== principal.authVersion) throw new UnauthorizedException({ code: 'AUTH_REQUIRED' });
  }
  async owned(id: string, ownerId: string, db: Pool | PoolClient = this.pool, lock = false): Promise<Record<string, any>> {
    parse(opaqueId, id);
    const row = (await db.query(`SELECT id,owner_id AS "ownerId",key_bundle AS "keyBundle",key_bundle_revision::text AS "keyBundleRevision",cursor::text
      FROM zj_vaults WHERE id=$1 AND owner_id=$2 ${lock ? 'FOR UPDATE' : ''}`, [id, ownerId])).rows[0];
    if (!row) throw new NotFoundException({ code: 'VAULT_NOT_FOUND' }); return row;
  }
  async list(ownerId: string): Promise<VaultDescriptor[]> {
    return (await this.pool.query('SELECT id,owner_id AS "ownerId",key_bundle AS "keyBundle",key_bundle_revision::text AS "keyBundleRevision" FROM zj_vaults WHERE owner_id=$1 ORDER BY created_at', [ownerId])).rows;
  }
  async get(id: string, ownerId: string) {
    const { cursor: _cursor, ...vault } = await this.owned(id, ownerId);
    return { ...vault, keyBundleHistory: await this.bundles(id, ownerId) };
  }
  async create(principal: Principal, value: unknown): Promise<VaultDescriptor> {
    const input = parse(z.strictObject({ id: opaqueId, keyBundle: keyBundleSchema }), value);
    if (input.id !== input.keyBundle.vaultId) throw new BadRequestException({ code: 'VAULT_MISMATCH' });
    return transaction(this.pool, async db => {
      await this.authenticated(db, principal);
      const existing = (await db.query('SELECT owner_id,key_bundle FROM zj_vaults WHERE id=$1', [input.id])).rows[0];
      if (existing) throw new ConflictException({ code: 'VAULT_EXISTS' });
      await db.query('INSERT INTO zj_vaults(id,owner_id,key_bundle) VALUES($1,$2,$3)', [input.id, principal.id, input.keyBundle]);
      await db.query('INSERT INTO zj_key_bundles(vault_id,revision,bundle) VALUES($1,1,$2)', [input.id, input.keyBundle]);
      return { id: input.id, ownerId: principal.id, keyBundle: input.keyBundle, keyBundleRevision: '1' };
    });
  }
  async bundles(id: string, ownerId: string): Promise<unknown[]> {
    await this.owned(id, ownerId);
    return (await this.pool.query('SELECT bundle FROM zj_key_bundles WHERE vault_id=$1 ORDER BY revision', [id])).rows.map(row => row.bundle);
  }
  async rewrap(id: string, principal: Principal, value: unknown): Promise<VaultDescriptor> {
    const input = parse(z.strictObject({ expectedRevision: decimal, keyBundle: keyBundleSchema }), value);
    if (id !== input.keyBundle.vaultId) throw new BadRequestException({ code: 'VAULT_MISMATCH' });
    return transaction(this.pool, async db => {
      await this.authenticated(db, principal); const current = await this.owned(id, principal.id, db, true);
      if (current.keyBundleRevision !== input.expectedRevision) throw new ConflictException({ code: 'KEY_BUNDLE_CONFLICT', current: current.keyBundle });
      if (input.keyBundle.keyVersion < current.keyBundle.keyVersion || input.keyBundle.keyVersion > current.keyBundle.keyVersion + 1)
        throw new BadRequestException({ code: 'INVALID_KEY_VERSION' });
      const needed = (await db.query('SELECT DISTINCT key_version FROM zj_versions WHERE vault_id=$1', [id])).rows.map(row => row.key_version as number);
      const included = new Set([input.keyBundle.keyVersion, ...(input.keyBundle.previousKeys ?? []).map(key => key.keyVersion)]);
      if (needed.some(version => !included.has(version))) throw new BadRequestException({ code: 'MISSING_PREVIOUS_KEY' });
      const revision = (BigInt(input.expectedRevision) + 1n).toString(); parse(decimal, revision);
      await db.query('UPDATE zj_vaults SET key_bundle=$2,key_bundle_revision=$3 WHERE id=$1', [id, input.keyBundle, revision]);
      await db.query('INSERT INTO zj_key_bundles(vault_id,revision,bundle) VALUES($1,$2,$3)', [id, revision, input.keyBundle]);
      return { id, ownerId: principal.id, keyBundle: input.keyBundle, keyBundleRevision: revision };
    });
  }
  async operate(id: string, principal: Principal, value: unknown): Promise<OperationResult> {
    const operation = parse(operationSchema, value); const ids = new Set<string>(); let bytes = 0;
    for (const { expectedRevision, envelope: e } of operation.mutations) {
      const data = Buffer.from(e.ciphertext, 'base64'); bytes += data.length;
      if (ids.has(e.recordId) || e.vaultId !== id || BigInt(e.revision) !== BigInt(expectedRevision) + 1n || data.length < 16 || data.toString('base64') !== e.ciphertext ||
        (e.lane === 'assets' ? !e.variant : Boolean(e.variant))) throw new BadRequestException({ code: 'INVALID_MUTATION' });
      ids.add(e.recordId);
    }
    if (bytes > 12000000) throw new BadRequestException({ code: 'OPERATION_TOO_LARGE' });
    const hash = createHash('sha256').update(JSON.stringify(operation)).digest('hex');
    return transaction(this.pool, async db => {
      await this.authenticated(db, principal); const vault = await this.owned(id, principal.id, db, true);
      const prior = (await db.query('SELECT request_hash,result FROM zj_operations WHERE vault_id=$1 AND operation_id=$2', [id, operation.operationId])).rows[0];
      if (prior) { if (prior.request_hash !== hash) throw new ConflictException({ code: 'OPERATION_MISMATCH' }); return prior.result; }
      if (operation.mutations.some(m => m.envelope.keyVersion !== vault.keyBundle.keyVersion))
        throw new ConflictException({ code: 'KEY_VERSION_CONFLICT', keyVersion: vault.keyBundle.keyVersion, keyBundleRevision: vault.keyBundleRevision });
      const rows = (await db.query(`SELECT ${projection} FROM zj_current c JOIN zj_versions v USING(vault_id,record_id,revision) WHERE c.vault_id=$1 AND c.record_id=ANY($2::uuid[])`, [id, [...ids]])).rows;
      const current = new Map<string, CipherEnvelope>(rows.map(row => { const e = envelope(row); return [e.recordId, e]; }));
      const conflicts = operation.mutations.filter(m => (current.get(m.envelope.recordId)?.revision ?? '0') !== m.expectedRevision);
      if (conflicts.length) throw new ConflictException({ code: 'REVISION_CONFLICT', current: conflicts.map(m => current.get(m.envelope.recordId)).filter(Boolean) });
      let cursor = BigInt(vault.cursor);
      for (const { envelope: e } of operation.mutations) {
        const previous = current.get(e.recordId);
        if (previous && (previous.lane !== e.lane || previous.variant !== e.variant)) throw new BadRequestException({ code: 'ROUTE_MISMATCH' });
        cursor += 1n; parse(decimal, cursor.toString());
        await db.query(`INSERT INTO zj_versions(vault_id,record_id,revision,key_version,format_version,lane,tombstone,variant,nonce,ciphertext,cursor)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [id, e.recordId, e.revision, e.keyVersion, e.formatVersion, e.lane, e.tombstone, e.variant ?? null, e.nonce, Buffer.from(e.ciphertext, 'base64'), cursor.toString()]);
        await db.query('INSERT INTO zj_current(vault_id,record_id,revision) VALUES($1,$2,$3) ON CONFLICT(vault_id,record_id) DO UPDATE SET revision=EXCLUDED.revision', [id, e.recordId, e.revision]);
        await db.query('INSERT INTO zj_changelog(vault_id,cursor,record_id,revision) VALUES($1,$2,$3,$4)', [id, cursor.toString(), e.recordId, e.revision]);
      }
      await db.query('UPDATE zj_vaults SET cursor=$2 WHERE id=$1', [id, cursor.toString()]);
      const result: OperationResult = { operationId: operation.operationId, envelopes: operation.mutations.map(m => m.envelope), cursor: cursor.toString() };
      await db.query('INSERT INTO zj_operations(vault_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4)', [id, operation.operationId, hash, result]); return result;
    });
  }
  async changes(id: string, ownerId: string, query: Record<string, unknown>): Promise<ChangePage> {
    const input = parse(z.strictObject({ lane: z.enum(['directory', 'records']), after: decimal.default('0'), until: decimal.optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }), query);
    const vault = await this.owned(id, ownerId); const until = input.until ?? vault.cursor;
    if (BigInt(input.after) > BigInt(until) || BigInt(until) > BigInt(vault.cursor)) throw new BadRequestException({ code: 'INVALID_CURSOR' });
    const rows = (await this.pool.query(`SELECT ${projection},v.cursor::text AS change_cursor FROM zj_changelog c JOIN zj_versions v USING(vault_id,record_id,revision)
      WHERE c.vault_id=$1 AND v.lane=$2 AND c.cursor>$3 AND c.cursor<=$4 ORDER BY c.cursor LIMIT $5`, [id, input.lane, input.after, until, input.limit + 1])).rows;
    const hasMore = rows.length > input.limit; const page = rows.slice(0, input.limit);
    return { envelopes: page.map(row => { const { change_cursor: _cursor, ...e } = row; return envelope(e); }),
      after: hasMore ? page[page.length - 1].change_cursor : until, highWatermark: until, hasMore };
  }
  async history(id: string, ownerId: string, recordId: string): Promise<CipherEnvelope[]> {
    await this.owned(id, ownerId); parse(opaqueId, recordId);
    return (await this.pool.query(`SELECT ${projection} FROM zj_versions v WHERE vault_id=$1 AND record_id=$2 AND lane IN('records','directory') ORDER BY revision`, [id, recordId])).rows.map(envelope);
  }
  async assets(id: string, ownerId: string) {
    await this.owned(id, ownerId);
    return (await this.pool.query('SELECT record_id AS "recordId",revision::text,variant FROM zj_versions WHERE vault_id=$1 AND lane=\'assets\' ORDER BY cursor', [id])).rows;
  }
  async asset(id: string, ownerId: string, recordId: string, revision: unknown): Promise<CipherEnvelope> {
    await this.owned(id, ownerId); parse(opaqueId, recordId); const version = parse(decimal, revision);
    const row = (await this.pool.query(`SELECT ${projection} FROM zj_versions v WHERE vault_id=$1 AND record_id=$2 AND revision=$3 AND lane='assets'`, [id, recordId, version])).rows[0];
    if (!row) throw new NotFoundException({ code: 'ASSET_NOT_FOUND' }); return envelope(row);
  }
}
@Controller('vaults') @UseGuards(AuthGuard)
export class VaultController {
  constructor(@Inject(VaultService) private readonly vaults: VaultService) {}
  @Get() list(@Req() req: AuthRequest) { return this.vaults.list(req.principal.id); }
  @Post() create(@Req() req: AuthRequest, @Body() body: unknown) { return this.vaults.create(req.principal, body); }
  @Get(':id') get(@Req() req: AuthRequest, @Param('id') id: string) { return this.vaults.get(id, req.principal.id); }
  @Get(':id/key-bundles') bundles(@Req() req: AuthRequest, @Param('id') id: string) { return this.vaults.bundles(id, req.principal.id); }
  @Put(':id/key-bundle') rewrap(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: unknown) { return this.vaults.rewrap(id, req.principal, body); }
  @Post(':id/operations') operate(@Req() req: AuthRequest, @Param('id') id: string, @Body() body: unknown) { return this.vaults.operate(id, req.principal, body); }
  @Get(':id/changes') changes(@Req() req: AuthRequest, @Param('id') id: string, @Query() query: Record<string, unknown>) { return this.vaults.changes(id, req.principal.id, query); }
  @Get(':id/records/:recordId/history') history(@Req() req: AuthRequest, @Param('id') id: string, @Param('recordId') recordId: string) { return this.vaults.history(id, req.principal.id, recordId); }
  @Get(':id/assets') assets(@Req() req: AuthRequest, @Param('id') id: string) { return this.vaults.assets(id, req.principal.id); }
  @Get(':id/assets/:recordId') asset(@Req() req: AuthRequest, @Param('id') id: string, @Param('recordId') recordId: string, @Query('revision') revision: unknown) { return this.vaults.asset(id, req.principal.id, recordId, revision); }
}
