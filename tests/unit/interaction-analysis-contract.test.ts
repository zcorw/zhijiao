import { describe, expect, it } from 'vitest';
import { interactionAnalysisRequestSchema, interactionAnalysisSchema, validateAnalysisEvidence, interactionModelResultSchema,
  validateInteractionModelResult, normalizeInteractionModelResult, INTERACTION_ANALYSIS_MODEL_SCHEMA, INTERACTION_ANALYSIS_PROMPT,
  INTERACTION_ANALYSIS_CANDIDATE_BUDGET, type InteractionModelResult } from '../../packages/shared/src/index.js';
import { BASIS_PROMPT_EXAMPLES } from '../../packages/shared/src/interaction-analysis-examples.js';
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
    expect(interactionAnalysisSchema.parse(candidate)).toEqual({ ...candidate, facts: [], backgrounds: [] });
    expect(interactionAnalysisSchema.parse({ people: [], reflections: [], followUps: [] })).toEqual({ people: [], reflections: [], followUps: [], facts: [], backgrounds: [] });
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
    expect(interactionAnalysisSchema.safeParse({ ...candidate, unknown: [] }).success).toBe(false);
    expect(interactionAnalysisSchema.safeParse({ ...candidate, reflections: Array.from({ length: 721 }, () => candidate.reflections[0]) }).success).toBe(false);
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
    expect(loadConfig(configured).analysis).toEqual({ apiKey: 'fictional-key', model: 'example-model', timeoutMs: 300000 });
    expect(loadConfig({ ...required, DEEPSEEK_API_KEY: 'fictional-key' }).analysis?.model).toBe('deepseek-flash');
  });
  it('does not expose a configurable destination and rejects unsafe timeout bounds', () => {
    expect(loadConfig({ ...configured, INTERACTION_AI_BASE_URL: 'https://other.example.invalid' }).analysis).not.toHaveProperty('baseUrl');
    expect(loadConfig({ ...configured, INTERACTION_AI_TIMEOUT_MS: '600000' }).analysis?.timeoutMs).toBe(600000);
    for (const timeout of ['0', '999', 'NaN', '600001']) expect(() => loadConfig({ ...configured, INTERACTION_AI_TIMEOUT_MS: timeout })).toThrow();
  });
});

function basisResult(example = BASIS_PROMPT_EXAMPLES[0]): InteractionModelResult {
  const labels = [['p1', '我'], ['p2', '小岚'], ['p3', '阿北']];
  return {
    schemaVersion: '3.0.0', event: { summary: null, occurredAtText: null, evidence: [] },
    people: labels.filter(([, label]) => example.input.includes(label)).map(([id, label]) => ({
      id, label, aliases: [], participation: 'participant', isNarrator: id === 'p1', evidence: [label], uncertainty: null,
    })),
    statements: [{ id: 's1', ...example.fields, text: example.text, destination: 'personFact',
      classificationReason: '原文明示的个人近况或偏好，保留直接提供者和来源性质，尚待人工确认。', reviewStatus: 'pending',
      reflection: null, followUp: null, evidence: [example.input],
    }],
    ambiguities: example.fields.personFact.factStatus === 'ambiguous'
      ? [{ id: 'a1', text: example.fields.uncertainty!, evidence: [example.input], candidatePersonIds: example.fields.subjectIds }] : [],
  };
}
function valid(result: unknown, content: string, title = '虚构交往'): boolean {
  const report = validateInteractionModelResult(result, { title, content });
  return report.schemaValid && report.citationsValid && report.referencesValid;
}

