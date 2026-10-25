import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EntityBase, Interaction, InteractionAnalysis, Person } from '@zhijiao/shared';
import { validateEntity, references } from '../../packages/client/src/entities.js';
import { buildAnalysisRecords, createAnalysisDraft, requestInteractionAnalysis } from '../../apps/web/src/interaction-analysis';

const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function base(): EntityBase { return { id: crypto.randomUUID(), ownerId, createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z' }; }
function person(name = '孟桥'): Person { return { ...base(), kind: 'person', displayName: name, aliases: ['小孟'], status: 'active' }; }
const event: Interaction = { ...base(), kind: 'interaction', title: '书店见面', content: '我觉得孟桥很细致。孟桥说：“我还没决定搬家。”我答应给孟桥寄书，周宜也会帮忙。', participantIds: [], occurredOn: '2026-10-24' };
function analysis(): InteractionAnalysis {
  return {
    people: [{ key: 'self', name: '我', isSelf: true, mention: '我觉得' }, { key: 'meng', name: '孟桥', isSelf: false, mention: '孟桥' }, { key: 'zhou', name: '周宜', isSelf: false, mention: '周宜' }],
    reflections: [{ personKey: 'meng', type: 'hypothesis', content: '我暂时觉得孟桥很细致。', evidence: '我觉得孟桥很细致' }],
    followUps: [{ personKeys: ['self', 'meng'], title: '给孟桥寄书', details: '寄出约定的书。', type: 'promise', responsibility: 'me', evidence: '我答应给孟桥寄书' }],
  };
}
afterEach(() => { vi.unstubAllGlobals(); });

describe('analysis selection and encrypted transaction planning', () => {
  it('starts with every candidate unchecked, matches only unique complete names or aliases, and never maps the narrator', () => {
    const meng = person(); const result = createAnalysisDraft(analysis(), [meng, person('我')]);
    expect(result.people.every(entry => !entry.selected)).toBe(true);
    expect(result.reflections.every(entry => !entry.selected)).toBe(true);
    expect(result.followUps.every(entry => !entry.selected)).toBe(true);
    expect(result.people[1].targetId).toBe(meng.id); expect(result.people[0].targetId).toBe('');
    const aliased = analysis(); aliased.people[1].name = '小孟';
    expect(createAnalysisDraft(aliased, [meng]).people[1].targetId).toBe(meng.id);
    expect(createAnalysisDraft(analysis(), [meng, person()]).people[1].targetId).toBe('');
    const partial = analysis(); partial.people[1].name = '孟';
    expect(createAnalysisDraft(partial, [meng]).people[1].targetId).toBe('');
  });
  it('produces no records without explicit selection', () => {
    const current = [event, person()]; const before = JSON.stringify(current);
    expect(() => buildAnalysisRecords(event, createAnalysisDraft(analysis(), current), current, base)).toThrow('没有需要新增');
    expect(JSON.stringify(current)).toBe(before);
  });
  it('writes only confirmed rows, creates source links, and leaves participation and existing profiles intact', () => {
    const meng = person(); const current = [event, meng]; const draft = createAnalysisDraft(analysis(), current);
    draft.people[1].selected = true; draft.reflections[0].selected = true; draft.followUps[0].selected = true;
    const records = buildAnalysisRecords(event, draft, current, base);
    expect(records.map(entry => entry.kind)).toEqual(['reflection', 'reflectionLink', 'followUp']);
    records.forEach(entry => expect(validateEntity(entry)).toEqual(entry));
    expect(records[0]).toMatchObject({ personId: meng.id, recordedOn: '2026-10-24', type: 'hypothesis' });
    expect(records[1]).toMatchObject({ interactionId: event.id, relationType: 'arose' });
    expect(records[2]).toMatchObject({ personIds: [meng.id], responsibility: 'me', sourceInteractionId: event.id });
    expect(event.participantIds).toEqual([]); expect(meng.summary).toBeUndefined();
    expect(records.flatMap(references).every(ref => [event.id, meng.id, records[0].id].includes(ref.id))).toBe(true);
  });
  it('requires explicit new-person mapping and includes its profile in the same transaction', () => {
    const draft = createAnalysisDraft(analysis(), [event]); draft.people[1].selected = true; draft.reflections[0].selected = true;
    expect(() => buildAnalysisRecords(event, draft, [event], base)).toThrow('选择有效的已有档案');
    draft.people[1].targetId = 'new'; draft.people[1].newName = '孟桥（读书会）';
    const records = buildAnalysisRecords(event, draft, [event], base);
    expect(records[0]).toMatchObject({ kind: 'person', displayName: '孟桥（读书会）' });
    expect(records[1]).toMatchObject({ kind: 'reflection', personId: records[0].id });
    records.forEach(entry => validateEntity(entry));
  });
  it('rejects stale sources and deleted targets before building any writes', () => {
    const meng = person(); const draft = createAnalysisDraft(analysis(), [meng]); draft.people[1].selected = true;
    expect(() => buildAnalysisRecords(event, draft, [{ ...event, content: '已经修改' }, meng], base)).toThrow('已修改或删除');
    expect(() => buildAnalysisRecords(event, draft, [meng], base)).toThrow('已修改或删除');
    expect(() => buildAnalysisRecords(event, draft, [event], base)).toThrow('有效的已有档案');
  });
  it('cannot save a reflection or a multi-person task unless every other person is confirmed', () => {
    const meng = person(); const draft = createAnalysisDraft(analysis(), [meng]); draft.reflections[0].selected = true;
    expect(() => buildAnalysisRecords(event, draft, [event, meng], base)).toThrow('尚未确认的人物');
    draft.reflections[0].selected = false; draft.people[1].selected = true;
    draft.followUps[0].selected = true; draft.followUps[0].personKeys.push('zhou');
    expect(() => buildAnalysisRecords(event, draft, [event, meng], base)).toThrow('尚未确认的人物');
  });
  it('cannot turn the narrator into a profile even if a draft is changed', () => {
    const draft = createAnalysisDraft(analysis(), []); draft.people[0].selected = true; draft.people[0].targetId = 'new';
    expect(() => buildAnalysisRecords(event, draft, [event], base)).toThrow('没有需要新增');
    draft.followUps[0].selected = true; draft.followUps[0].personKeys = ['self'];
    expect(() => buildAnalysisRecords(event, draft, [event], base)).toThrow('至少需要确认一位其他人物');
  });
  it('accepts user edits and rejects invalid or yearless task deadlines', () => {
    const meng = person(); const draft = createAnalysisDraft(analysis(), [meng]); draft.people[1].selected = true; draft.followUps[0].selected = true;
    draft.followUps[0].title = '确认后再寄书'; draft.followUps[0].responsibility = 'joint'; draft.followUps[0].dueDate = '2026-11';
    expect(buildAnalysisRecords(event, draft, [event, meng], base)[0]).toMatchObject({ title: '确认后再寄书', responsibility: 'joint', dueDate: '2026-11' });
    for (const dueDate of ['2026-02-30', '--11-01']) { draft.followUps[0].dueDate = dueDate; expect(() => buildAnalysisRecords(event, draft, [event, meng], base)).toThrow('事项期限'); }
  });
  it('skips identical rows already saved from the same interaction but keeps other-source records independent', () => {
    const meng = person(); const draft = createAnalysisDraft(analysis(), [meng]); draft.people[1].selected = true; draft.reflections[0].selected = true; draft.followUps[0].selected = true;
    const saved = buildAnalysisRecords(event, draft, [event, meng], base);
    expect(() => buildAnalysisRecords(event, draft, [event, meng, ...saved], base)).toThrow('没有需要新增');
    const otherSource = { ...event, ...base(), title: '另一次见面' };
    expect(buildAnalysisRecords(otherSource, draft, [event, meng, otherSource, ...saved], base)).toHaveLength(3);
  });
});

describe('analysis browser request boundary', () => {
  it('sends only the current interaction text and date, with no profile or account payload', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(analysis()), { status: 200 })); vi.stubGlobal('fetch', fetcher);
    await expect(requestInteractionAnalysis(event)).resolves.toEqual(analysis());
    const [url, options] = fetcher.mock.calls[0]; expect(url).toBe('/api/analysis/interaction');
    expect(JSON.parse(options.body)).toEqual({ title: event.title, content: event.content, occurredOn: event.occurredOn });
    expect(options.credentials).toBe('same-origin'); expect(options.headers).toHaveProperty('x-csrf-token');
  });
  it('rejects malformed responses and explains an unconfigured service without exposing raw errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ people: [] }), { status: 200 })));
    await expect(requestInteractionAnalysis(event)).rejects.toThrow('不完整');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('secret upstream diagnostic', { status: 503 })));
    await expect(requestInteractionAnalysis(event)).rejects.toThrow('尚未配置');
  });
  it('preserves cancellation and passes its abort signal to fetch', async () => {
    const controller = new AbortController(); controller.abort(); const aborted = new DOMException('Aborted', 'AbortError');
    const fetcher = vi.fn().mockRejectedValue(aborted); vi.stubGlobal('fetch', fetcher);
    await expect(requestInteractionAnalysis(event, controller.signal)).rejects.toBe(aborted);
    expect(fetcher.mock.calls[0][1].signal).toBe(controller.signal);
  });
});
