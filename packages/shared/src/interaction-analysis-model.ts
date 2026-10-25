import { z } from 'zod';
import { interactionAnalysisSchema, type InteractionAnalysis, type InteractionAnalysisRequest } from './interaction-analysis.js';
import { analysisSourceSchema } from './interaction-analysis-source.js';

export const INTERACTION_ANALYSIS_SCHEMA_VERSION = '3.0.0' as const;
const text = (max = 3000) => z.string().min(1).max(max);
const nullableText = text().nullable();
const ids = z.array(text(60)).max(12);
const evidence = z.array(text(20_000)).max(30);

/** Canonical model output. It deliberately has no defaults or repair transforms. */
export const interactionModelResultSchema = z.strictObject({
  schemaVersion: z.literal(INTERACTION_ANALYSIS_SCHEMA_VERSION),
  event: z.strictObject({ summary: nullableText, occurredAtText: text(20_000).nullable(), evidence }),
  people: z.array(z.strictObject({
    id: text(60), label: text(200), aliases: z.array(text(200)).max(30),
    participation: z.enum(['participant', 'mentioned', 'unclear']), isNarrator: z.boolean(), evidence, uncertainty: nullableText,
  })).max(12),
  statements: z.array(z.strictObject({
    id: text(60), subjectIds: ids, kind: z.enum(['fact', 'reported', 'observation', 'inference']), text: text(),
    polarity: z.enum(['affirmed', 'negated', 'uncertain']), source: analysisSourceSchema, evidence, uncertainty: nullableText,
    destination: z.enum(['reflection', 'followUp', 'personFact', 'unassigned']), classificationReason: text(), reviewStatus: z.literal('pending'),
    reflection: z.strictObject({
      type: z.enum(['feeling', 'hypothesis', 'experience']), perspective: analysisSourceSchema,
      temporalScope: z.enum(['this-interaction', 'ongoing', 'unclear']),
    }).nullable(),
    followUp: z.strictObject({
      type: z.enum(['promise', 'plan']), responsibility: z.enum(['me', 'other', 'joint', 'unknown']), responsiblePersonIds: ids,
      dueAtText: text(20_000).nullable(), status: z.enum(['pending', 'unclear']),
    }).nullable(),
    personFact: z.strictObject({
      type: z.enum(['fact', 'preference', 'current-state']), category: text(100_000).nullable(),
      basis: z.enum(['self-reported', 'observation', 'third-party']).nullable(), factStatus: z.enum(['candidate', 'ambiguous']),
    }).nullable(),
  })).max(60),
  ambiguities: z.array(z.strictObject({ id: text(60), text: text(), evidence, candidatePersonIds: ids })).max(40),
});
export type InteractionModelResult = z.infer<typeof interactionModelResultSchema>;
type StatementCandidate = InteractionModelResult['statements'][number];
export interface InteractionModelValidationReport {
  schemaValid: boolean; citationsValid: boolean; referencesValid: boolean;
  issues: string[]; quoteCount: number; validQuoteCount: number;
}
/** Shared with the prompt; local cross-field checks still run after structural validation. */
export const INTERACTION_ANALYSIS_MODEL_SCHEMA = z.toJSONSchema(interactionModelResultSchema);

const nonempty = (value: string | null): value is string => typeof value === 'string' && value.trim().length > 0;

/** Mechanical checks migrated from the validated v3 laboratory protocol. They cannot prove meaning or truth. */
export function validateInteractionModelResult(value: unknown, input: InteractionAnalysisRequest): InteractionModelValidationReport {
  const parsed = interactionModelResultSchema.safeParse(value);
  const report: InteractionModelValidationReport = {
    schemaValid: false, citationsValid: false, referencesValid: false, issues: [], quoteCount: 0, validQuoteCount: 0,
  };
  if (!parsed.success) {
    report.issues = parsed.error.issues.map(issue => `schema ${issue.path.join('.')} ${issue.code}`);
    return report;
  }
  const candidate = parsed.data;
  const hasQuote = (quote: string) => input.title.includes(quote) || input.content.includes(quote);
  const version = INTERACTION_ANALYSIS_SCHEMA_VERSION;
  // The remaining mechanical rules are intentionally equivalent to the laboratory's v3 protocol.
  return validateModelSemantics(candidate, hasQuote, version, report);
}

