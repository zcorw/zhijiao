import { interactionAnalysisSchema, interactionAnalysisFailureSchema, interactionAnalysisStatusSchema, validateAnalysisEvidence, partialDateSchema, type InteractionAnalysisProvider, type InteractionAnalysisFailure, type InteractionAnalysis, type InteractionAnalysisInput, type Entity, type EntityBase, type Interaction, type Person, type PersonFact, type PersonReflection, type FollowUp } from '@zhijiao/shared';
import { auth } from './auth';

type FactCandidate = InteractionAnalysis['facts'][number];
type ReflectionCandidate = InteractionAnalysis['reflections'][number];
type FollowUpCandidate = InteractionAnalysis['followUps'][number];
export type AnalysisFactDraft = Omit<FactCandidate, 'basis' | 'category'> & {
  selected: boolean; basis: PersonFact['basis'] | ''; category: string; sourceNote: string; clarified: boolean;
  readonly original: Readonly<FactCandidate>;
};
export type AnalysisReflectionDraft = ReflectionCandidate & { selected: boolean; adopted: boolean; readonly original: Readonly<ReflectionCandidate> };
export type AnalysisFollowUpDraft = Omit<FollowUpCandidate, 'dueDate'> & { selected: boolean; dueDate: string; clarified: boolean; readonly original: Readonly<FollowUpCandidate> };
export interface AnalysisDraft {
  people: Array<InteractionAnalysis['people'][number] & { selected: boolean; targetId: string; newName: string }>;
  facts: AnalysisFactDraft[];
  reflections: AnalysisReflectionDraft[];
  followUps: AnalysisFollowUpDraft[];
  backgrounds: InteractionAnalysis['backgrounds'];
}

const normalized = (value: string) => value.trim().normalize('NFKC').toLocaleLowerCase();
const provenanceSeparator = '\n\n--- 分析来源与限制 ---\n';

/** Preserve provenance independently of editable fields, including in Vue's reactive draft. */
function original<T extends object>(value: T): Readonly<T> {
  const snapshot = structuredClone(value);
  const freeze = (entry: object): void => {
    for (const child of Object.values(entry)) if (child && typeof child === 'object') freeze(child);
    Object.freeze(entry);
  };
  freeze(snapshot);
  return snapshot;
}

export function factNeedsClarification(candidate: AnalysisFactDraft): boolean {
  return candidate.original.factStatus === 'ambiguous' || candidate.factStatus === 'ambiguous'
    || candidate.original.polarity === 'uncertain' || candidate.polarity === 'uncertain'
    || ['unknown', 'model'].includes(candidate.original.source?.type ?? '') || ['unknown', 'model'].includes(candidate.source?.type ?? '')
    || candidate.original.basis !== candidate.basis
    || JSON.stringify(candidate.original.source) !== JSON.stringify(candidate.source);
}

export function reflectionNeedsAdoption(candidate: AnalysisReflectionDraft): boolean {
  // The original protocol omitted both fields; explicit new attribution must not bypass adoption.
  const prior = candidate.original.perspective ?? candidate.original.source;
  const current = candidate.perspective ?? candidate.source;
  return (prior !== undefined && prior.type !== 'narrator') || (current !== undefined && current.type !== 'narrator');
}

export function followUpNeedsClarification(candidate: AnalysisFollowUpDraft): boolean {
  return candidate.original.responsibility === 'unknown' || candidate.original.status === 'unclear'
    || candidate.responsibility === 'unknown' || candidate.status === 'unclear';
}

