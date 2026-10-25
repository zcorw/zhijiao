import { interactionAnalysisSchema, validateAnalysisEvidence, partialDateSchema, type InteractionAnalysis, type Entity, type EntityBase, type Interaction, type Person, type PersonReflection, type FollowUp } from '@zhijiao/shared';
import { auth } from './auth';

export interface AnalysisDraft {
  people: Array<InteractionAnalysis['people'][number] & { selected: boolean; targetId: string; newName: string }>;
  reflections: Array<InteractionAnalysis['reflections'][number] & { selected: boolean }>;
  followUps: Array<Omit<InteractionAnalysis['followUps'][number], 'dueDate'> & { selected: boolean; dueDate: string }>;
}

const normalized = (value: string) => value.trim().normalize('NFKC').toLocaleLowerCase();

export function createAnalysisDraft(result: InteractionAnalysis, current: Entity[]): AnalysisDraft {
  const people = current.filter((entry): entry is Person => entry.kind === 'person');
  return {
    people: result.people.map(candidate => {
      const matches = people.filter(person => [person.displayName, person.fullName ?? '', ...person.aliases ?? []].some(name => normalized(name) === normalized(candidate.name)));
      return { ...candidate, selected: false, targetId: !candidate.isSelf && matches.length === 1 ? matches[0].id : '', newName: candidate.name };
    }),
    reflections: result.reflections.map(candidate => ({ ...candidate, selected: false })),
    followUps: result.followUps.map(candidate => ({ ...candidate, personKeys: [...candidate.personKeys], selected: false, dueDate: candidate.dueDate ?? '' })),
  };
}

function text(value: string, title: string, max: number, required = true): string {
  const trimmed = value.trim();
  if ((required && !trimmed) || trimmed.length > max) throw new Error(`${title}${trimmed ? `不能超过 ${max} 字。` : '不能为空。'}`);
  return trimmed;
}

