import { z } from 'zod';
import { partialDateSchema } from './partial-date.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const personKey = text(60);
export const interactionAnalysisRequestSchema = z.strictObject({
  title: text(300), content: z.string().trim().max(20_000), occurredOn: partialDateSchema.optional(),
});
export type InteractionAnalysisRequest = z.infer<typeof interactionAnalysisRequestSchema>;

/** Event-local candidates only; none of these keys identify a saved person. */
export const interactionAnalysisSchema = z.strictObject({
  people: z.array(z.strictObject({ key: personKey, name: text(200), mention: text(1000), isSelf: z.boolean() })).max(12),
  reflections: z.array(z.strictObject({
    personKey, type: z.enum(['feeling', 'hypothesis', 'experience']), content: text(3000), evidence: text(1000),
  })).max(20),
  followUps: z.array(z.strictObject({
    personKeys: z.array(personKey).min(1).max(12).refine(keys => new Set(keys).size === keys.length),
    title: text(300), details: text(3000), type: z.enum(['promise', 'plan']),
    responsibility: z.enum(['me', 'other', 'joint']), dueDate: partialDateSchema.optional(), evidence: text(1000),
  })).max(20),
}).superRefine((value, context) => {
  const keys = new Set(value.people.map(person => person.key));
  if (keys.size !== value.people.length) context.addIssue({ code: 'custom', path: ['people'], message: '人物局部标识必须唯一' });
  if (value.people.filter(person => person.isSelf).length > 1) context.addIssue({ code: 'custom', path: ['people'], message: '只能有一个当前用户叙述者' });
  for (const [index, item] of value.reflections.entries()) {
    if (!keys.has(item.personKey)) context.addIssue({ code: 'custom', path: ['reflections', index, 'personKey'], message: '人物引用不存在' });
  }
  for (const [index, item] of value.followUps.entries()) {
    if (item.personKeys.some(key => !keys.has(key))) context.addIssue({ code: 'custom', path: ['followUps', index, 'personKeys'], message: '人物引用不存在' });
  }
});
export type InteractionAnalysis = z.infer<typeof interactionAnalysisSchema>;

/** Every claimed quote must be one continuous substring of the submitted source. */
export function validateAnalysisEvidence(result: InteractionAnalysis, input: InteractionAnalysisRequest): boolean {
  const quotes = [...result.people.map(person => person.mention), ...result.reflections.map(item => item.evidence), ...result.followUps.map(item => item.evidence)];
  return quotes.every(quote => input.title.includes(quote) || input.content.includes(quote));
}