export function createAnalysisDraft(result: InteractionAnalysisInput, current: Entity[]): AnalysisDraft {
  const people = current.filter((entry): entry is Person => entry.kind === 'person');
  return {
    people: result.people.map(candidate => {
      const matches = people.filter(person => [person.displayName, person.fullName ?? '', ...person.aliases ?? []].some(name => normalized(name) === normalized(candidate.name)));
      return { ...candidate, selected: false, targetId: !candidate.isSelf && matches.length === 1 ? matches[0].id : '', newName: candidate.name };
    }),
    facts: (result.facts ?? []).map(candidate => ({ ...structuredClone(candidate), selected: false, basis: candidate.basis ?? '', category: candidate.category ?? '', sourceNote: '', clarified: false, original: original(candidate) })),
    reflections: result.reflections.map(candidate => ({ ...structuredClone(candidate), selected: false, adopted: false, original: original(candidate) })),
    followUps: result.followUps.map(candidate => ({ ...structuredClone(candidate), personKeys: [...candidate.personKeys], selected: false, clarified: false, dueDate: candidate.dueDate ?? '', original: original(candidate) })),
    backgrounds: structuredClone(result.backgrounds ?? []),
  };
}

function text(value: string, title: string, max: number, required = true): string {
  const trimmed = value.trim();
  if ((required && !trimmed) || trimmed.length > max) throw new Error(`${title}${trimmed ? `不能超过 ${max} 字。` : '不能为空。'}`);
  return trimmed;
}

type Provenance = { evidence: string; evidenceQuotes?: string[]; statementId?: string; classificationReason?: string; source?: { type: string; personId: string | null }; uncertainty?: string | null; polarity?: string };
function evidenceQuotes(source: Interaction, candidate: Provenance, prior: Provenance): string[] {
  const quotes = [...new Set([prior.evidence, ...(prior.evidenceQuotes ?? []), candidate.evidence, ...(candidate.evidenceQuotes ?? [])])];
  if (!quotes.length || quotes.some(quote => !quote.trim() || (!source.title.includes(quote) && !source.content.includes(quote)))) throw new Error('原文依据与这次交往不符，请重新分析或核对引文。');
  return quotes;
}
type AttributionContext = { people: AnalysisDraft['people']; targets: ReadonlyMap<string, string>; profiles: readonly Entity[] };
function personAnchors(person: AnalysisDraft['people'][number]): string[] {
  return [...new Set([person.mention, ...(person.evidenceQuotes ?? [])])].sort();
}
function sourceDescription(source: { type: string; personId: string | null }, context: AttributionContext): string {
  const person = context.people.find(entry => entry.key === source.personId);
  const name = source.type === 'narrator' || person?.isSelf ? '当前用户' : person?.name;
  const identity: string[] = [];
  const targetId = person && context.targets.get(person.key);
  if (source.type === 'person' && targetId) {
    const profile = context.profiles.find(entry => entry.id === targetId && entry.kind === 'person');
    identity.push(`已确认档案：${profile?.kind === 'person' ? profile.displayName : person?.newName}`, `档案ID：${targetId}`);
  } else if (source.type === 'person' && person) {
    const sameNames = context.people.filter(entry => !entry.isSelf && normalized(entry.name) === normalized(person.name));
    if (sameNames.length > 1) {
      const anchors = JSON.stringify(personAnchors(person));
      const matchingAnchors = sameNames.filter(entry => JSON.stringify(personAnchors(entry)) === anchors);
      identity.push(matchingAnchors.length === 1 ? `原文身份锚点：${anchors}` : `身份尚未区分的局部人物：${person.key}`);
    }
  }
  return `${source.type}${name || source.personId ? `（${[name, ...identity, source.personId ? `人物局部标识：${source.personId}` : ''].filter(Boolean).join('，')}）` : ''}`;
}
function provenanceNotes(candidate: Provenance, context: AttributionContext): string[] {
  return [
    candidate.statementId ? `陈述标识：${candidate.statementId}` : '',
    candidate.classificationReason ? `归类理由：${candidate.classificationReason}` : '',
    candidate.source ? `原分析来源：${sourceDescription(candidate.source, context)}` : '',
    candidate.uncertainty ? `不确定性：${candidate.uncertainty}` : '',
    candidate.polarity ? `陈述极性：${candidate.polarity}` : '',
  ].filter(Boolean);
}

