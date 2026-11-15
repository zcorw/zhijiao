import { z } from 'zod';

/** Static diagnostics only: no provider text, model values, or input-derived paths. */
export const INTERACTION_ANALYSIS_FAILURE_REASONS = [
  'UPSTREAM_HTTP', 'UPSTREAM_NETWORK', 'RESPONSE_TOO_LARGE', 'RESPONSE_INVALID_JSON', 'RESPONSE_INVALID',
  'OUTPUT_INCOMPLETE', 'OUTPUT_REFUSED', 'OUTPUT_INVALID_JSON', 'MODEL_SCHEMA', 'MODEL_EVIDENCE', 'MODEL_SEMANTICS',
  'CANDIDATE_BUDGET', 'NORMALIZATION', 'INTERNAL', 'TIMEOUT',
] as const;
export type InteractionAnalysisFailureReason = typeof INTERACTION_ANALYSIS_FAILURE_REASONS[number];

/** Strip unknown properties; never render arbitrary error messages received over HTTP. */
export const interactionAnalysisFailureSchema = z.object({
  code: z.enum(['AI_FAILED', 'AI_TIMEOUT']),
  reason: z.enum(INTERACTION_ANALYSIS_FAILURE_REASONS).optional(),
  upstreamStatus: z.number().int().min(100).max(599).optional(),
  timeoutMs: z.number().int().min(1).max(600_000).optional(),
  issueCount: z.number().int().min(0).max(10_000).optional(),
});
export type InteractionAnalysisFailure = z.infer<typeof interactionAnalysisFailureSchema>;
