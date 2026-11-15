import { Body, Controller, Get, HttpCode, HttpException, Inject, Injectable, Post, Req, UseGuards } from '@nestjs/common';
import { interactionAnalysisRequestSchema, validateAnalysisEvidence, interactionModelResultSchema, validateInteractionModelResult, normalizeInteractionModelResult, INTERACTION_ANALYSIS_MODEL_SCHEMA, INTERACTION_ANALYSIS_CANDIDATE_BUDGET, INTERACTION_ANALYSIS_PROMPT, type InteractionAnalysis, type InteractionAnalysisFailure, type InteractionAnalysisFailureReason, type InteractionAnalysisProvider, type InteractionAnalysisStatus } from '@zhijiao/shared';
import { ZodError } from 'zod';
import { AuthGuard, type AuthRequest } from './auth.js';
import { CONFIG } from './database.js';
import type { AppConfig } from './config.js';
import { InteractionAnalysisPreferencesService } from './interaction-analysis-settings.js';

export { INTERACTION_ANALYSIS_PROMPT } from '@zhijiao/shared';

// The Responses API takes the schema itself. The dialect URI is local export metadata.
const { $schema: _dialect, ...openAIModelSchema } = INTERACTION_ANALYSIS_MODEL_SCHEMA;

/** Pure preparation only. No user identity or other vault records enter the model input. */
export function buildInteractionAnalysisMessages(input: unknown, provider: InteractionAnalysisProvider = 'openai'): Array<{ role: 'system' | 'developer' | 'user'; content: string }> {
  const interaction = interactionAnalysisRequestSchema.parse(input);
  const formatInstructions = `正式保存约束：只选支持本命题的必要短连续引文，不重复整篇或大量重叠长段。证据须逐字存在，不改写、拼接或用省略号替代。相关归类理由和歧义说明须简明保留。单条规范化事实、感受或事项（含全部证据与相关歧义）的 JSON 序列化长度，加上来源、视角及责任人各角色引用的人物身份依据 JSON 长度，合计不得超过 ${INTERACTION_ANALYSIS_CANDIDATE_BUDGET} 字符；同一人物的多个角色分别计算，超出会拒绝，不会自动裁剪。`;
  const instructions = INTERACTION_ANALYSIS_PROMPT + '\n' + formatInstructions;
  const instructionMessage = provider === 'deepseek'
    ? { role: 'system' as const, content: instructions + '\n返回 JSON Schema（所有字段均须提供，不增加字段）：\n' + JSON.stringify(INTERACTION_ANALYSIS_MODEL_SCHEMA) }
    : { role: 'developer' as const, content: instructions };
  return [instructionMessage, { role: 'user', content: JSON.stringify({ interaction }) }];
}

function fail(code: string, status: number): never { throw new HttpException({ code }, status); }

