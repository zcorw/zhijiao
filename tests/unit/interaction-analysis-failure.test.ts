import 'reflect-metadata';
import { HttpException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import * as shared from '@zhijiao/shared';
import { InteractionAnalysisService } from '../../apps/server/src/interaction-analysis.js';
import type { AppConfig } from '../../apps/server/src/config.js';

vi.mock('@zhijiao/shared', async importOriginal => {
  const actual = await importOriginal<typeof import('@zhijiao/shared')>();
  return { ...actual,
    normalizeInteractionModelResult: vi.fn(actual.normalizeInteractionModelResult),
    validateAnalysisEvidence: vi.fn(actual.validateAnalysisEvidence),
    validateInteractionModelResult: vi.fn(actual.validateInteractionModelResult),
  };
});

const input = { title: '虚构事件', content: '' };
const model = { schemaVersion: '3.0.0', event: { summary: null, occurredAtText: null, evidence: [] }, people: [], statements: [], ambiguities: [] };
function prepare() {
  const network = vi.fn().mockImplementation(async () => Response.json({ status: 'completed', output: [{
    type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(model) }],
  }] }));
  vi.stubGlobal('fetch', network);
  const analyzer = new InteractionAnalysisService({ analysis: {
    defaultProvider: 'openai', providers: { openai: { apiKey: 'fictional-key', model: 'gpt-6.1-sol' } }, timeoutMs: 1000,
  } } as AppConfig);
  return { analyzer, network };
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('interaction analysis failure boundary', () => {
  it('keeps the final normalized evidence guard and returns only its static reason', async () => {
    const { analyzer, network } = prepare();
    vi.mocked(shared.normalizeInteractionModelResult).mockReturnValueOnce({ people: [], reflections: [], followUps: [], facts: [],
      backgrounds: [{ personKeys: [], content: 'fictional-private-content', evidence: 'fictional-private-evidence' }],
    });
    const failure = await analyzer.analyze('account', input, 'openai').catch(value => value);
    expect(failure.getResponse()).toEqual({ code: 'AI_FAILED', reason: 'MODEL_EVIDENCE' });
    expect(JSON.stringify(failure)).not.toContain('fictional-private');
    await expect(analyzer.analyze('account', input, 'openai')).resolves.toEqual({ people: [], reflections: [], followUps: [], facts: [], backgrounds: [] });
    expect(network).toHaveBeenCalledTimes(2);
  });

  it.each(['message', 'other-param', 'non-zod'] as const)('does not infer a budget failure from an untrusted %s', async variant => {
    const { analyzer, network } = prepare();
    const issue = { code: 'custom' as const, path: ['fictional-private-path'], message: 'CANDIDATE_BUDGET fictional-private-message',
      ...(variant === 'other-param' ? { params: { other: 'CANDIDATE_BUDGET' } } : {}),
    };
    const incoming = variant === 'non-zod'
      ? { issues: [{ ...issue, params: { interactionAnalysisFailureReason: 'CANDIDATE_BUDGET' } }], stack: 'fictional-private-stack' }
      : new ZodError([issue]);
    vi.mocked(shared.normalizeInteractionModelResult).mockImplementationOnce(() => { throw incoming; });
    const failure = await analyzer.analyze('account', input, 'openai').catch(value => value);
    expect(failure.getResponse()).toEqual({ code: 'AI_FAILED', reason: 'NORMALIZATION', ...(variant === 'non-zod' ? {} : { issueCount: 1 }) });
    expect(JSON.stringify(failure)).not.toContain('fictional-private');
    expect(String(failure.stack)).not.toContain('fictional-private');
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('does not forward arbitrary HttpExceptions thrown during normalization', async () => {
    const { analyzer, network } = prepare();
    const incoming = new HttpException({ code: 'AI_TIMEOUT', reason: 'TIMEOUT', privateField: 'fictional-private-body' }, 418);
    incoming.stack = 'fictional-private-stack';
    vi.mocked(shared.normalizeInteractionModelResult).mockImplementationOnce(() => { throw incoming; });
    const failure = await analyzer.analyze('account', input, 'openai').catch(value => value);
    expect(failure).not.toBe(incoming);
    expect(failure.getResponse()).toEqual({ code: 'AI_FAILED', reason: 'NORMALIZATION' });
    expect(failure.getStatus()).toBe(502);
    expect(JSON.stringify(failure)).not.toContain('fictional-private');
    expect(String(failure.stack)).not.toContain('fictional-private');
    expect(network).toHaveBeenCalledTimes(1);
  });

  it('clamps diagnostic counts and excludes all validator issue text', async () => {
    const { analyzer, network } = prepare();
    vi.mocked(shared.validateInteractionModelResult).mockReturnValueOnce({ schemaValid: false, citationsValid: false, referencesValid: false,
      issues: Array.from({ length: 10_001 }, () => 'fictional-private-field-and-model-id'), quoteCount: 0, validQuoteCount: 0,
    });
    const failure = await analyzer.analyze('account', input, 'openai').catch(value => value);
    expect(failure.getResponse()).toEqual({ code: 'AI_FAILED', reason: 'MODEL_SCHEMA', issueCount: 10_000 });
    expect(shared.interactionAnalysisFailureSchema.safeParse(failure.getResponse()).success).toBe(true);
    expect(JSON.stringify(failure)).not.toContain('fictional-private');
    expect(network).toHaveBeenCalledTimes(1);
  });
});
