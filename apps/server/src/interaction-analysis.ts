import { Body, Controller, Get, HttpCode, HttpException, Inject, Injectable, Post, Req, UseGuards } from '@nestjs/common';
import { interactionAnalysisRequestSchema, validateAnalysisEvidence, interactionModelResultSchema, validateInteractionModelResult, normalizeInteractionModelResult, INTERACTION_ANALYSIS_MODEL_SCHEMA, INTERACTION_ANALYSIS_CANDIDATE_BUDGET, INTERACTION_ANALYSIS_PROMPT, type InteractionAnalysis } from '@zhijiao/shared';
import { AuthGuard, type AuthRequest } from './auth.js';
import { CONFIG } from './database.js';
import type { AppConfig } from './config.js';

export { INTERACTION_ANALYSIS_PROMPT } from '@zhijiao/shared';

/** Pure preparation only. No user identity or other vault records enter the model input. */
export function buildInteractionAnalysisMessages(input: unknown): Array<{ role: 'system' | 'user'; content: string }> {
  const interaction = interactionAnalysisRequestSchema.parse(input);
  const formatInstructions = `正式保存约束：只选支持本命题的必要短连续引文，不重复整篇或大量重叠长段。证据须逐字存在，不改写、拼接或用省略号替代。相关归类理由和歧义说明须简明保留。单条规范化事实、感受或事项（含全部证据与相关歧义）的 JSON 序列化长度，加上来源、视角及责任人各角色引用的人物身份依据 JSON 长度，合计不得超过 ${INTERACTION_ANALYSIS_CANDIDATE_BUDGET} 字符；同一人物的多个角色分别计算，超出会拒绝，不会自动裁剪。`;
  return [{ role: 'system', content: INTERACTION_ANALYSIS_PROMPT + '\n' + formatInstructions + '\n返回 JSON Schema（所有字段均须提供，不增加字段）：\n' + JSON.stringify(INTERACTION_ANALYSIS_MODEL_SCHEMA) }, { role: 'user', content: JSON.stringify({ interaction }) }];
}

function fail(code: string, status: number): never { throw new HttpException({ code }, status); }

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const maxBytes = 256 * 1024;
  const length = response.headers.get('content-length');
  if (length && Number(length) > maxBytes) { await response.body?.cancel(); fail('AI_FAILED', 502); }
  if (!response.body) fail('AI_FAILED', 502);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error('Aborted');
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); fail('AI_FAILED', 502); }
      chunks.push(value);
    }
    if (signal.aborted) throw new Error('Aborted');
    const result = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result)) as unknown;
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

@Injectable()
export class InteractionAnalysisService {
  private readonly limits = new Map<string, { busy: boolean; started: number; attempts: number }>();
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  status(): { available: boolean; providerLabel?: string } {
    return this.config.analysis ? { available: true, providerLabel: `DeepSeek · ${this.config.analysis.model}` } : { available: false };
  }

  async analyze(accountId: string, input: unknown): Promise<InteractionAnalysis> {
    const parsed = interactionAnalysisRequestSchema.safeParse(input);
    if (!parsed.success) fail('AI_INVALID_INPUT', 400);
    const config = this.config.analysis;
    if (!config) fail('AI_NOT_CONFIGURED', 503);
    const now = Date.now();
    for (const [id, limit] of this.limits) if (!limit.busy && now - limit.started >= 60000) this.limits.delete(id);
    let limit = this.limits.get(accountId);
    if (limit?.busy) fail('AI_BUSY', 429);
    if (!limit || now - limit.started >= 60000) { limit = { busy: false, started: now, attempts: 0 }; this.limits.set(accountId, limit); }
    if (limit.attempts >= 6) fail('AI_RATE_LIMITED', 429);
    limit.busy = true; limit.attempts++;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, thinking: { type: 'enabled' }, reasoning_effort: 'low', stream: false,
          response_format: { type: 'json_object' },
          messages: buildInteractionAnalysisMessages(parsed.data) }),
      });
      if (!response.ok) { await response.body?.cancel(); fail('AI_FAILED', 502); }
      const body = await boundedJson(response, controller.signal) as { choices?: Array<{ finish_reason?: string; message?: { content?: unknown } }> };
      const choice = body?.choices?.[0];
      if (!choice || choice.finish_reason !== 'stop' || typeof choice.message?.content !== 'string') fail('AI_FAILED', 502);
      const decoded: unknown = JSON.parse(choice.message.content);
      // Never repair labels, retry the provider, or fall back from canonical v3 to an older shape.
      const validation = validateInteractionModelResult(decoded, parsed.data);
      if (!validation.schemaValid || !validation.citationsValid || !validation.referencesValid) fail('AI_FAILED', 502);
      const result = normalizeInteractionModelResult(interactionModelResultSchema.parse(decoded));
      if (!validateAnalysisEvidence(result, parsed.data)) fail('AI_FAILED', 502);
      return result;
    } catch {
      // Never expose provider errors or attach submitted plaintext to logs or exceptions.
      fail(controller.signal.aborted ? 'AI_TIMEOUT' : 'AI_FAILED', 502);
    } finally { clearTimeout(timeout); limit.busy = false; }
  }
}

@Controller('analysis')
@UseGuards(AuthGuard)
export class InteractionAnalysisController {
  constructor(@Inject(InteractionAnalysisService) private readonly service: InteractionAnalysisService) {}
  @Get('status') status() { return this.service.status(); }
  @Post('interaction') @HttpCode(200) analyze(@Req() req: AuthRequest, @Body() body: unknown) { return this.service.analyze(req.principal.id, body); }
}
