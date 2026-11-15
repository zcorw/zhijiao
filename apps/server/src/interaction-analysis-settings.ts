import { BadRequestException, Body, ConflictException, Controller, Get, Inject, Injectable, Put, Req, UseGuards } from '@nestjs/common';
import { interactionAnalysisProviderSchema, interactionAnalysisSettingsUpdateSchema, type InteractionAnalysisProvider, type InteractionAnalysisSettings } from '@zhijiao/shared';
import type { Pool } from 'pg';
import { AuthGuard, type AuthRequest } from './auth.js';
import type { AppConfig } from './config.js';
import { CONFIG, DATABASE } from './database.js';

@Injectable()
export class InteractionAnalysisPreferencesService {
  constructor(@Inject(DATABASE) private readonly pool: Pool, @Inject(CONFIG) private readonly config: AppConfig) {}

  async getPreference(accountId: string): Promise<InteractionAnalysisProvider | null> {
    const { rows } = await this.pool.query<{ provider: InteractionAnalysisProvider }>(
      'SELECT provider FROM zj_analysis_preferences WHERE account_id=$1', [accountId],
    );
    return rows[0]?.provider ?? null;
  }

  async getSettings(accountId: string): Promise<InteractionAnalysisSettings> {
    return this.describe(await this.getPreference(accountId));
  }

  async setPreference(accountId: string, input: unknown): Promise<InteractionAnalysisSettings> {
    const parsed = interactionAnalysisSettingsUpdateSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException({ code: 'AI_INVALID_PROVIDER' });
    const { provider } = parsed.data;
    if (provider === null) {
      await this.pool.query('DELETE FROM zj_analysis_preferences WHERE account_id=$1', [accountId]);
    } else {
      if (!this.config.analysis?.providers[provider]) throw new ConflictException({ code: 'AI_PROVIDER_UNAVAILABLE' });
      await this.pool.query(`INSERT INTO zj_analysis_preferences(account_id,provider) VALUES($1,$2)
        ON CONFLICT(account_id) DO UPDATE SET provider=excluded.provider`, [accountId, provider]);
    }
    return this.describe(provider);
  }

  private describe(preferredProvider: InteractionAnalysisProvider | null): InteractionAnalysisSettings {
    const defaultProvider = this.config.analysis?.defaultProvider ?? null;
    return {
      provider: preferredProvider ?? defaultProvider,
      preferredProvider,
      defaultProvider,
      providers: interactionAnalysisProviderSchema.options.map(id => ({ id, model: this.config.analysis?.providers[id]?.model ?? null })),
    };
  }
}

@Controller('analysis/settings')
@UseGuards(AuthGuard)
export class InteractionAnalysisPreferencesController {
  constructor(@Inject(InteractionAnalysisPreferencesService) private readonly preferences: InteractionAnalysisPreferencesService) {}

  @Get()
  settings(@Req() req: AuthRequest) {
    return this.preferences.getSettings(req.principal.id);
  }

  @Put()
  update(@Req() req: AuthRequest, @Body() body: unknown) {
    return this.preferences.setPreference(req.principal.id, body);
  }
}