/** Ignore transport keys only when a profile, unique name, or source anchor identifies the person. */
function attribution(note: string): string {
  return note.split('\n\n')
    .filter(part => /^(?:原分析来源|原分析视角|用户更正来源)：/u.test(part))
    .map(part => {
      const profileId = [...part.matchAll(/，档案ID：([^，）]+)/gu)].at(-1)?.[1];
      if (profileId) return normalized(`${part.match(/^[^（]+/u)?.[0]}：档案ID：${profileId}`);
      return normalized(part.replace(/（人物局部标识：[^）]*）/gu, '').replace(/，人物局部标识：[^）]*/gu, ''));
    })
    .sort().join('\n');
}

function sameAttribution(saved: string, candidate: string): boolean {
  // An unresolved local key is meaningful only in its analysis, never across saved records.
  if ([saved, candidate].some(note => note.includes('身份尚未区分的局部人物：'))) return false;
  return attribution(saved) === attribution(candidate);
}

function coversEvidence(saved: string, quotes: string[], prefix = ''): boolean {
  // A saved superset already retains every quote; a new independent quote must create a row.
  return quotes.every(quote => saved.includes(`${prefix}${quote}`));
}

function checkedCategory(value: string): string {
  const category = text(value, '事实类别', 100_000);
  if (!/[\p{L}\p{N}]/u.test(category) || /^(?:未知|不明|待确认|未分类|其他|无|unknown|null|undefined|n\/?a)$/iu.test(category)) throw new Error('请填写有实际含义的事实类别。');
  return category;
}

