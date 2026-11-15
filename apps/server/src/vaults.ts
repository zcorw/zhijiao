import { Body, Controller, Get, Post, Put, Param, Query, Req, Injectable, Inject, UseGuards, UnauthorizedException } from '@nestjs/common';
import { Pool } from 'pg';
import { VaultService as SyncVaultService } from '@zcorw/encrypted-vault/server';
import { PostgresVaultRepository, type PostgresVaultTransaction } from '@zcorw/encrypted-vault/adapters/postgres';
import { AuthGuard, type AuthRequest, type Principal } from './auth.js';
import { DATABASE } from './database.js';
export { keyBundleSchema } from '@zcorw/encrypted-vault/server';
@Injectable()
export class VaultService extends SyncVaultService<Principal,PostgresVaultTransaction> {
  constructor(@Inject(DATABASE) pool:Pool){
    super(new PostgresVaultRepository(pool,{tablePrefix:'zj_'}),{authorizeWrite:async(transaction,principal)=>{
    const db=transaction.client;
    const account = (await db.query('SELECT auth_version::text,status FROM ac_accounts WHERE id=$1 FOR UPDATE', [principal.id])).rows[0];
    const valid = (await db.query('SELECT 1 FROM ac_sessions WHERE sid=$1 AND expire>now() AND NOT EXISTS(SELECT 1 FROM ac_session_revocations WHERE sid=$1)', [principal.sid])).rowCount;
    if (!valid || account?.status !== 'active' || account.auth_version !== principal.authVersion) throw new UnauthorizedException({ code: 'AUTH_REQUIRED' });
    }});
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