type FailureMetadata = Pick<InteractionAnalysisFailure, 'upstreamStatus' | 'timeoutMs' | 'issueCount'>;
/** Only locally created, static diagnostics can cross the failure boundary. */
class AnalysisFailure extends HttpException {
  constructor(reason: InteractionAnalysisFailureReason, metadata: FailureMetadata = {}) {
    super({ code: reason === 'TIMEOUT' ? 'AI_TIMEOUT' : 'AI_FAILED', reason, ...metadata } satisfies InteractionAnalysisFailure, 502);
  }
}
function analysisFailed(reason: InteractionAnalysisFailureReason, metadata?: FailureMetadata): never { throw new AnalysisFailure(reason, metadata); }
const issueCount = (issues: readonly unknown[]) => Math.min(issues.length, 10_000);

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const maxBytes = 256 * 1024;
  const length = response.headers.get('content-length');
  if (length && Number(length) > maxBytes) { void response.body?.cancel().catch(() => undefined); analysisFailed('RESPONSE_TOO_LARGE'); }
  if (!response.body) analysisFailed('RESPONSE_INVALID');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      if (signal.aborted) throw new Error('Aborted');
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); } catch { analysisFailed('UPSTREAM_NETWORK'); }
      const { done, value } = chunk;
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { void reader.cancel().catch(() => undefined); analysisFailed('RESPONSE_TOO_LARGE'); }
      chunks.push(value);
    }
    if (signal.aborted) throw new Error('Aborted');
    const result = new Uint8Array(bytes); let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(result); } catch { analysisFailed('RESPONSE_INVALID_JSON'); }
    if (!text.trim()) analysisFailed('RESPONSE_INVALID');
    try { return JSON.parse(text) as unknown; } catch { analysisFailed('RESPONSE_INVALID_JSON'); }
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readOpenAIOutput(body: unknown): string {
  if (!isRecord(body)) analysisFailed('RESPONSE_INVALID');
  if (body.status === 'incomplete' && isRecord(body.incomplete_details) && body.incomplete_details.reason === 'content_filter') {
    analysisFailed('OUTPUT_REFUSED');
  }
  if (body.status === 'incomplete' || body.status === 'cancelled' || body.status === 'queued' || body.status === 'in_progress') {
    analysisFailed('OUTPUT_INCOMPLETE');
  }
  if (body.status !== 'completed' || body.error != null || !Array.isArray(body.output)) analysisFailed('RESPONSE_INVALID');

  const text: string[] = [];
  for (const item of body.output) {
    if (!isRecord(item)) analysisFailed('RESPONSE_INVALID');
    if (item.type === 'reasoning') continue;
    if (item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) analysisFailed('RESPONSE_INVALID');
    if (item.status === 'incomplete' || item.status === 'in_progress') analysisFailed('OUTPUT_INCOMPLETE');
    if (item.status !== 'completed') analysisFailed('RESPONSE_INVALID');
    for (const part of item.content) {
      if (!isRecord(part)) analysisFailed('RESPONSE_INVALID');
      if (part.type === 'refusal' && typeof part.refusal === 'string') analysisFailed('OUTPUT_REFUSED');
      if (part.type !== 'output_text' || typeof part.text !== 'string') analysisFailed('RESPONSE_INVALID');
      text.push(part.text);
    }
  }
  const output = text.join('');
  if (!output.trim()) analysisFailed('RESPONSE_INVALID');
  return output;
}

function readDeepSeekOutput(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.choices)) analysisFailed('RESPONSE_INVALID');
  const choice: unknown = body.choices[0];
  if (!isRecord(choice) || typeof choice.finish_reason !== 'string') analysisFailed('RESPONSE_INVALID');
  if (choice.finish_reason === 'content_filter') analysisFailed('OUTPUT_REFUSED');
  if (choice.finish_reason !== 'stop') analysisFailed('OUTPUT_INCOMPLETE');
  if (!isRecord(choice.message) || typeof choice.message.content !== 'string') analysisFailed('RESPONSE_INVALID');
  return choice.message.content;
}

@Injectable()
export class InteractionAnalysisService {
  private readonly limits = new Map<string, { busy: boolean; started: number; attempts: number }>();
  constructor(@Inject(CONFIG) private readonly config: AppConfig) {}

  private resolveProvider(preference: InteractionAnalysisProvider | null) {
    const analysis = this.config.analysis;
    if (!analysis) return undefined;
    const provider = preference ?? analysis.defaultProvider;
    const credentials = analysis.providers[provider];
    return credentials ? { provider, ...credentials, timeoutMs: analysis.timeoutMs } : undefined;
  }

  status(preference: InteractionAnalysisProvider | null = null): InteractionAnalysisStatus {
    const config = this.resolveProvider(preference);
    if (!config) return { available: false };
    const providerName = config.provider === 'openai' ? 'OpenAI' : 'DeepSeek';
    return { available: true, provider: config.provider, providerLabel: `${providerName} · ${config.model}` };
  }