/** Build a single local encrypted transaction only after the user's explicit selection. */
export function buildAnalysisRecords(source: Interaction, draft: AnalysisDraft, current: Entity[], makeBase: () => EntityBase): Entity[] {
  const latest = current.find(entry => entry.id === source.id);
  if (!latest || latest.kind !== 'interaction' || latest.updatedAt !== source.updatedAt || latest.title !== source.title || latest.content !== source.content || latest.occurredOn !== source.occurredOn) {
    throw new Error('这次交往已修改或删除，请关闭窗口，重新打开交往后分析。');
  }
  if (draft.people.length > 12 || draft.facts.length > 720 || draft.reflections.length > 720 || draft.followUps.length > 60 || draft.backgrounds.length > 100 || new Set(draft.people.map(person => person.key)).size !== draft.people.length) throw new Error('分析候选数量或人物标识异常，请重新分析。');
  const records: Entity[] = [];
  const targets = new Map<string, string>();
  const newNames = new Set<string>();
  for (const person of draft.people.filter(entry => entry.selected && !entry.isSelf)) {
    if (person.targetId === 'new') {
      const displayName = text(person.newName, '新人物称呼', 200);
      if (newNames.has(normalized(displayName))) throw new Error('多个候选使用了相同的新人物称呼，请核对人物后再确认。');
      newNames.add(normalized(displayName));
      const entry: Person = { ...makeBase(), kind: 'person', displayName, status: 'active' };
      records.push(entry); targets.set(person.key, entry.id);
    } else {
      const entry = current.find(entry => entry.id === person.targetId && entry.kind === 'person');
      if (!entry) throw new Error(`请为「${person.name}」选择有效的已有档案，或确认新建人物。`);
      targets.set(person.key, entry.id);
    }
  }
  function target(key: string): string {
    const id = targets.get(key);
    if (!id) throw new Error('勾选的内容涉及尚未确认的人物，请先勾选并匹配对应人物。');
    return id;
  }
  const attributionContext: AttributionContext = { people: draft.people, targets, profiles: [...current, ...records] };
  for (const candidate of draft.facts.filter(entry => entry.selected)) {
    const personId = target(candidate.personKey);
    if (!['fact', 'preference', 'current-state'].includes(candidate.type)) throw new Error('请选择有效的事实细分。');
    if (!['self-reported', 'observation', 'third-party'].includes(candidate.basis)) throw new Error('请核对并填写事实来源方式；来源未知时不能默认作为观察。');
    if (factNeedsClarification(candidate) && !candidate.clarified) throw new Error('含糊事实、不确定陈述或来源更正需要手动澄清确认后才能保存。');
    const basis = candidate.basis as PersonFact['basis'];
    const content = text(candidate.content, '事实内容', 3000);
    const category = checkedCategory(candidate.category);
    const quotes = evidenceQuotes(source, candidate, candidate.original);
    const userNote = text(candidate.sourceNote, '用户补充', 3000, false);
    const sourceNote = [
      `来源交往：${source.title}`, `事实细分：${candidate.type}`, `原分析事实状态：${candidate.original.factStatus}`,
      ...provenanceNotes(candidate.original, attributionContext),
      ...quotes.map(quote => `原文依据：${quote}`),
      candidate.original.basis !== candidate.basis ? `用户更正来源方式：${candidate.original.basis ?? '未知'} → ${basis}` : '',
      JSON.stringify(candidate.original.source) !== JSON.stringify(candidate.source) ? `用户更正来源：${candidate.source ? sourceDescription(candidate.source, attributionContext) : '未知'}` : '',
      candidate.clarified ? '用户已手动核对并澄清；记录仍待确认' : '',
      userNote ? `用户补充：${userNote}` : '',
    ].filter(Boolean).join('\n\n');
    text(sourceNote, '事实来源说明及引文', 100_000);
    const duplicate = [...current, ...records].some(entry => entry.kind === 'fact' && entry.sourceInteractionId === source.id && entry.personId === personId && entry.content.trim() === content && (entry.category ?? '').trim() === category && entry.basis === basis && sameAttribution(entry.sourceNote ?? '', sourceNote) && coversEvidence(entry.sourceNote ?? '', quotes, '原文依据：'));
    if (duplicate) continue;
    const fact: PersonFact = { ...makeBase(), kind: 'fact', personId, content, category, basis, sourceInteractionId: source.id, sourceNote, status: 'unconfirmed', ...(source.occurredOn ? { learnedOn: source.occurredOn } : {}) };
    records.push(fact);
  }
  const sourceReflectionIds = new Set(current.filter(entry => entry.kind === 'reflectionLink' && entry.interactionId === source.id).map(entry => entry.kind === 'reflectionLink' ? entry.reflectionId : ''));
  for (const candidate of draft.reflections.filter(entry => entry.selected)) {
    const personId = target(candidate.personKey);
    if (!['feeling', 'hypothesis', 'experience'].includes(candidate.type)) throw new Error('请选择有效的感受或印象类型。');
    const content = text(candidate.content, '感受或印象', 3000);
    const needsAdoption = reflectionNeedsAdoption(candidate);
    if (needsAdoption && (!candidate.adopted || content === candidate.original.content.trim())) throw new Error('其他人或模型视角的感受需要显式采用，并编辑核对内容后才能成为你的主观记录。');
    const quotes = evidenceQuotes(source, candidate, candidate.original);
    const evidence = quotes.join('\n\n');
    const perspective = candidate.original.perspective ?? candidate.original.source;
    const context = [`来源交往：${source.title}`, ...provenanceNotes(candidate.original, attributionContext),
      perspective ? `原分析视角：${sourceDescription(perspective, attributionContext)}` : '',
      candidate.original.temporalScope ? `适用时间：${candidate.original.temporalScope}` : '',
      needsAdoption ? `用户已显式采用并改写。原分析表述：${candidate.original.content}` : '',
    ].filter(Boolean).join('\n\n');
    text(evidence, '感受的原文引文', 100_000);
    text(context, '感受的来源说明', 100_000);
    const duplicate = [...current, ...records].some(entry => entry.kind === 'reflection' && entry.personId === personId && entry.type === candidate.type && entry.content.trim() === content && sameAttribution(entry.context ?? '', context) && coversEvidence(entry.evidence ?? '', quotes) && (sourceReflectionIds.has(entry.id) || records.some(link => link.kind === 'reflectionLink' && link.reflectionId === entry.id)));
    if (duplicate) continue;
    const reflection: PersonReflection = { ...makeBase(), kind: 'reflection', personId, type: candidate.type, content, evidence, context, certainty: needsAdoption ? '用户显式采用并改写的分析建议；原视角不代表用户，仍为主观记录' : '经本人筛选确认的分析建议，仍为主观记录', ...(source.occurredOn ? { recordedOn: source.occurredOn } : {}), status: 'current' };
    records.push(reflection, { ...makeBase(), kind: 'reflectionLink', reflectionId: reflection.id, interactionId: source.id, relationType: 'arose', explanation: evidence });
  }
  for (const candidate of draft.followUps.filter(entry => entry.selected)) {
    const keys = [...new Set([...candidate.personKeys, ...(candidate.responsiblePersonKeys ?? [])])];
    if (keys.some(key => !draft.people.some(person => person.key === key))) throw new Error('事项引用的人物不完整，请重新分析。');
    const personIds = [...new Set(keys.filter(key => !draft.people.find(person => person.key === key)!.isSelf).map(target))];
    if (!personIds.length) throw new Error('事项至少需要确认一位其他人物；“我”默认是当前用户。');
    const title = text(candidate.title, '事项标题', 300);
    const details = text(candidate.details, '事项细节', 3000, false);
    const quotes = evidenceQuotes(source, candidate, candidate.original);
    const dueDate = candidate.dueDate.trim();
    if (dueDate && (!partialDateSchema.safeParse(dueDate).success || dueDate.startsWith('--'))) throw new Error('事项期限请填写带年份的有效日期，可精确到年、月或日。');
    if (!['promise', 'plan'].includes(candidate.type) || !['me', 'other', 'joint'].includes(candidate.responsibility)) throw new Error('请选择有效的事项类型与责任。');
    if (followUpNeedsClarification(candidate) && !candidate.clarified) throw new Error('责任未知或含糊的事项需要明确责任并手动澄清确认。');
    const detailContent = [details, ...quotes.map(quote => `原文依据：${quote}`)].filter(Boolean).join('\n\n');
    const notes = [...provenanceNotes(candidate.original, attributionContext),
      candidate.original.dueAtText ? `原文时间表达（未经自动换算）：${candidate.original.dueAtText}` : '',
      candidate.original.responsiblePersonKeys?.length ? `原分析责任人物：${candidate.original.responsiblePersonKeys.map(key => sourceDescription({ type: draft.people.find(person => person.key === key)?.isSelf ? 'narrator' : 'person', personId: key }, attributionContext)).join('、')}` : '',
      followUpNeedsClarification(candidate) ? `用户已澄清责任：${candidate.responsibility}；原责任：${candidate.original.responsibility}；原状态：${candidate.original.status ?? '未标注'}` : '',
    ].filter(Boolean);
    const savedDetails = detailContent + (notes.length ? provenanceSeparator + notes.join('\n\n') : '');
    text(savedDetails, '事项细节及来源说明', 100_000);
    const duplicate = [...current, ...records].some(entry => entry.kind === 'followUp' && entry.sourceInteractionId === source.id && entry.title.trim() === title && (entry.details ?? '').split(provenanceSeparator)[0].trim() === detailContent && sameAttribution((entry.details ?? '').split(provenanceSeparator)[1] ?? '', notes.join('\n\n')) && entry.type === candidate.type && entry.responsibility === candidate.responsibility && (entry.dueDate ?? '') === dueDate && [...entry.personIds].sort().join(',') === [...personIds].sort().join(','));
    if (duplicate) continue;
    const followUp: FollowUp = { ...makeBase(), kind: 'followUp', title, details: savedDetails, personIds, type: candidate.type, responsibility: candidate.responsibility as FollowUp['responsibility'], sourceInteractionId: source.id, ...(dueDate ? { dueDate } : {}), status: 'pending' };
    records.push(followUp);
  }
  if (!records.length) throw new Error('没有需要新增的内容。请选择条目；相同交往中已保存的相同内容会自动跳过。');
  // Each new person also creates its encrypted directory entry in VaultClient.
  if (records.length + records.filter(entry => entry.kind === 'person').length > 100) throw new Error('本次选择内容过多，请减少条目后重试。');
  return records;
}

