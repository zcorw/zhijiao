import { z } from 'zod';
import { partialDateSchema } from './partial-date.js';
import { analysisSourceSchema } from './interaction-analysis-source.js';
export { analysisSourceSchema } from './interaction-analysis-source.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const quote = (max = 20_000) => z.string().min(1).max(max).regex(/\S/u);
const personKey = text(60);
/** Leave room below persisted provenance limits for labels, person names, and user clarification. */
export const INTERACTION_ANALYSIS_CANDIDATE_BUDGET = 90_000;
const metadata = {
  statementId: text(60).optional(), classificationReason: text(3000).optional(), source: analysisSourceSchema.optional(),
  uncertainty: text(130_000).nullable().optional(), evidenceQuotes: z.array(quote()).min(1).max(30).optional(),
  polarity: z.enum(['affirmed', 'negated', 'uncertain']).optional(),
};
export const interactionAnalysisRequestSchema = z.strictObject({
  title: text(300), content: z.string().trim().max(20_000), occurredOn: partialDateSchema.optional(),
});
export type InteractionAnalysisRequest = z.infer<typeof interactionAnalysisRequestSchema>;

/** Event-local candidates only; none of these keys identify a saved person. */
export const interactionAnalysisSchema = z.strictObject({
  people: z.array(z.strictObject({ key: personKey, name: text(200), mention: quote(), isSelf: z.boolean(),
    participation: z.enum(['participant', 'mentioned', 'unclear']).optional(), aliases: z.array(quote(200)).max(30).optional(),
    uncertainty: text(6000).nullable().optional(), evidenceQuotes: z.array(quote()).min(1).max(30).optional(),
  })).max(12),
  reflections: z.array(z.strictObject({
    personKey, type: z.enum(['feeling', 'hypothesis', 'experience']), content: text(3000), evidence: quote(), ...metadata,
    perspective: analysisSourceSchema.optional(), temporalScope: z.enum(['this-interaction', 'ongoing', 'unclear']).optional(),
  })).max(720),
  followUps: z.array(z.strictObject({
    personKeys: z.array(personKey).max(12).refine(keys => new Set(keys).size === keys.length),
    title: text(300), details: text(3000), type: z.enum(['promise', 'plan']),
    responsibility: z.enum(['me', 'other', 'joint', 'unknown']), dueDate: partialDateSchema.optional(), evidence: quote(), ...metadata,
    status: z.enum(['pending', 'unclear']).optional(), responsiblePersonKeys: z.array(personKey).max(12).optional(), dueAtText: quote().nullable().optional(),
  })).max(60),
  facts: z.array(z.strictObject({
    personKey, type: z.enum(['fact', 'preference', 'current-state']), content: text(3000), category: text(100_000).nullable(),
    basis: z.enum(['self-reported', 'observation', 'third-party']).nullable(), factStatus: z.enum(['candidate', 'ambiguous']),
    evidence: quote(), ...metadata,
  })).max(720).default([]),
  backgrounds: z.array(z.strictObject({
    personKeys: z.array(personKey).max(12).refine(keys => new Set(keys).size === keys.length), content: text(3000), evidence: quote(), ...metadata,
  })).max(100).default([]),
}).superRefine((value, context) => {
  const keys = new Set(value.people.map(person => person.key));
  if (keys.size !== value.people.length) context.addIssue({ code: 'custom', path: ['people'], message: '人物局部标识必须唯一' });
  if (value.people.filter(person => person.isSelf).length > 1) context.addIssue({ code: 'custom', path: ['people'], message: '只能有一个当前用户叙述者' });
  for (const [index, item] of value.reflections.entries()) {
    if (!keys.has(item.personKey)) context.addIssue({ code: 'custom', path: ['reflections', index, 'personKey'], message: '人物引用不存在' });
  }
  for (const [index, item] of value.followUps.entries()) {
    if (item.personKeys.some(key => !keys.has(key))) context.addIssue({ code: 'custom', path: ['followUps', index, 'personKeys'], message: '人物引用不存在' });
    if (item.responsiblePersonKeys?.some(key => !keys.has(key) || !item.personKeys.includes(key))) context.addIssue({ code: 'custom', path: ['followUps', index, 'responsiblePersonKeys'], message: '责任人物引用不存在或不属于事项主体' });
    if (item.personKeys.length === 0 && item.status !== 'unclear') context.addIssue({ code: 'custom', path: ['followUps', index, 'status'], message: '主体不明的事项须标记不明确' });
  }
  for (const [index, item] of value.facts.entries()) {
    if (!keys.has(item.personKey)) context.addIssue({ code: 'custom', path: ['facts', index, 'personKey'], message: '人物引用不存在' });
  }
  for (const [index, item] of value.backgrounds.entries()) {
    if (item.personKeys.some(key => !keys.has(key))) context.addIssue({ code: 'custom', path: ['backgrounds', index, 'personKeys'], message: '人物引用不存在' });
  }
  for (const [collection, items] of Object.entries({ reflections: value.reflections, followUps: value.followUps, facts: value.facts, backgrounds: value.backgrounds })) {
    for (const [index, item] of items.entries()) for (const [field, source] of Object.entries({ source: item.source, perspective: 'perspective' in item ? item.perspective : undefined })) {
      if (!source) continue;
      const invalid = source.type === 'person' ? source.personId === null || !keys.has(source.personId)
        : source.type === 'narrator' ? source.personId !== null && !value.people.some(person => person.key === source.personId && person.isSelf)
        : source.personId !== null;
      if (invalid) context.addIssue({ code: 'custom', path: [collection, index, field], message: '来源人物引用无效' });
    }
  }
  const identityBudgets = new Map(value.people.map(person => [person.key,
    JSON.stringify([...new Set([person.mention, ...(person.evidenceQuotes ?? [])])]).length,
  ]));
  for (const [collection, items] of Object.entries({ reflections: value.reflections, followUps: value.followUps, facts: value.facts })) {
    for (const [index, item] of items.entries()) {
      const roleIds = [item.source?.personId,
        ...('perspective' in item ? [item.perspective?.personId] : []),
        ...('responsiblePersonKeys' in item ? item.responsiblePersonKeys ?? [] : []),
      ];
      // Each role can repeat the same person's anchors in the saved provenance.
      const identityLength = roleIds.reduce((total, id) => total + (id ? identityBudgets.get(id) ?? 0 : 0), 0);
      // Reject the whole result instead of silently dropping or shortening immutable provenance.
      if (JSON.stringify(item).length + identityLength > INTERACTION_ANALYSIS_CANDIDATE_BUDGET) context.addIssue({
        code: 'custom', path: [collection, index], message: '候选内容与来源说明超过可完整保存的长度预算',
      });
    }
  }
});
export type InteractionAnalysis = z.infer<typeof interactionAnalysisSchema>;
export type InteractionAnalysisInput = z.input<typeof interactionAnalysisSchema>;

/** Every claimed quote must be one continuous substring of the submitted source. */
export function validateAnalysisEvidence(result: InteractionAnalysisInput, input: InteractionAnalysisRequest): boolean {
  const items = [...result.reflections, ...result.followUps, ...(result.facts ?? []), ...(result.backgrounds ?? [])];
  const quotes = [...result.people.flatMap(person => [person.mention, ...(person.evidenceQuotes ?? []), ...(person.aliases ?? [])]),
    ...items.flatMap(item => [item.evidence, ...(item.evidenceQuotes ?? [])]),
    ...result.followUps.flatMap(item => item.dueAtText ? [item.dueAtText] : [])];
  return quotes.every(quote => input.title.includes(quote) || input.content.includes(quote));
}

export * from './interaction-analysis-model.js';
export { INTERACTION_ANALYSIS_PROMPT } from './interaction-analysis-prompt.js';