  async analyze(
    accountId: string,
    input: unknown,
    expectedProvider: string | undefined,
    preference: InteractionAnalysisProvider | null = null,
  ): Promise<InteractionAnalysis> {
    const parsed = interactionAnalysisRequestSchema.safeParse(input);
    if (!parsed.success) fail('AI_INVALID_INPUT', 400);
    const config = this.resolveProvider(preference);
    if (!config) fail('AI_NOT_CONFIGURED', 503);
    if (config.provider !== expectedProvider) fail('AI_PROVIDER_CHANGED', 409);
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
      const messages = buildInteractionAnalysisMessages(parsed.data, config.provider);
      const openAI = config.provider === 'openai';
      const endpoint = openAI ? 'https://api.openai.com/v1/responses' : 'https://api.deepseek.com/chat/completions';
      const payload = openAI ? {
        model: config.model,
        store: false,
        stream: false,
        reasoning: { effort: 'low' },
        input: messages,
        text: { format: { type: 'json_schema', name: 'interaction_analysis', strict: true, schema: openAIModelSchema } },
      } : {
        model: config.model,
        thinking: { type: 'enabled' },
        reasoning_effort: 'low',
        stream: false,
        response_format: { type: 'json_object' },
        messages,
      };
      const request: RequestInit = {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify(payload),
      };
      let response: Response;
      try { response = await fetch(endpoint, request); } catch { analysisFailed('UPSTREAM_NETWORK'); }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        const status = response.status;
        analysisFailed('UPSTREAM_HTTP', Number.isInteger(status) && status >= 100 && status <= 599 ? { upstreamStatus: status } : {});
      }
      const body = await boundedJson(response, controller.signal);
      const output = openAI ? readOpenAIOutput(body) : readDeepSeekOutput(body);
      let decoded: unknown;
      try { decoded = JSON.parse(output); } catch { analysisFailed('OUTPUT_INVALID_JSON'); }
      // Never repair labels, retry the provider, or fall back from canonical v3 to an older shape.
      const validation = validateInteractionModelResult(decoded, parsed.data);
      const validationMetadata = { issueCount: issueCount(validation.issues) };
      if (!validation.schemaValid) analysisFailed('MODEL_SCHEMA', validationMetadata);
      if (!validation.citationsValid) analysisFailed('MODEL_EVIDENCE', validationMetadata);
      if (!validation.referencesValid) analysisFailed('MODEL_SEMANTICS', validationMetadata);
      let result: InteractionAnalysis;
      try { result = normalizeInteractionModelResult(interactionModelResultSchema.parse(decoded)); } catch (error) {
        const issues = error instanceof ZodError ? error.issues : undefined;
        const budgetExceeded = issues?.some(issue => issue.code === 'custom' && issue.params?.interactionAnalysisFailureReason === 'CANDIDATE_BUDGET');
        analysisFailed(budgetExceeded ? 'CANDIDATE_BUDGET' : 'NORMALIZATION', issues ? { issueCount: issueCount(issues) } : {});
      }
      if (!validateAnalysisEvidence(result, parsed.data)) analysisFailed('MODEL_EVIDENCE');
      return result;
    } catch (error) {
      // Never expose provider errors or attach submitted plaintext to logs or exceptions.
      if (controller.signal.aborted) analysisFailed('TIMEOUT', { timeoutMs: config.timeoutMs });
      if (error instanceof AnalysisFailure) throw error;
      analysisFailed('INTERNAL');
    } finally { clearTimeout(timeout); limit.busy = false; }
  }
}

@Controller('analysis')
@UseGuards(AuthGuard)
export class InteractionAnalysisController {
  constructor(
    @Inject(InteractionAnalysisService) private readonly service: InteractionAnalysisService,
    @Inject(InteractionAnalysisPreferencesService) private readonly preferences: InteractionAnalysisPreferencesService,
  ) {}

  @Get('status') async status(@Req() req: AuthRequest) {
    return this.service.status(await this.preferences.getPreference(req.principal.id));
  }

  @Post('interaction') @HttpCode(200) async analyze(@Req() req: AuthRequest, @Body() body: unknown) {
    const preference = await this.preferences.getPreference(req.principal.id);
    return this.service.analyze(req.principal.id, body, req.get('X-Interaction-AI-Provider'), preference);
  }
}