const unidentifiedAnalysisFailure = '分析服务返回502，未提供可识别原因，请检查应用与代理日志。';
const failureBodyMaxBytes = 4096;
const failureBodyTimeoutMs = 2000;

/** Read only a small, bounded diagnostic envelope; never expose provider text. */
async function readAnalysisFailure(response: Response, signal?: AbortSignal): Promise<InteractionAnalysisFailure | undefined> {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  if (response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json' || !response.body) return;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = response.body.getReader(); } catch { return; }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let stopReading = () => {};
  const stopped = new Promise<undefined>(resolve => { stopReading = () => resolve(undefined); });
  const deadline = Date.now() + failureBodyTimeoutMs;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let finished = false;
  try {
    timeout = setTimeout(stopReading, failureBodyTimeoutMs);
    signal?.addEventListener('abort', stopReading, { once: true });
    if (signal?.aborted) stopReading();
    let bytes = 0;
    let json = '';
    while (Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), stopped]);
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      if (Date.now() >= deadline) return;
      if (!chunk) return;
      if (chunk.done) {
        finished = true;
        json += decoder.decode();
        const parsed = interactionAnalysisFailureSchema.safeParse(JSON.parse(json));
        return parsed.success ? parsed.data : undefined;
      }
      bytes += chunk.value.byteLength;
      if (bytes > failureBodyMaxBytes) return;
      json += decoder.decode(chunk.value, { stream: true });
    }
  } catch {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', stopReading);
    // Do not let an unresponsive stream's cancellation extend the read deadline.
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function analysisFailureMessage(failure: InteractionAnalysisFailure | undefined): string {
  if (!failure) return unidentifiedAnalysisFailure;
  const diagnostic = [failure.code, failure.reason,
    failure.reason === 'UPSTREAM_HTTP' && failure.upstreamStatus !== undefined ? `HTTP ${failure.upstreamStatus}` : '',
    failure.reason === 'MODEL_SCHEMA' && failure.issueCount !== undefined ? `校验问题数：${failure.issueCount}` : '',
  ].filter(Boolean).join(' / ');
  if (failure.code === 'AI_TIMEOUT' || failure.reason === 'TIMEOUT') {
    return `应用分析超时${failure.timeoutMs === undefined ? '' : `（配置上限 ${failure.timeoutMs / 1000} 秒）`}，请联系管理员核对分析超时配置。（${diagnostic}）`;
  }
  if (!failure.reason) return `应用分析失败，服务尚未细分失败原因，请向管理员提供括号内诊断码，并升级服务或核对运行配置。（${diagnostic}）`;
  let message: string;
  if (failure.reason === 'UPSTREAM_HTTP') {
    const status = failure.upstreamStatus;
    if (status === 401) message = 'AI 供应商拒绝认证，请联系管理员检查 API 密钥及权限。';
    else if (status === 403) message = 'AI 供应商拒绝访问，请联系管理员检查 API 密钥及权限、服务可用地区。';
    else if (status === 402) message = 'AI 供应商账户余额或额度不足，请联系管理员检查账单与可用额度。';
    else if (status === 429) message = 'AI 供应商返回限流或额度错误。请稍后重试，或联系管理员检查 API 余额及额度。';
    else if (status === 400 || status === 404) message = 'AI 供应商拒绝当前模型或请求参数，请联系管理员检查模型名称、接口地址及参数。';
    else if (status !== undefined && status >= 500) message = 'AI 供应商服务异常，请稍后重试或联系管理员。';
    else message = 'AI 供应商返回异常状态，请联系管理员检查上游请求。';
  } else {
    const messages: Record<Exclude<NonNullable<InteractionAnalysisFailure['reason']>, 'UPSTREAM_HTTP' | 'TIMEOUT'>, string> = {
      UPSTREAM_NETWORK: '应用无法连接 AI 供应商，请联系管理员检查供应商地址及网络连接。',
      RESPONSE_TOO_LARGE: 'AI 供应商返回内容过大，应用已停止读取，请联系管理员检查响应大小限制。',
      RESPONSE_INVALID_JSON: 'AI 供应商接口未返回有效 JSON，请联系管理员检查接口地址及供应商响应格式。',
      RESPONSE_INVALID: 'AI 供应商接口响应结构不完整或格式不受支持，请联系管理员检查接口兼容性。',
      OUTPUT_INCOMPLETE: 'AI 模型输出被截断或未完成，请联系管理员检查输出长度限制。',
      OUTPUT_REFUSED: 'AI 服务拒绝生成这次分析。请核对交往内容后再试。',
      OUTPUT_INVALID_JSON: 'AI 模型输出不是有效 JSON，请联系管理员检查模型输出格式。',
      MODEL_SCHEMA: 'AI 模型输出未通过分析结构校验，请联系管理员检查分析协议与模型兼容性。',
      MODEL_EVIDENCE: 'AI 模型输出中的原文依据无法与这次交往对应，请核对原文，并向管理员提供括号内诊断码。',
      MODEL_SEMANTICS: 'AI 模型输出中的人物来源或语义关系不符合分析规则，请核对原文，并向管理员提供括号内诊断码。',
      CANDIDATE_BUDGET: 'AI 模型输出的候选及来源依据过长，无法完整保存，请缩短或拆分交往正文后重新分析。',
      NORMALIZATION: '应用整理分析结果时失败，请向管理员提供括号内诊断码并核对运行配置。',
      INTERNAL: '应用处理分析时发生内部错误，请向管理员提供括号内诊断码并核对运行配置。',
    };
    message = messages[failure.reason];
  }
  return `${message}（${diagnostic}）`;
}

export class AnalysisProviderChangedError extends Error {
  constructor() { super('分析服务已切换。请核对新的接收方，再开始分析。'); }
}

async function analysisCall(path: 'status' | 'interaction', options: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/analysis/${path}`, { ...options, credentials: 'same-origin' });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new Error('无法连接分析服务，请检查网络后重试。');
  }
  if (!response.ok) {
    if (path === 'interaction' && response.status === 409) throw new AnalysisProviderChangedError();
    if (response.status === 502) throw new Error(analysisFailureMessage(await readAnalysisFailure(response, options.signal ?? undefined)));
    const messages: Record<number, string> = { 400: '交往内容过长或格式不正确，请将标题控制在 300 字、正文控制在 20000 字内。', 401: '登录会话已失效，请重新登录后分析。', 403: '登录验证已失效，请重新登录后分析。', 429: '分析正在进行或请求过于频繁，请稍后重试。', 503: '分析服务尚未配置，请联系管理员配置 AI 服务。', 504: '网关等待分析超时，分析可能仍在进行。请联系管理员延长网关等待时间，暂勿重复提交。' };
    throw new Error(messages[response.status] ?? '分析未完成或返回内容不合要求，请重试。');
  }
  return response.json();
}

export async function analysisAvailability(signal?: AbortSignal) {
  const result = interactionAnalysisStatusSchema.safeParse(await analysisCall('status', { method: 'GET', signal }));
  if (!result.success) throw new Error('分析服务状态异常，请重试。');
  return result.data;
}

export async function requestInteractionAnalysis(record: Interaction, provider: InteractionAnalysisProvider, signal?: AbortSignal): Promise<InteractionAnalysis> {
  const value = await analysisCall('interaction', {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', 'x-csrf-token': auth.csrfToken(), 'x-interaction-ai-provider': provider },
    body: JSON.stringify({ title: record.title, content: record.content, ...(record.occurredOn ? { occurredOn: record.occurredOn } : {}) }),
  });
  const result = interactionAnalysisSchema.safeParse(value);
  if (!result.success) throw new Error('分析返回的内容不完整，请重试。');
  if (!validateAnalysisEvidence(result.data, record)) throw new Error('分析返回的原文依据与这次交往不符，请重试。');
  return result.data;
}