function validateModelSemantics(candidate: InteractionModelResult, hasQuote: (quote: string) => boolean, version: '3.0.0', report: InteractionModelValidationReport): InteractionModelValidationReport {
  report.schemaValid = true;
  report.citationsValid = true;
  report.referencesValid = true;
  const semantic = (message: string) => {
    report.referencesValid = false;
    report.issues.push(message);
  };
  const citations = (quotes: string[], path: string, required = true) => {
    if (required && quotes.length === 0) {
      report.citationsValid = false;
      report.issues.push(`${path}: 缺少原文引用`);
    }
    for (const [index, quote] of quotes.entries()) {
      report.quoteCount++;
      if (nonempty(quote) && hasQuote(quote)) report.validQuoteCount++;
      else {
        report.citationsValid = false;
        report.issues.push(`${path}[${index}]: 引用为空或不在输入中`);
      }
    }
  };
  const unique = (values: string[], path: string) => {
    if (new Set(values).size !== values.length) semantic(`${path}: ID 重复`);
  };
  const people = new Map(candidate.people.map(person => [person.id, person]));
  unique(candidate.people.map(person => person.id), 'people');
  unique(candidate.statements.map(statement => statement.id), 'statements');
  unique(candidate.ambiguities.map(ambiguity => ambiguity.id), 'ambiguities');
  const refs = (ids: string[], path: string) => {
    unique(ids, path);
    for (const id of ids) if (!people.has(id)) semantic(`${path}: 未知人物 ${id}`);
  };
  if (candidate.people.filter(person => person.isNarrator).length > 1) semantic('people: 只能有一个第一人称叙述者');
  citations(candidate.event.evidence, 'event.evidence', candidate.event.summary !== null || candidate.event.occurredAtText !== null);
  if (candidate.event.summary !== null && !nonempty(candidate.event.summary)) semantic('event.summary: 空值应使用 null');
  if (candidate.event.occurredAtText !== null && (!nonempty(candidate.event.occurredAtText) || !hasQuote(candidate.event.occurredAtText))) {
    semantic('event.occurredAtText: 必须是原文时间文字或 null');
  }
  for (const person of candidate.people) {
    if (!/^p[1-9]\d*$/.test(person.id)) semantic(`people.${person.id}: 需要事件局部 ID p1、p2……`);
    if (!nonempty(person.label)) semantic(`people.${person.id}: label 不能为空`);
    if (person.participation === 'unclear' && !nonempty(person.uncertainty)) semantic(`people.${person.id}: 不明确参与情况需要 uncertainty`);
    unique(person.aliases, `people.${person.id}.aliases`);
    for (const alias of person.aliases) if (!nonempty(alias) || !hasQuote(alias)) semantic(`people.${person.id}.aliases: 别名必须出现在原文`);
    citations(person.evidence, `people.${person.id}.evidence`);
  }
  for (const statement of candidate.statements) {
    const path = `statements.${statement.id}`;
    if (!/^s[1-9]\d*$/.test(statement.id)) semantic(`${path}: 需要事件局部 ID s1、s2……`);
    if (!nonempty(statement.text)) semantic(`${path}: text 不能为空`);
    refs(statement.subjectIds, `${path}.subjectIds`);
    if (statement.subjectIds.length === 0 && !nonempty(statement.uncertainty)) semantic(`${path}: 未知主体需要 uncertainty`);
    const source = statement.source;
    if (source.type === 'person') {
      if (source.personId === null || !people.has(source.personId)) semantic(`${path}.source: person 来源必须引用已知人物`);
    } else if (source.type === 'narrator') {
      if (source.personId !== null && !people.get(source.personId)?.isNarrator) semantic(`${path}.source: narrator 必须引用叙述者或 null`);
    } else if (source.personId !== null) semantic(`${path}.source: unknown/model 的 personId 必须为 null`);
    if (statement.kind === 'fact' && source.type !== 'narrator') semantic(`${path}: fact 只允许叙述者直接叙述`);
    if (statement.kind === 'reported' && !['person', 'unknown'].includes(source.type)) semantic(`${path}: reported 需要 person/unknown 来源`);
    if (statement.kind === 'reported' && source.type === 'unknown' && !nonempty(statement.uncertainty)) semantic(`${path}: 未知说话人需要 uncertainty`);
    if (statement.kind === 'observation' && !['narrator', 'person'].includes(source.type)) semantic(`${path}: observation 必须标明观点来源`);
    if (statement.kind === 'inference') {
      if (source.type !== 'model' || statement.polarity !== 'uncertain' || !nonempty(statement.uncertainty)) semantic(`${path}: inference 必须是模型来源、不确定且有 uncertainty`);
    } else if (source.type === 'model') semantic(`${path}: model 来源只能用于 inference`);
    if (statement.polarity === 'uncertain' && !nonempty(statement.uncertainty)) semantic(`${path}: uncertain 需要 uncertainty`);
    if (version === '3.0.0') {
      const current = statement as StatementCandidate;
      if (!nonempty(current.classificationReason) || current.classificationReason.length > 3000) semantic(path + '.classificationReason: 必须说明归类原因，长度不超过3000');
      const active = (['reflection', 'followUp', 'personFact'] as const).filter(key => current[key] !== null);
      if (current.destination === 'unassigned' ? active.length !== 0 : active.length !== 1 || active[0] !== current.destination) semantic(path + ': destination 必须且只能启用对应载荷；unassigned 的三个载荷均为 null');
      const relatedAmbiguity = () => candidate.ambiguities.some(ambiguity => ambiguity.evidence.some(quote => nonempty(quote) && current.evidence.some(evidence => nonempty(evidence) && (quote.includes(evidence) || evidence.includes(quote)))));
      if (current.kind === 'inference' && !['reflection', 'unassigned'].includes(current.destination)) semantic(path + ': 模型推断只能进入主观推测或待澄清，不能变成事实或事项');
      if (current.reflection !== null) {
        const detail = current.reflection; const viewpoint = detail.perspective;
        if (!['observation', 'reported', 'inference'].includes(current.kind)) semantic(path + '.reflection: 主观感受与印象不能标成客观 fact');
        if (viewpoint.type === 'person') {
          if (viewpoint.personId === null || !people.has(viewpoint.personId)) semantic(path + '.reflection.perspective: person 必须引用已知观点持有者');
        } else if (viewpoint.type === 'narrator') {
          const narrator = candidate.people.find(person => person.isNarrator);
          if ((viewpoint.personId !== null && !people.get(viewpoint.personId)?.isNarrator) || (narrator && viewpoint.personId !== narrator.id)) semantic(path + '.reflection.perspective: 已提取叙述者时必须指向该当前用户，不能以 null 丢失归属');
        } else if (viewpoint.personId !== null) semantic(path + '.reflection.perspective: unknown/model 的 personId 必须为 null');
        if (current.kind === 'inference' && (detail.type !== 'hypothesis' || viewpoint.type !== 'model')) semantic(path + '.reflection: 模型推断必须是 hypothesis 且观点来自 model，不能冒充用户感受');
        if (viewpoint.type === 'model' && current.kind !== 'inference') semantic(path + '.reflection: model 观点只能用于 inference');
        if (current.kind === 'observation' && (viewpoint.type !== source.type || viewpoint.personId !== source.personId)) semantic(path + '.reflection: 直接主观观察须保持 source 与观点持有者一致');
        if ((viewpoint.type === 'unknown' || detail.temporalScope === 'unclear' || current.kind === 'reported') && !nonempty(current.uncertainty)) semantic(path + '.reflection: 观点归属、时间范围不明或转述印象须保留 uncertainty');
      }
      if (current.followUp !== null) {
        const detail = current.followUp;
        if (!['fact', 'reported'].includes(current.kind) || current.polarity !== 'affirmed') semantic(path + '.followUp: 只有原文明示且肯定的未完成承诺/计划可成为事项；否定、推断、未决定或已完成事件不得转成待办');
        refs(detail.responsiblePersonIds, path + '.followUp.responsiblePersonIds');
        if (detail.responsiblePersonIds.some(id => !current.subjectIds.includes(id))) semantic(path + '.followUp: 责任人须同时属于 subjectIds');
        const narrators = detail.responsiblePersonIds.filter(id => people.get(id)?.isNarrator);
        const others = detail.responsiblePersonIds.filter(id => people.has(id) && !people.get(id)?.isNarrator);
        if (detail.responsibility === 'me' && (detail.responsiblePersonIds.length !== 1 || narrators.length !== 1)) semantic(path + '.followUp: me 必须唯一指向当前用户叙述者');
        if (detail.responsibility === 'other' && (others.length === 0 || narrators.length !== 0)) semantic(path + '.followUp: other 必须明确指向其他人物');
        if (detail.responsibility === 'joint' && (narrators.length !== 1 || others.length === 0)) semantic(path + '.followUp: joint 须同时包含当前用户和其他责任人');
        if (detail.responsibility === 'unknown' && (detail.status !== 'unclear' || detail.responsiblePersonIds.length !== 0)) semantic(path + '.followUp: unknown 责任只能保留 unclear 状态和空责任人');
        if ((source.type === 'unknown' || current.subjectIds.length === 0) && detail.status !== 'unclear') semantic(path + '.followUp: 来源或主体不明的事项必须为 unclear，不能作为普通待办');
        if (detail.status === 'unclear' && (!nonempty(current.uncertainty) || !relatedAmbiguity())) semantic(path + '.followUp: unclear 事项须说明不确定性并有相关原文的歧义条目');
        if (detail.dueAtText !== null && (!nonempty(detail.dueAtText) || !hasQuote(detail.dueAtText))) semantic(path + '.followUp.dueAtText: 期限必须是连续逐字原文或 null，不推算日期');
      }
      if (current.personFact !== null) {
        const detail = current.personFact;
        if (!['fact', 'reported'].includes(current.kind)) semantic(path + '.personFact: 主观印象和模型推断不得写作事实与偏好');
        if (detail.category !== null && (!nonempty(detail.category) || detail.category.length > 100000)) semantic(path + '.personFact.category: 类别须为非空自由文本，长度不超过100000');
        if (detail.factStatus === 'candidate') {
          if (!nonempty(detail.category) || detail.basis === null || current.subjectIds.length === 0 || source.type === 'unknown' || current.polarity === 'uncertain') semantic(path + '.personFact: candidate 须有明确类别、来源性质、主体与来源；uncertain 命题须保留 ambiguous 与歧义依据');
        } else {
          if (!nonempty(current.uncertainty) || !relatedAmbiguity()) semantic(path + '.personFact: ambiguous 须说明不确定性并有相关原文的歧义条目');
          if (detail.category !== null && detail.basis !== null && current.subjectIds.length > 0 && source.type !== 'unknown' && current.polarity !== 'uncertain') semantic(path + '.personFact: ambiguous 须保留实际未决的类别、来源、主体或命题不确定性');
        }
        if ((current.subjectIds.length === 0 || source.type === 'unknown') && detail.basis !== null) semantic(path + '.personFact.basis: 主体或来源不明时不得猜测来源性质');
        if (detail.basis === 'self-reported' && (!['person', 'narrator'].includes(source.type) || source.personId === null || current.subjectIds.length !== 1 || current.subjectIds[0] !== source.personId)) semantic(path + '.personFact.basis: 本人陈述须由唯一事实主体本人直接表达');
        if (detail.basis === 'observation' && (current.kind !== 'fact' || source.type !== 'narrator')) semantic(path + '.personFact.basis: observation 仅用于叙述者直接观察的具体事实');
        if (detail.basis === 'third-party' && (source.type !== 'person' || source.personId === null || current.subjectIds.includes(source.personId))) semantic(path + '.personFact.basis: third-party 须保留事实主体以外的明确转述者');
      }
    }
    citations(statement.evidence, `${path}.evidence`);
  }
  for (const ambiguity of candidate.ambiguities) {
    if (!/^a[1-9]\d*$/.test(ambiguity.id)) semantic(`ambiguities.${ambiguity.id}: 需要事件局部 ID a1、a2……`);
    if (!nonempty(ambiguity.text)) semantic(`ambiguities.${ambiguity.id}: text 不能为空`);
    refs(ambiguity.candidatePersonIds, `ambiguities.${ambiguity.id}.candidatePersonIds`);
    citations(ambiguity.evidence, `ambiguities.${ambiguity.id}.evidence`);
  }
  return report;
}

