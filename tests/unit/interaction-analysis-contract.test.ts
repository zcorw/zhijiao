import { describe, expect, it } from 'vitest';
import { interactionAnalysisRequestSchema, interactionAnalysisSchema, validateAnalysisEvidence } from '../../packages/shared/src/index.js';
import { loadConfig } from '../../apps/server/src/config.js';

const candidate = {
  people: [
    { key: 'p1', name: '我（当前用户）', mention: '我觉得', isSelf: true },
    { key: 'p2', name: '小岚', mention: '小岚', isSelf: false },
  ],
  reflections: [{ personKey: 'p2', type: 'feeling', content: '我觉得这次与小岚相处很轻松。', evidence: '我觉得和小岚相处很轻松' }],
  followUps: [{ personKeys: ['p1', 'p2'], title: '给小岚发资料', details: '我答应明天把资料发给小岚。', type: 'promise', responsibility: 'me', evidence: '我答应明天把资料发给小岚' }],
};

describe('interaction analysis candidate contract', () => {
  it('accepts event-local candidates and no-result analysis', () => {
    expect(interactionAnalysisSchema.parse(candidate)).toEqual(candidate);
    expect(interactionAnalysisSchema.parse({ people: [], reflections: [], followUps: [] })).toEqual({ people: [], reflections: [], followUps: [] });
  });

  it('rejects invented person references, duplicate keys and multiple narrators', () => {
    expect(interactionAnalysisSchema.safeParse({ ...candidate, reflections: [{ ...candidate.reflections[0], personKey: 'absent' }] }).success).toBe(false);
    expect(interactionAnalysisSchema.safeParse({ ...candidate, followUps: [{ ...candidate.followUps[0], personKeys: ['absent'] }] }).success).toBe(false);
    expect(interactionAnalysisSchema.safeParse({ ...candidate, people: [candidate.people[0], candidate.people[0]] }).success).toBe(false);
    expect(interactionAnalysisSchema.safeParse({ ...candidate, people: candidate.people.map(person => ({ ...person, isSelf: true })) }).success).toBe(false);
    expect(interactionAnalysisSchema.safeParse({ ...candidate, followUps: [{ ...candidate.followUps[0], personKeys: ['p2', 'p2'] }] }).success).toBe(false);
  });

  it('keeps output bounded and rejects unsupported enums, unknown fields and invalid calendar dates', () => {
    expect(interactionAnalysisSchema.safeParse({ ...candidate, followUps: [{ ...candidate.followUps[0], dueDate: '2026-02-30' }] }).success).toBe(false);
    expect(interactionAnalysisSchema.safeParse({ ...candidate, reflections: [{ ...candidate.reflections[0], type: 'diagnosis' }] }).success).toBe(false);
    expect(interactionAnalysisSchema.safeParse({ ...candidate, facts: [] }).success).toBe(false);
    expect(interactionAnalysisSchema.safeParse({ ...candidate, reflections: Array.from({ length: 21 }, () => candidate.reflections[0]) }).success).toBe(false);
    expect(interactionAnalysisSchema.safeParse({ ...candidate, reflections: [{ ...candidate.reflections[0], content: 'a'.repeat(3001) }] }).success).toBe(false);
  });

  it('does not accept a supplied user identity or an entire person directory', () => {
    const input = { title: '一次见面', content: '我觉得和小岚相处很轻松。', occurredOn: '2026-10' };
    expect(interactionAnalysisRequestSchema.parse(input)).toEqual(input);
    expect(interactionAnalysisRequestSchema.safeParse({ ...input, currentUser: { displayName: '其他用户' } }).success).toBe(false);
    expect(interactionAnalysisRequestSchema.safeParse({ ...input, people: candidate.people }).success).toBe(false);
    expect(interactionAnalysisRequestSchema.parse({ ...input, content: ' ' }).content).toBe('');
    expect(interactionAnalysisRequestSchema.safeParse({ ...input, content: 'a'.repeat(20001) }).success).toBe(false);
  });

  it('requires continuous original evidence and rejects stitched or paraphrased quotes', () => {
    const result = interactionAnalysisSchema.parse(candidate);
    const input = { title: '虚构交往', content: '我觉得和小岚相处很轻松。我答应明天把资料发给小岚。' };
    expect(validateAnalysisEvidence(result, input)).toBe(true);
    expect(validateAnalysisEvidence({ ...result, reflections: [{ ...result.reflections[0], evidence: '和小岚相处特别轻松' }] }, input)).toBe(false);
    expect(validateAnalysisEvidence({ ...result, reflections: [{ ...result.reflections[0], evidence: '交往\n我觉得' }] }, input)).toBe(false);
  });
});

describe('optional interaction AI configuration', () => {
  const required = { SESSION_SECRET: 'fictional-session-secret-for-tests-only' };
  const configured = { ...required, DEEPSEEK_API_KEY: 'fictional-key', DEEPSEEK_MODEL: 'example-model' };
  it('defaults to disabled and only enables when an API key exists', () => {
    expect(loadConfig(required).analysis).toBeUndefined();
    expect(loadConfig({ ...required, DEEPSEEK_MODEL: 'example-model' }).analysis).toBeUndefined();
    expect(loadConfig(configured).analysis).toEqual({ apiKey: 'fictional-key', model: 'example-model', timeoutMs: 60000 });
    expect(loadConfig({ ...required, DEEPSEEK_API_KEY: 'fictional-key' }).analysis?.model).toBe('deepseek-flash');
  });
  it('does not expose a configurable destination and rejects unsafe timeout bounds', () => {
    expect(loadConfig({ ...configured, INTERACTION_AI_BASE_URL: 'https://other.example.invalid' }).analysis).not.toHaveProperty('baseUrl');
    for (const timeout of ['0', 'NaN', '120001']) expect(() => loadConfig({ ...configured, INTERACTION_AI_TIMEOUT_MS: timeout })).toThrow();
  });
});