describe('canonical v3 interaction analysis', () => {
  it('shares one strict model schema and the validated source examples with the extraction prompt', () => {
    expect(INTERACTION_ANALYSIS_MODEL_SCHEMA).toMatchObject({ type: 'object', additionalProperties: false,
      required: ['schemaVersion', 'event', 'people', 'statements', 'ambiguities'], properties: { schemaVersion: { const: '3.0.0' } },
    });
    for (const example of BASIS_PROMPT_EXAMPLES) expect(INTERACTION_ANALYSIS_PROMPT).toContain(example.input);
    expect(INTERACTION_ANALYSIS_PROMPT).toContain('不能机械设为 third-party');
    expect(INTERACTION_ANALYSIS_PROMPT).toContain('别人说自己最近焦虑不是当前用户的感受');
    expect(INTERACTION_ANALYSIS_PROMPT).toContain('已完成、否定、拒绝、尚未答应/未决定');
    const legacy = { people: [], reflections: [], followUps: [] };
    expect(interactionModelResultSchema.safeParse(legacy).success).toBe(false);
    expect(interactionModelResultSchema.safeParse({ ...basisResult(), schemaVersion: '2.0.0' }).success).toBe(false);
  });

  it.each(BASIS_PROMPT_EXAMPLES)('preserves basis and direct source for $id without relabeling', example => {
    const result = basisResult(example);
    expect(valid(result, example.input)).toBe(true);
    const normalized = normalizeInteractionModelResult(result);
    if (example.fields.subjectIds[0] === 'p1') {
      expect(normalized.facts).toEqual([]);
      expect(normalized.backgrounds[0]).toMatchObject({ source: example.fields.source, content: example.text });
    } else {
      expect(normalized.facts[0]).toMatchObject({ ...example.fields.personFact, source: example.fields.source,
        polarity: example.fields.polarity, content: example.text, evidence: example.input, evidenceQuotes: [example.input] });
      if (example.fields.personFact.factStatus === 'ambiguous') expect(normalized.facts[0].uncertainty).toContain(example.fields.uncertainty);
    }
    expect(normalized.reflections).toEqual([]);
  });

  it('keeps direct observation distinct from a subjective reflection and supports multiple fact targets', () => {
    const content = '我看到小岚和阿北的名牌上都写着设计师。';
    const result = basisResult({ ...BASIS_PROMPT_EXAMPLES[0], input: content });
    const statement = result.statements[0];
    statement.subjectIds = ['p2', 'p3']; statement.kind = 'fact'; statement.source = { type: 'narrator', personId: 'p1' };
    statement.text = '我看到小岚和阿北的名牌上都写着设计师。';
    statement.personFact = { type: 'fact', category: '工作', basis: 'observation', factStatus: 'candidate' };
    expect(valid(result, content)).toBe(true);
    const normalized = normalizeInteractionModelResult(result);
    expect(normalized.facts.map(item => item.personKey)).toEqual(['p2', 'p3']);
    expect(normalized.facts.every(item => item.statementId === 's1' && item.source?.personId === 'p1')).toBe(true);
    expect(normalized.reflections).toEqual([]);
  });

  it('rejects conflicting source/basis, unknown references, imported IDs, empty evidence and missing ambiguity without repair', () => {
    const example = BASIS_PROMPT_EXAMPLES[0];
    const mutations: Array<(result: InteractionModelResult) => void> = [
      result => { result.statements[0].personFact!.basis = 'third-party'; },
      result => { result.statements[0].source = { type: 'narrator', personId: 'p1' }; },
      result => { result.statements[0].source.personId = 'missing'; },
      result => { result.people[0].id = 'f1c0d050-4675-4204-928d-1e432a21b35a'; },
      result => { result.statements[0].evidence = []; },
      result => { result.statements[0].evidence = ['小岚说……最近换了工作']; },
      result => { result.statements[0].subjectIds.push('p2'); },
      result => { result.statements[0].personFact!.basis = 'observation'; },
      result => { result.statements[0].personFact!.basis = null; result.statements[0].personFact!.factStatus = 'ambiguous'; result.statements[0].uncertainty = '来源不明'; },
    ];
    for (const mutate of mutations) {
      const result = structuredClone(basisResult()); mutate(result);
      const before = structuredClone(result);
      expect(valid(result, example.input)).toBe(false);
      expect(result).toEqual(before);
    }
  });

  it('requires each quote, alias and time to occur within title or content without stitching across them', () => {
    const example = BASIS_PROMPT_EXAMPLES[0];
    const result = basisResult();
    result.statements[0].evidence = [example.input, '交往\n我和'];
    expect(valid(result, example.input)).toBe(false);
    result.statements[0].evidence = [example.input]; result.people[1].aliases = ['不存在的别名'];
    expect(valid(result, example.input)).toBe(false);
    result.people[1].aliases = []; result.event = { summary: '虚构摘要', occurredAtText: '明天', evidence: [example.input] };
    expect(valid(result, example.input)).toBe(false);
    const rawQuote = basisResult(); rawQuote.people[1].evidence = [' 小岚 '];
    expect(interactionModelResultSchema.parse(rawQuote).people[1].evidence).toEqual([' 小岚 ']);
    expect(valid(rawQuote, example.input)).toBe(false);
  });

  it('normalizes the three destinations, pending responsibility and unassigned context with every source preserved', () => {
    const content = '我觉得小岚这次很周到。小岚说：我最近很累。我答应下周五给小岚发资料。小岚已经把照片发给我。小岚没有答应借车。还没决定一起旅行。';
    const result = basisResult({ ...BASIS_PROMPT_EXAMPLES[0], input: content });
    const base = result.statements[0];
    const narrator = { type: 'narrator', personId: 'p1' } as const;
    result.statements = [
      { ...base, text: '小岚说自己最近很累。', evidence: ['小岚说：我最近很累'], personFact: { type: 'current-state', category: '情绪近况', basis: 'self-reported', factStatus: 'candidate' } },
      { ...base, id: 's2', kind: 'observation', destination: 'reflection', source: narrator, text: '我觉得小岚这次很周到。', evidence: ['我觉得小岚这次很周到'], personFact: null,
        reflection: { type: 'hypothesis', perspective: narrator, temporalScope: 'this-interaction' } },
      { ...base, id: 's3', subjectIds: ['p1', 'p2'], kind: 'fact', destination: 'followUp', source: narrator, text: '我答应下周五给小岚发资料。', evidence: ['我答应下周五给小岚发资料'], personFact: null,
        followUp: { type: 'promise', responsibility: 'me', responsiblePersonIds: ['p1'], dueAtText: '下周五', status: 'pending' } },
      { ...base, id: 's4', kind: 'fact', destination: 'unassigned', source: narrator, text: '小岚已经把照片发给我。', evidence: ['小岚已经把照片发给我'], personFact: null, classificationReason: '已经完成的经过保留交往语境，不再生成待办。' },
      { ...base, id: 's5', destination: 'unassigned', text: '小岚没有答应借车。', evidence: ['小岚没有答应借车'], polarity: 'negated', personFact: null },
      { ...base, id: 's6', kind: 'fact', destination: 'unassigned', source: narrator, text: '还没决定一起旅行。', evidence: ['还没决定一起旅行'], polarity: 'uncertain', uncertainty: '计划未决定。', personFact: null },
    ];
    expect(valid(result, content)).toBe(true);
    const normalized = normalizeInteractionModelResult(result);
    expect(normalized.facts).toHaveLength(1); expect(normalized.reflections).toHaveLength(1); expect(normalized.followUps).toHaveLength(1);
    expect(normalized.facts[0].type).toBe('current-state');
    expect(normalized.reflections[0]).toMatchObject({ perspective: narrator, temporalScope: 'this-interaction' });
    expect(normalized.followUps[0]).toMatchObject({ responsibility: 'me', responsiblePersonKeys: ['p1'], status: 'pending', dueAtText: '下周五' });
    expect(normalized.followUps[0]).not.toHaveProperty('dueDate');
    expect(normalized.backgrounds).toHaveLength(3);
    expect(normalized.backgrounds[0].classificationReason).toContain('已经完成');
    for (const polarity of ['negated', 'uncertain'] as const) {
      const invalid = structuredClone(result); invalid.statements[2].polarity = polarity; invalid.statements[2].uncertainty = '尚未确定';
      expect(valid(invalid, content)).toBe(false);
    }
  });

  it('preserves unknown responsibility and detached ambiguities while rejecting guesses and inference as facts', () => {
    const content = '我和小岚聊到下周要寄资料，但没记清谁负责。另有一个代词“她”不知道指谁。';
    const result = basisResult({ ...BASIS_PROMPT_EXAMPLES[0], input: content });
    const statement = result.statements[0];
    statement.destination = 'followUp'; statement.subjectIds = ['p2']; statement.source = { type: 'unknown', personId: null };
    statement.personFact = null; statement.uncertainty = '没记清谁负责。';
    statement.followUp = { type: 'plan', responsibility: 'unknown', responsiblePersonIds: [], dueAtText: '下周', status: 'unclear' };
    result.ambiguities = [{ id: 'a1', text: '来源和负责人不明。', evidence: [content], candidatePersonIds: ['p1', 'p2'] },
      { id: 'a2', text: '无法判断她是谁。', evidence: ['另有一个代词“她”不知道指谁'], candidatePersonIds: [] }];
    // A separate narrower quote avoids treating the detached ambiguity as a related one.
    statement.evidence = ['我和小岚聊到下周要寄资料，但没记清谁负责'];
    result.ambiguities[0].evidence = statement.evidence;
    expect(valid(result, content)).toBe(true);
    const normalized = normalizeInteractionModelResult(result);
    expect(normalized.followUps[0]).toMatchObject({ responsibility: 'unknown', responsiblePersonKeys: [], status: 'unclear', source: { type: 'unknown', personId: null } });
    expect(normalized.followUps[0].uncertainty).toContain('来源和负责人不明');
    expect(normalized.backgrounds[0]).toMatchObject({ content: '无法判断她是谁。', uncertainty: '无法判断她是谁。' });
    const guessed = structuredClone(result); guessed.statements[0].followUp!.responsiblePersonIds = ['p2'];
    expect(valid(guessed, content)).toBe(false);
    const inference = basisResult(); inference.statements[0].kind = 'inference'; inference.statements[0].source = { type: 'model', personId: null };
    inference.statements[0].polarity = 'uncertain'; inference.statements[0].uncertainty = '模型推断，存在其他解释。';
    expect(valid(inference, BASIS_PROMPT_EXAMPLES[0].input)).toBe(false);
  });

  it('keeps multiple quotes separate and never invents a joined evidence quotation', () => {
    const example = BASIS_PROMPT_EXAMPLES[0]; const result = basisResult();
    result.statements[0].evidence = ['我和小岚聊天', '小岚告诉我：我最近换了工作'];
    expect(valid(result, example.input)).toBe(true);
    const normalized = normalizeInteractionModelResult(result);
    expect(normalized.facts[0].evidenceQuotes).toEqual(result.statements[0].evidence);
    expect(normalized.facts[0].evidence).toBe('我和小岚聊天');
    expect(validateAnalysisEvidence(normalized, { title: '虚构交往', content: example.input })).toBe(true);
    normalized.facts[0].evidenceQuotes!.push('原文没有');
    expect(validateAnalysisEvidence(normalized, { title: '虚构交往', content: example.input })).toBe(false);
  });

  it('preserves nested viewpoint holders and model hypotheses without turning them into user feelings or facts', () => {
    const content = '我听阿北转述：小岚觉得小陆可靠。小陆这次没有说话。';
    const result = basisResult({ ...BASIS_PROMPT_EXAMPLES[0], input: content });
    result.people.push({ id: 'p4', label: '小陆', aliases: [], participation: 'participant', isNarrator: false, evidence: ['小陆'], uncertainty: null });
    const original = result.statements[0];
    result.statements = [{ ...original, subjectIds: ['p4'], kind: 'reported', source: { type: 'person', personId: 'p3' },
      destination: 'reflection', personFact: null, text: '阿北转述小岚觉得小陆可靠。', uncertainty: '这是小岚的观点，由阿北转述，尚未向小岚确认。',
      reflection: { type: 'hypothesis', perspective: { type: 'person', personId: 'p2' }, temporalScope: 'unclear' } },
    { ...original, id: 's2', subjectIds: ['p2', 'p4'], kind: 'inference', source: { type: 'model', personId: null }, polarity: 'uncertain',
      destination: 'reflection', personFact: null, text: '模型提出：两人这次可能较为安静。', uncertainty: '仅是模型推断，也可能只是本次对话较少。',
      reflection: { type: 'hypothesis', perspective: { type: 'model', personId: null }, temporalScope: 'this-interaction' } }];
    expect(valid(result, content)).toBe(true);
    const normalized = normalizeInteractionModelResult(result);
    expect(normalized.facts).toEqual([]);
    expect(normalized.reflections[0]).toMatchObject({ personKey: 'p4', source: { type: 'person', personId: 'p3' }, perspective: { type: 'person', personId: 'p2' } });
    expect(normalized.reflections.slice(1).map(item => item.personKey)).toEqual(['p2', 'p4']);
    expect(normalized.reflections.slice(1).every(item => item.source?.type === 'model' && item.perspective?.type === 'model')).toBe(true);
    const impersonated = structuredClone(result); impersonated.statements[1].reflection!.perspective = { type: 'narrator', personId: 'p1' };
    expect(valid(impersonated, content)).toBe(false);
  });

  it('preserves valid original whitespace through canonical validation and UI normalization', () => {
    const content = '我和 小岚 聊天。 小岚 告诉我：我最近换了工作。';
    const result = basisResult({ ...BASIS_PROMPT_EXAMPLES[0], input: content });
    result.people[1].evidence = [' 小岚 ']; result.people[1].aliases = [' 小岚 '];
    result.statements[0].evidence = [' 小岚 ', content];
    expect(valid(result, content)).toBe(true);
    const normalized = normalizeInteractionModelResult(result);
    expect(normalized.people[1].mention).toBe(' 小岚 ');
    expect(normalized.people[1].aliases).toEqual([' 小岚 ']);
    expect(normalized.facts[0].evidence).toBe(' 小岚 ');
    expect(normalized.facts[0].evidenceQuotes).toEqual([' 小岚 ', content]);
  });

  it('rejects overlapping long quotes before delivering a candidate whose immutable provenance cannot be saved', () => {
    const prefix = '我听小岚说她在京都工作。'; const content = prefix + 'a'.repeat(20_000 - prefix.length);
    const result = basisResult({ ...BASIS_PROMPT_EXAMPLES[0], input: content });
    result.statements[0].evidence = Array.from({ length: 6 }, (_, index) => content.slice(index));
    const originalQuotes = [...result.statements[0].evidence];
    expect(new Set(originalQuotes).size).toBe(6);
    expect(valid(result, content)).toBe(true);
    expect(() => normalizeInteractionModelResult(result)).toThrow();
    expect(result.statements[0].evidence).toEqual(originalQuotes);
  });

  it('rejects excessive related ambiguity after normalization without deleting the explanations', () => {
    const example = BASIS_PROMPT_EXAMPLES[0]; const result = basisResult();
    result.ambiguities = Array.from({ length: 31 }, (_, index) => ({
      id: `a${index + 1}`, text: `${index + 1}:unresolved ${'a'.repeat(3000)}`.slice(0, 3000),
      evidence: [example.input], candidatePersonIds: ['p2'],
    }));
    expect(valid(result, example.input)).toBe(true);
    const original = structuredClone(result);
    expect(() => normalizeInteractionModelResult(result)).toThrow();
    expect(result).toEqual(original);
  });

  it.each(['facts', 'reflections', 'followUps'] as const)('enforces the shared persistence budget on each %s candidate', collection => {
    const content = '小岚' + 'a'.repeat(19_998);
    const common = { evidence: content, evidenceQuotes: Array.from({ length: 6 }, (_, index) => content.slice(index)) };
    const result = interactionAnalysisSchema.parse(candidate);
    result.facts = []; result.reflections = []; result.followUps = [];
    const entries = {
      facts: { personKey: 'p2', type: 'fact' as const, content: '小岚说她在京都工作。', category: '工作', basis: 'self-reported' as const, factStatus: 'candidate' as const, ...common },
      reflections: { personKey: 'p2', type: 'feeling' as const, content: '我这次感觉轻松。', ...common },
      followUps: { personKeys: ['p1', 'p2'], type: 'plan' as const, title: '发资料', details: '我给小岚发资料。', responsibility: 'me' as const, ...common },
    };
    const item = entries[collection];
    expect(JSON.stringify(item).length).toBeGreaterThan(INTERACTION_ANALYSIS_CANDIDATE_BUDGET);
    const parsed = interactionAnalysisSchema.safeParse({ ...result, [collection]: [item] });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.some(issue => issue.path[0] === collection && issue.path[1] === 0)).toBe(true);
    expect(item.evidenceQuotes).toEqual(common.evidenceQuotes);
  });

  it('accepts the exact candidate budget, rejects one character more, and exempts unsaved background context', () => {
    const result = normalizeInteractionModelResult(basisResult()); const fact = result.facts[0];
    fact.uncertainty = '';
    const source = result.people.find(person => person.key === fact.source?.personId)!;
    const identityLength = JSON.stringify([...new Set([source.mention, ...(source.evidenceQuotes ?? [])])]).length;
    const remaining = INTERACTION_ANALYSIS_CANDIDATE_BUDGET - JSON.stringify(fact).length - identityLength;
    fact.uncertainty = 'a'.repeat(remaining);
    expect(JSON.stringify(fact).length + identityLength).toBe(INTERACTION_ANALYSIS_CANDIDATE_BUDGET);
    expect(interactionAnalysisSchema.safeParse(result).success).toBe(true);
    fact.uncertainty += 'a';
    expect(interactionAnalysisSchema.safeParse(result).success).toBe(false);
    result.facts = [];
    result.backgrounds = [{ personKeys: ['p2'], content: '背景仅供查看。', evidence: '小岚', uncertainty: 'a'.repeat(100_000) }];
    expect(interactionAnalysisSchema.safeParse(result).success).toBe(true);
  });

  it('rejects a short statement whose same-name source has excessive identity anchors without changing any quote', () => {
    const prefix = '我听小岚说她在京都工作。另一个小岚也在场。'; const content = prefix + 'a'.repeat(20_000 - prefix.length);
    const result = basisResult({ ...BASIS_PROMPT_EXAMPLES[0], input: content });
    result.people[1].evidence = Array.from({ length: 6 }, (_, index) => content.slice(index));
    result.people.push({ ...structuredClone(result.people[1]), id: 'p3', evidence: ['另一个小岚'] });
    result.statements[0].evidence = ['小岚说她在京都工作'];
    const before = structuredClone(result);
    expect(JSON.stringify(result.statements[0]).length).toBeLessThan(1000);
    expect(valid(result, content)).toBe(true);
    expect(new TextEncoder().encode(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(result) } }] })).byteLength).toBeLessThan(256 * 1024);
    expect(() => normalizeInteractionModelResult(result)).toThrow();
    expect(result).toEqual(before);
  });

  it('counts a repeated person separately for source, perspective and responsible roles', () => {
    const result = interactionAnalysisSchema.parse(candidate); result.reflections = []; result.followUps = [];
    result.people[1].mention = '小岚';
    result.people[1].evidenceQuotes = ['小岚', 'a'.repeat(20_000), 'b'.repeat(20_000), 'c'.repeat(10_000)];
    const source = { type: 'person' as const, personId: 'p2' };
    const reflection = { personKey: 'p2', type: 'hypothesis' as const, content: '小岚的暂时观点。', evidence: '小岚', source };
    expect(interactionAnalysisSchema.safeParse({ ...result, reflections: [reflection] }).success).toBe(true);
    expect(interactionAnalysisSchema.safeParse({ ...result, reflections: [{ ...reflection, perspective: source }] }).success).toBe(false);
    const followUp = { personKeys: ['p2'], type: 'plan' as const, title: '寄资料', details: '小岚计划寄资料。', responsibility: 'other' as const, evidence: '小岚', source };
    expect(interactionAnalysisSchema.safeParse({ ...result, followUps: [followUp] }).success).toBe(true);
    expect(interactionAnalysisSchema.safeParse({ ...result, followUps: [{ ...followUp, responsiblePersonKeys: ['p2'] }] }).success).toBe(false);
    expect(result.people[1].evidenceQuotes).toEqual(['小岚', 'a'.repeat(20_000), 'b'.repeat(20_000), 'c'.repeat(10_000)]);
  });
});