/** Adapt only an already validated model result. All IDs remain local candidates. */
export function normalizeInteractionModelResult(value: InteractionModelResult): InteractionAnalysis {
  const output: InteractionAnalysis = { people: value.people.map(person => ({
    key: person.id, name: person.label, mention: person.evidence[0]!, isSelf: person.isNarrator,
    participation: person.participation, aliases: person.aliases, uncertainty: person.uncertainty, evidenceQuotes: person.evidence,
  })), reflections: [], followUps: [], facts: [], backgrounds: [] };
  const isTarget = (id: string) => value.people.some(person => person.id === id && !person.isNarrator);
  const related = (statement: StatementCandidate) => value.ambiguities.filter(ambiguity => ambiguity.evidence.some(quote =>
    statement.evidence.some(evidence => quote.includes(evidence) || evidence.includes(quote))));
  const representedAmbiguities = new Set<string>();
  for (const statement of value.statements) {
    const ambiguities = related(statement);
    for (const ambiguity of ambiguities) representedAmbiguities.add(ambiguity.id);
    const uncertainty = [...new Set([statement.uncertainty, ...ambiguities.map(item => item.text)].filter((text): text is string => text !== null))].join('\n') || null;
    const common = {
      statementId: statement.id, classificationReason: statement.classificationReason, source: statement.source,
      uncertainty, evidenceQuotes: statement.evidence, polarity: statement.polarity, evidence: statement.evidence[0]!,
    };
    let assigned = false;
    if (statement.destination === 'reflection' && statement.reflection) {
      for (const personKey of statement.subjectIds.filter(isTarget)) {
        output.reflections.push({ personKey, content: statement.text, ...statement.reflection, ...common }); assigned = true;
      }
    } else if (statement.destination === 'personFact' && statement.personFact) {
      for (const personKey of statement.subjectIds.filter(isTarget)) {
        output.facts.push({ personKey, content: statement.text, ...statement.personFact, ...common }); assigned = true;
      }
    } else if (statement.destination === 'followUp' && statement.followUp) {
      const detail = statement.followUp;
      output.followUps.push({ personKeys: statement.subjectIds, title: statement.text.slice(0, 300), details: statement.text,
        type: detail.type, responsibility: detail.responsibility, responsiblePersonKeys: detail.responsiblePersonIds,
        dueAtText: detail.dueAtText, status: detail.status, ...common }); assigned = true;
    }
    if (!assigned) output.backgrounds.push({ personKeys: statement.subjectIds, content: statement.text, ...common });
  }
  for (const ambiguity of value.ambiguities) if (!representedAmbiguities.has(ambiguity.id)) output.backgrounds.push({
    personKeys: ambiguity.candidatePersonIds, content: ambiguity.text, evidence: ambiguity.evidence[0]!, evidenceQuotes: ambiguity.evidence,
    classificationReason: '原文仍需澄清，保留歧义供人工确认。', source: { type: 'unknown', personId: null }, uncertainty: ambiguity.text, polarity: 'uncertain',
  });
  return interactionAnalysisSchema.parse(output);
}