/** Build a single local encrypted transaction only after the user's explicit selection. */
export function buildAnalysisRecords(source: Interaction, draft: AnalysisDraft, current: Entity[], makeBase: () => EntityBase): Entity[] {
  const latest = current.find(entry => entry.id === source.id);
  if (!latest || latest.kind !== 'interaction' || latest.updatedAt !== source.updatedAt || latest.title !== source.title || latest.content !== source.content || latest.occurredOn !== source.occurredOn) {
    throw new Error('这次交往已修改或删除，请关闭窗口，重新打开交往后分析。');
  }
  if (draft.people.length > 12 || draft.reflections.length > 20 || draft.followUps.length > 20 || new Set(draft.people.map(person => person.key)).size !== draft.people.length) throw new Error('分析候选数量或人物标识异常，请重新分析。');
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
  const sourceReflectionIds = new Set(current.filter(entry => entry.kind === 'reflectionLink' && entry.interactionId === source.id).map(entry => entry.kind === 'reflectionLink' ? entry.reflectionId : ''));
  for (const candidate of draft.reflections.filter(entry => entry.selected)) {
    const personId = target(candidate.personKey);
    if (!['feeling', 'hypothesis', 'experience'].includes(candidate.type)) throw new Error('请选择有效的感受或印象类型。');
    const content = text(candidate.content, '感受或印象', 3000);
    const evidence = text(candidate.evidence, '原文依据', 1000);
    const duplicate = [...current, ...records].some(entry => entry.kind === 'reflection' && entry.personId === personId && entry.type === candidate.type && entry.content.trim() === content && (sourceReflectionIds.has(entry.id) || records.some(link => link.kind === 'reflectionLink' && link.reflectionId === entry.id)));
    if (duplicate) continue;
    const reflection: PersonReflection = { ...makeBase(), kind: 'reflection', personId, type: candidate.type, content, evidence, context: `来源交往：${source.title}`, certainty: '经本人筛选确认的分析建议，仍为主观记录', ...(source.occurredOn ? { recordedOn: source.occurredOn } : {}), status: 'current' };
    records.push(reflection, { ...makeBase(), kind: 'reflectionLink', reflectionId: reflection.id, interactionId: source.id, relationType: 'arose', explanation: evidence });
  }
  for (const candidate of draft.followUps.filter(entry => entry.selected)) {
    const keys = [...new Set(candidate.personKeys)];
    if (keys.some(key => !draft.people.some(person => person.key === key))) throw new Error('事项引用的人物不完整，请重新分析。');
    const personIds = [...new Set(keys.filter(key => !draft.people.find(person => person.key === key)!.isSelf).map(target))];
    if (!personIds.length) throw new Error('事项至少需要确认一位其他人物；“我”默认是当前用户。');
    const title = text(candidate.title, '事项标题', 300);
    const details = text(candidate.details, '事项细节', 3000, false);
    const evidence = text(candidate.evidence, '原文依据', 1000);
    const dueDate = candidate.dueDate.trim();
    if (dueDate && (!partialDateSchema.safeParse(dueDate).success || dueDate.startsWith('--'))) throw new Error('事项期限请填写带年份的有效日期，可精确到年、月或日。');
    if (!['promise', 'plan'].includes(candidate.type) || !['me', 'other', 'joint'].includes(candidate.responsibility)) throw new Error('请选择有效的事项类型与责任。');
    const savedDetails = [details, `原文依据：${evidence}`].filter(Boolean).join('\n\n');
    const duplicate = [...current, ...records].some(entry => entry.kind === 'followUp' && entry.sourceInteractionId === source.id && entry.title.trim() === title && (entry.details ?? '').trim() === savedDetails && entry.type === candidate.type && entry.responsibility === candidate.responsibility && (entry.dueDate ?? '') === dueDate && [...entry.personIds].sort().join(',') === [...personIds].sort().join(','));
    if (duplicate) continue;
    const followUp: FollowUp = { ...makeBase(), kind: 'followUp', title, details: savedDetails, personIds, type: candidate.type, responsibility: candidate.responsibility, sourceInteractionId: source.id, ...(dueDate ? { dueDate } : {}), status: 'pending' };
    records.push(followUp);
  }
  if (!records.length) throw new Error('没有需要新增的内容。请选择条目；相同交往中已保存的相同内容会自动跳过。');
  // Each new person also creates its encrypted directory entry in VaultClient.
  if (records.length + records.filter(entry => entry.kind === 'person').length > 100) throw new Error('本次选择内容过多，请减少条目后重试。');
  return records;
}

async function analysisCall(path: string, body: unknown | undefined, signal?: AbortSignal): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/analysis/${path}`, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', signal,
      headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-csrf-token': auth.csrfToken() }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error('无法连接分析服务，请检查网络后重试。');
  }
  if (!response.ok) {
    const messages: Record<number, string> = { 400: '交往内容过长或格式不正确，请将标题控制在 300 字、正文控制在 20000 字内。', 401: '登录会话已失效，请重新登录后分析。', 403: '登录验证已失效，请重新登录后分析。', 429: '分析正在进行或请求过于频繁，请稍后重试。', 503: '分析服务尚未配置，请联系管理员配置 AI 服务。' };
    throw new Error(messages[response.status] ?? '分析未完成或返回内容不合要求，请重试。');
  }
  return response.json();
}

export async function analysisAvailability(signal?: AbortSignal): Promise<{ available: boolean; providerLabel?: string }> {
  const result = await analysisCall('status', undefined, signal) as { available?: unknown; providerLabel?: unknown };
  if (typeof result.available !== 'boolean') throw new Error('分析服务状态异常，请重试。');
  return { available: result.available, ...(typeof result.providerLabel === 'string' ? { providerLabel: result.providerLabel } : {}) };
}

export async function requestInteractionAnalysis(record: Interaction, signal?: AbortSignal): Promise<InteractionAnalysis> {
  const value = await analysisCall('interaction', { title: record.title, content: record.content, ...(record.occurredOn ? { occurredOn: record.occurredOn } : {}) }, signal);
  const result = interactionAnalysisSchema.safeParse(value);
  if (!result.success) throw new Error('分析返回的内容不完整，请重试。');
  if (!validateAnalysisEvidence(result.data, record)) throw new Error('分析返回的原文依据与这次交往不符，请重试。');
  return result.data;
}
