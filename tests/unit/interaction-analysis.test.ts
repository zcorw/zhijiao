import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Entity, EntityBase, Interaction, InteractionAnalysisInput, Person } from '@zhijiao/shared';
import { validateEntity, references } from '../../packages/client/src/entities.js';
import { buildAnalysisRecords, createAnalysisDraft, factNeedsClarification, followUpNeedsClarification, reflectionNeedsAdoption, requestInteractionAnalysis } from '../../apps/web/src/interaction-analysis';

const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function base(): EntityBase { return { id: crypto.randomUUID(), ownerId, createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:00:00.000Z' }; }
function person(name = '孟桥'): Person { return { ...base(), kind: 'person', displayName: name, aliases: ['小孟'], status: 'active' }; }
const event: Interaction = { ...base(), kind: 'interaction', title: '书店见面', content: '我觉得孟桥很细致。孟桥说：“我还没决定搬家。”我答应给孟桥寄书，周宜也会帮忙。', participantIds: [], occurredOn: '2026-10-24' };
function analysis(): InteractionAnalysisInput {
  return {
    people: [{ key: 'self', name: '我', isSelf: true, mention: '我觉得' }, { key: 'meng', name: '孟桥', isSelf: false, mention: '孟桥' }, { key: 'zhou', name: '周宜', isSelf: false, mention: '周宜' }],
    reflections: [{ personKey: 'meng', type: 'hypothesis', content: '我暂时觉得孟桥很细致。', evidence: '我觉得孟桥很细致' }],
    followUps: [{ personKeys: ['self', 'meng'], title: '给孟桥寄书', details: '寄出约定的书。', type: 'promise', responsibility: 'me', evidence: '我答应给孟桥寄书' }],
  };
}
function factAnalysis(): InteractionAnalysisInput {
  return { ...analysis(), facts: [{ personKey: 'meng', type: 'current-state', content: '孟桥尚未决定搬家。', category: '居住计划', basis: 'self-reported', factStatus: 'candidate', evidence: '我还没决定搬家', evidenceQuotes: ['孟桥说：“我还没决定搬家。”', '我还没决定搬家'], statementId: 'statement-1', classificationReason: '本人表达当前计划状态。', source: { type: 'person', personId: 'meng' }, uncertainty: '尚未确定未来是否搬家', polarity: 'negated' }], backgrounds: [{ personKeys: [], content: '这次在书店见面。', evidence: '书店见面' }] };
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

describe('analysis facts, provenance, and clarification', () => {
  it('leaves all three record types unselected and never creates an entity for background', () => {
    const meng = person(); const result = factAnalysis(); const draft = createAnalysisDraft(result, [event, meng]);
    expect(draft.facts[0]).toMatchObject({ selected: false, clarified: false, sourceNote: '', category: '居住计划', basis: 'self-reported' });
    expect(draft.reflections[0].adopted).toBe(false); expect(draft.followUps[0].clarified).toBe(false);
    expect(draft.backgrounds).toEqual(result.backgrounds);
    draft.people[1].selected = true;
    expect(() => buildAnalysisRecords(event, draft, [event, meng], base)).toThrow('没有需要新增');
  });
  it('saves selected facts as unconfirmed and preserves subtype, quotes, provenance, and user notes', () => {
    const meng = person(); const current = [event, meng]; const before = JSON.stringify(current); const draft = createAnalysisDraft(factAnalysis(), current);
    draft.people[1].selected = true; draft.facts[0].selected = true; draft.facts[0].sourceNote = '下次见面再问。';
    const [saved] = buildAnalysisRecords(event, draft, current, base);
    expect(saved).toMatchObject({ kind: 'fact', personId: meng.id, content: '孟桥尚未决定搬家。', category: '居住计划', basis: 'self-reported', sourceInteractionId: event.id, status: 'unconfirmed', learnedOn: '2026-10-24' });
    if (saved.kind !== 'fact') throw new Error('expected fact');
    for (const value of ['current-state', 'candidate', 'statement-1', '本人表达当前计划状态。', 'person', '孟桥', '尚未确定未来是否搬家', 'negated', '孟桥说：“我还没决定搬家。”', '我还没决定搬家', '下次见面再问。']) expect(saved.sourceNote).toContain(value);
    expect(validateEntity(saved)).toEqual(saved); expect(JSON.stringify(current)).toBe(before);
  });
  it('does not invent a learned date and keeps each fact tied to its own source quotes', () => {
    const source = { ...event, occurredOn: undefined }; const meng = person(); const result = factAnalysis();
    result.facts!.push({ ...result.facts![0], type: 'preference', category: '阅读偏好', content: '需要向本人核对阅读偏好。', evidence: '给孟桥寄书', evidenceQuotes: ['我答应给孟桥寄书'] });
    const draft = createAnalysisDraft(result, [source, meng]); draft.people[1].selected = true; draft.facts.forEach(row => { row.selected = true; });
    const records = buildAnalysisRecords(source, draft, [source, meng], base);
    expect(records).toHaveLength(2);
    expect(records[0]).not.toHaveProperty('learnedOn');
    expect(records[1].kind === 'fact' && records[1].sourceNote).not.toContain('我还没决定搬家');
  });
  it('rejects unknown basis, placeholder categories, and facts whose target person was not confirmed', () => {
    const meng = person(); const result = factAnalysis(); result.facts![0].basis = null; result.facts![0].category = null;
    const draft = createAnalysisDraft(result, [event, meng]); const row = draft.facts[0]; row.selected = true;
    expect(row.basis).toBe(''); expect(row.category).toBe('');
    expect(() => buildAnalysisRecords(event, draft, [event, meng], base)).toThrow('尚未确认的人物');
    draft.people[1].selected = true;
    expect(() => buildAnalysisRecords(event, draft, [event, meng], base)).toThrow('事实来源方式');
    row.basis = 'third-party'; row.clarified = true;
    expect(() => buildAnalysisRecords(event, draft, [event, meng], base)).toThrow('事实类别');
    for (const category of ['未知', '---', 'unknown']) { row.category = category; expect(() => buildAnalysisRecords(event, draft, [event, meng], base)).toThrow('实际含义'); }
    row.category = '居住计划'; expect(buildAnalysisRecords(event, draft, [event, meng], base)[0]).toMatchObject({ basis: 'third-party', status: 'unconfirmed' });
  });
  it.each(['ambiguous', 'uncertain', 'unknown-source', 'model-source', 'changed-basis', 'missing-basis'] as const)('requires manual clarification for %s even if edited fields hide its original ambiguity', mode => {
    const meng = person(); const result = factAnalysis(); const row = result.facts![0];
    if (mode === 'ambiguous') row.factStatus = 'ambiguous';
    if (mode === 'uncertain') row.polarity = 'uncertain';
    if (mode === 'unknown-source' || mode === 'model-source') row.source = { type: mode === 'unknown-source' ? 'unknown' : 'model', personId: null };
    if (mode === 'missing-basis') row.basis = null;
    const draft = createAnalysisDraft(result, [event, meng]); const fact = draft.facts[0]; draft.people[1].selected = true; fact.selected = true;
    if (mode === 'changed-basis' || mode === 'missing-basis') fact.basis = 'observation';
    // Editing visible metadata cannot remove the original confirmation requirement.
    fact.factStatus = 'candidate'; fact.polarity = 'affirmed';
    expect(factNeedsClarification(fact)).toBe(true);
    expect(() => buildAnalysisRecords(event, draft, [event, meng], base)).toThrow('手动澄清');
    fact.clarified = true; expect(buildAnalysisRecords(event, draft, [event, meng], base)[0]).toMatchObject({ kind: 'fact', status: 'unconfirmed' });
  });
  it('retains an unselected third-party speaker by name without creating their profile', () => {
    const xiaolan = person('小岚'); const source = { ...event, content: '阿北说，小岚目前在京都工作。' };
    const result: InteractionAnalysisInput = { people: [{ key: 'p2', name: '小岚', isSelf: false, mention: '小岚' }, { key: 'p3', name: '阿北', isSelf: false, mention: '阿北' }], facts: [{ personKey: 'p2', type: 'current-state', content: '小岚目前在京都工作。', category: '工作地点', basis: 'third-party', factStatus: 'candidate', evidence: '阿北说，小岚目前在京都工作。', source: { type: 'person', personId: 'p3' } }], reflections: [], followUps: [] };
    const draft = createAnalysisDraft(result, [source, xiaolan]); draft.people[0].selected = true; draft.facts[0].selected = true;
    const records = buildAnalysisRecords(source, draft, [source, xiaolan], base);
    expect(records).toHaveLength(1); expect(records[0].kind).toBe('fact');
    if (records[0].kind === 'fact') { expect(records[0].sourceNote).toContain('阿北'); expect(records[0].sourceNote).toContain('p3'); }
  });
  it('deduplicates facts by stable fields when analysis metadata changes and only adds new content', () => {
    const meng = person(); const result = factAnalysis(); const draft = createAnalysisDraft(result, [event, meng]); draft.people[1].selected = true; draft.facts[0].selected = true;
    const saved = buildAnalysisRecords(event, draft, [event, meng], base);
    result.facts![0].classificationReason = '重新归类，意义不变'; result.facts![0].statementId = 'renumbered'; result.facts![0].uncertainty = '另一个不确定性说明';
    const again = createAnalysisDraft(result, [event, meng, ...saved]); again.people[1].selected = true; again.facts[0].selected = true;
    expect(() => buildAnalysisRecords(event, again, [event, meng, ...saved], base)).toThrow('没有需要新增');
    again.facts.push({ ...again.facts[0], content: '下次见面再核对搬家计划。' });
    const more = buildAnalysisRecords(event, again, [event, meng, ...saved], base);
    expect(more).toHaveLength(1); expect(more[0]).toMatchObject({ content: '下次见面再核对搬家计划。' });
    expect(saved[0]).toMatchObject({ content: '孟桥尚未决定搬家。' });
  });
  it.each(['fact', 'reflection', 'followUp'] as const)('keeps independent speakers for identical %s content and quotes, but deduplicates renumbered local keys', kind => {
    const xiaolan = person('小岚'); const source = { ...event, content: '阿北说小岚在京都工作。小明也说小岚在京都工作。' };
    const result: InteractionAnalysisInput = { people: [{ key: 'p2', name: '小岚', isSelf: false, mention: '小岚' }, { key: 'p3', name: '阿北', isSelf: false, mention: '阿北' }, { key: 'p4', name: '小明', isSelf: false, mention: '小明' }], facts: [], reflections: [], followUps: [] };
    for (const speaker of ['p3', 'p4']) {
      const provenance = { evidence: '小岚在京都工作', source: { type: 'person' as const, personId: speaker }, statementId: speaker };
      if (kind === 'fact') result.facts!.push({ ...provenance, personKey: 'p2', type: 'current-state', content: '小岚在京都工作。', category: '工作地点', basis: 'third-party', factStatus: 'candidate' });
      if (kind === 'reflection') result.reflections.push({ ...provenance, personKey: 'p2', type: 'hypothesis', content: '小岚在京都工作的判断。', perspective: provenance.source });
      if (kind === 'followUp') result.followUps.push({ ...provenance, personKeys: ['p2'], title: '核对小岚的工作地点', details: '下次联系时核对。', type: 'plan', responsibility: 'me' });
    }
    function select(value: InteractionAnalysisInput, current: Entity[]) {
      const draft = createAnalysisDraft(value, current); draft.people[0].selected = true;
      draft.facts.forEach(row => { row.selected = true; }); draft.followUps.forEach(row => { row.selected = true; });
      draft.reflections.forEach(row => { row.selected = true; row.adopted = true; row.content = '我暂时认为小岚在京都工作。'; });
      return draft;
    }
    const current = [source, xiaolan]; const saved = buildAnalysisRecords(source, select(result, current), current, base);
    expect(saved).toHaveLength(kind === 'reflection' ? 4 : 2);
    const notes = saved.map(entry => entry.kind === 'fact' ? entry.sourceNote : entry.kind === 'reflection' ? entry.context : entry.kind === 'followUp' ? entry.details : '').join('\n');
    expect(notes).toContain('阿北'); expect(notes).toContain('小明'); expect(saved.some(entry => entry.kind === 'person')).toBe(false);
    const keys: Record<string, string> = { p2: 'p9', p3: 'p4', p4: 'p3' };
    const remapped: InteractionAnalysisInput = {
      people: result.people.map(row => ({ ...row, key: keys[row.key] })),
      facts: result.facts!.map(row => ({ ...row, personKey: keys[row.personKey], source: { ...row.source!, personId: keys[row.source!.personId!] }, statementId: 'new-id', classificationReason: '归类理由已更新' })),
      reflections: result.reflections.map(row => ({ ...row, personKey: keys[row.personKey], source: { ...row.source!, personId: keys[row.source!.personId!] }, perspective: { ...row.perspective!, personId: keys[row.perspective!.personId!] }, statementId: 'new-id', classificationReason: '归类理由已更新' })),
      followUps: result.followUps.map(row => ({ ...row, personKeys: row.personKeys.map(key => keys[key]), source: { ...row.source!, personId: keys[row.source!.personId!] }, statementId: 'new-id', classificationReason: '归类理由已更新' })),
    };
    expect(() => buildAnalysisRecords(source, select(remapped, [...current, ...saved]), [...current, ...saved], base)).toThrow('没有需要新增');
  });
  it('keeps a new independent quote for the same fact and speaker without overwriting the first source', () => {
    const xiaolan = person('小岚'); const source = { ...event, content: '阿北说小岚在京都工作。阿北后来补充，小岚的公司就在京都。' };
    const result: InteractionAnalysisInput = { people: [{ key: 'p2', name: '小岚', isSelf: false, mention: '小岚' }, { key: 'p3', name: '阿北', isSelf: false, mention: '阿北' }], facts: [{ personKey: 'p2', type: 'current-state', content: '小岚在京都工作。', category: '工作地点', basis: 'third-party', factStatus: 'candidate', evidence: '阿北说小岚在京都工作。', source: { type: 'person', personId: 'p3' } }], reflections: [], followUps: [] };
    const draft = createAnalysisDraft(result, [source, xiaolan]); draft.people[0].selected = true; draft.facts[0].selected = true;
    const saved = buildAnalysisRecords(source, draft, [source, xiaolan], base); const before = JSON.stringify(saved);
    result.facts![0].evidence = '阿北后来补充，小岚的公司就在京都。';
    const more = createAnalysisDraft(result, [source, xiaolan, ...saved]); more.people[0].selected = true; more.facts[0].selected = true;
    const added = buildAnalysisRecords(source, more, [source, xiaolan, ...saved], base);
    expect(added).toHaveLength(1); expect(added[0].kind === 'fact' && added[0].sourceNote).toContain('阿北后来补充，小岚的公司就在京都。'); expect(JSON.stringify(saved)).toBe(before);
  });
  it.each(['fact', 'reflection', 'followUp'] as const)('distinguishes same-name %s sources by confirmed profiles or original identity anchors', kind => {
    const xiaolan = person('小岚'); const colleague = person('小王（同事）'); const neighbor = person('小王（邻居）');
    const source = { ...event, content: '左边的小王说小岚在京都工作，右边的小王也说小岚在京都工作。' };
    const result: InteractionAnalysisInput = { people: [{ key: 'p1', name: '小岚', isSelf: false, mention: '小岚' }, { key: 'p2', name: '小王', isSelf: false, mention: '左边的小王' }, { key: 'p3', name: '小王', isSelf: false, mention: '右边的小王' }], facts: [], reflections: [], followUps: [] };
    for (const speaker of ['p2', 'p3']) {
      const provenance = { evidence: source.content, source: { type: 'person' as const, personId: speaker } };
      if (kind === 'fact') result.facts!.push({ ...provenance, personKey: 'p1', type: 'current-state', content: '小岚在京都工作。', category: '工作地点', basis: 'third-party', factStatus: 'candidate' });
      if (kind === 'reflection') result.reflections.push({ ...provenance, personKey: 'p1', type: 'hypothesis', content: '小岚在京都工作的判断。', perspective: provenance.source });
      if (kind === 'followUp') result.followUps.push({ ...provenance, personKeys: ['p1'], title: '核对小岚的工作地点', details: '下次联系时核对。', type: 'plan', responsibility: 'me' });
    }
    const current = [source, xiaolan, colleague, neighbor];
    for (const mapped of [true, false]) {
      function select(value: InteractionAnalysisInput) {
        const draft = createAnalysisDraft(value, current); draft.people[0].selected = true;
        if (mapped) { draft.people[1].selected = true; draft.people[1].targetId = colleague.id; draft.people[2].selected = true; draft.people[2].targetId = neighbor.id; }
        draft.facts.forEach(row => { row.selected = true; }); draft.followUps.forEach(row => { row.selected = true; });
        draft.reflections.forEach(row => { row.selected = true; row.adopted = true; row.content = '我暂时认为小岚在京都工作。'; });
        return draft;
      }
      const saved = buildAnalysisRecords(source, select(result), current, base);
      expect(saved).toHaveLength(kind === 'reflection' ? 4 : 2);
      const rows = saved.filter(entry => entry.kind !== 'reflectionLink');
      const notes = rows.map(entry => entry.kind === 'fact' ? entry.sourceNote : entry.kind === 'reflection' ? entry.context : entry.kind === 'followUp' ? entry.details : '');
      if (mapped) {
        expect(notes[0]).toContain(`档案ID：${colleague.id}`); expect(notes[0]).toContain('小王（同事）');
        expect(notes[1]).toContain(`档案ID：${neighbor.id}`); expect(notes[1]).toContain('小王（邻居）');
      } else {
        expect(notes[0]).toContain('原文身份锚点：["左边的小王"]'); expect(notes[1]).toContain('原文身份锚点：["右边的小王"]');
        expect(saved.some(entry => entry.kind === 'person')).toBe(false);
      }
      const keys: Record<string, string> = { p1: 'p9', p2: 'p3', p3: 'p2' };
      const remapped: InteractionAnalysisInput = {
        people: result.people.map(row => ({ ...row, key: keys[row.key] })),
        facts: result.facts!.map(row => ({ ...row, personKey: keys[row.personKey], source: { ...row.source!, personId: keys[row.source!.personId!] } })),
        reflections: result.reflections.map(row => ({ ...row, personKey: keys[row.personKey], source: { ...row.source!, personId: keys[row.source!.personId!] }, perspective: { ...row.perspective!, personId: keys[row.perspective!.personId!] } })),
        followUps: result.followUps.map(row => ({ ...row, personKeys: row.personKeys.map(key => keys[key]), source: { ...row.source!, personId: keys[row.source!.personId!] } })),
      };
      expect(() => buildAnalysisRecords(source, select(remapped), [...current, ...saved], base)).toThrow('没有需要新增');
    }
    // If even the original identity anchors coincide, keep the unresolved local identities separate.
    result.people[1].mention = '小王'; result.people[2].mention = '小王';
    const unresolved = createAnalysisDraft(result, current); unresolved.people[0].selected = true;
    unresolved.facts.forEach(row => { row.selected = true; }); unresolved.followUps.forEach(row => { row.selected = true; });
    unresolved.reflections.forEach(row => { row.selected = true; row.adopted = true; row.content = '我暂时认为小岚在京都工作。'; });
    const preserved = buildAnalysisRecords(source, unresolved, current, base); expect(preserved).toHaveLength(kind === 'reflection' ? 4 : 2);
    // In another analysis the same local key may refer to a different unresolved speaker.
    const repeat = structuredClone(result); const swap = (key: string) => key === 'p2' ? 'p3' : key === 'p3' ? 'p2' : key;
    repeat.people.forEach(row => { row.key = swap(row.key); });
    for (const row of [...repeat.facts!, ...repeat.reflections, ...repeat.followUps]) if (row.source?.personId) row.source.personId = swap(row.source.personId);
    repeat.reflections.forEach(row => { if (row.perspective?.personId) row.perspective.personId = swap(row.perspective.personId); });
    const next = createAnalysisDraft(repeat, [...current, ...preserved]); next.people[0].selected = true;
    next.facts.forEach(row => { row.selected = true; }); next.followUps.forEach(row => { row.selected = true; });
    next.reflections.forEach(row => { row.selected = true; row.adopted = true; row.content = '我暂时认为小岚在京都工作。'; });
    expect(buildAnalysisRecords(source, next, [...current, ...preserved], base)).toHaveLength(kind === 'reflection' ? 4 : 2);
  });
  it.each(['person', 'model', 'unknown'] as const)('requires explicit adoption and edited content for a %s perspective', perspective => {
    const meng = person(); const result = analysis(); result.reflections[0].perspective = { type: perspective, personId: perspective === 'person' ? 'zhou' : null }; result.reflections[0].source = { type: 'person', personId: 'zhou' }; result.reflections[0].temporalScope = 'this-interaction'; result.reflections[0].uncertainty = '只描述本次体验'; result.reflections[0].evidenceQuotes = ['我觉得孟桥很细致', '孟桥说'];
    const draft = createAnalysisDraft(result, [event, meng]); draft.people[1].selected = true; const reflection = draft.reflections[0]; reflection.selected = true;
    expect(reflectionNeedsAdoption(reflection)).toBe(true);
    reflection.perspective = { type: 'narrator', personId: null };
    expect(() => buildAnalysisRecords(event, draft, [event, meng], base)).toThrow('显式采用');
    reflection.adopted = true; expect(() => buildAnalysisRecords(event, draft, [event, meng], base)).toThrow('编辑核对');
    reflection.content = '结合本次见面，我暂时认为孟桥做事细致。';
    const records = buildAnalysisRecords(event, draft, [event, meng], base); const saved = records[0];
    expect(records).toHaveLength(2); expect(saved.kind).toBe('reflection');
    if (saved.kind === 'reflection') { expect(saved.context).toContain(perspective); expect(saved.context).toContain('周宜'); expect(saved.context).toContain('this-interaction'); expect(saved.context).toContain('只描述本次体验'); expect(saved.evidence).toContain('孟桥说'); expect(saved.certainty).toContain('主观记录'); }
    records.forEach(entry => validateEntity(entry));
  });
  it('accepts a known narrator perspective through the normal selection flow', () => {
    const meng = person(); const result = analysis(); result.reflections[0].perspective = { type: 'narrator', personId: 'self' };
    const draft = createAnalysisDraft(result, [event, meng]); draft.people[1].selected = true; draft.reflections[0].selected = true;
    expect(reflectionNeedsAdoption(draft.reflections[0])).toBe(false);
    const saved = buildAnalysisRecords(event, draft, [event, meng], base)[0]; expect(saved.kind === 'reflection' && saved.context).toContain('当前用户');
  });
  it.each(['unknown-responsibility', 'unclear-status'] as const)('requires responsibility clarification for %s and preserves text dates without calculating a deadline', mode => {
    const meng = person(); const result = analysis(); const followUp = result.followUps[0]; if (mode === 'unknown-responsibility') followUp.responsibility = 'unknown'; else followUp.status = 'unclear';
    followUp.dueAtText = '我答应'; followUp.responsiblePersonKeys = ['self']; followUp.evidenceQuotes = ['我答应给孟桥寄书', '周宜也会帮忙']; followUp.classificationReason = '存在未澄清的责任';
    const draft = createAnalysisDraft(result, [event, meng]); draft.people[1].selected = true; const row = draft.followUps[0]; row.selected = true; row.responsibility = 'joint'; row.status = 'pending';
    expect(followUpNeedsClarification(row)).toBe(true); expect(() => buildAnalysisRecords(event, draft, [event, meng], base)).toThrow('手动澄清');
    row.clarified = true; const saved = buildAnalysisRecords(event, draft, [event, meng], base)[0];
    expect(saved).toMatchObject({ kind: 'followUp', responsibility: 'joint', status: 'pending' }); expect(saved).not.toHaveProperty('dueDate'); expect(saved).not.toHaveProperty('dueAt');
    if (saved.kind === 'followUp') { expect(saved.details).toContain('我答应'); expect(saved.details).toContain('未经自动换算'); expect(saved.details).toContain('当前用户'); expect(saved.details).toContain('周宜也会帮忙'); }
  });
  it('deduplicates follow-ups independently of analysis metadata and remains compatible with old saved details', () => {
    const meng = person(); const result = analysis(); const draft = createAnalysisDraft(result, [event, meng]); draft.people[1].selected = true; draft.followUps[0].selected = true;
    const saved = buildAnalysisRecords(event, draft, [event, meng], base);
    result.followUps[0].classificationReason = '重新归类'; result.followUps[0].statementId = 'renumbered';
    const again = createAnalysisDraft(result, [event, meng, ...saved]); again.people[1].selected = true; again.followUps[0].selected = true;
    expect(() => buildAnalysisRecords(event, again, [event, meng, ...saved], base)).toThrow('没有需要新增');
    again.followUps[0].details = '只改人工事项细节。'; const updated = buildAnalysisRecords(event, again, [event, meng], base);
    const refreshed = createAnalysisDraft({ ...result, followUps: [{ ...result.followUps[0], details: '只改人工事项细节。', classificationReason: '再次改动归类理由', statementId: 'next-id' }] }, [event, meng, ...updated]); refreshed.people[1].selected = true; refreshed.followUps[0].selected = true;
    expect(() => buildAnalysisRecords(event, refreshed, [event, meng, ...updated], base)).toThrow('没有需要新增');
  });
  it('rejects invented or combined quotes before saving any selected record', () => {
    const meng = person(); const draft = createAnalysisDraft(factAnalysis(), [event, meng]); draft.people[1].selected = true; draft.facts[0].selected = true; draft.facts[0].evidenceQuotes = ['孟桥说……周宜也会帮忙'];
    expect(() => buildAnalysisRecords(event, draft, [event, meng], base)).toThrow('原文依据');
  });
  it('counts encrypted directory rows toward the atomic transaction limit', () => {
    const result = factAnalysis(); result.facts = Array.from({ length: 59 }, (_, index) => ({ ...result.facts![0], content: `待核对事项${index}` })); result.reflections = Array.from({ length: 20 }, (_, index) => ({ ...result.reflections[0], content: `经筛选的印象${index}` })); result.followUps = [];
    const draft = createAnalysisDraft(result, [event]); draft.people[1].selected = true; draft.people[1].targetId = 'new'; draft.facts.forEach(row => { row.selected = true; }); draft.reflections.forEach(row => { row.selected = true; });
    const current: Entity[] = [event]; const before = JSON.stringify(current);
    // 1 profile + 1 directory + 59 facts + 40 reflection/link records = 101.
    expect(() => buildAnalysisRecords(event, draft, current, base)).toThrow('内容过多'); expect(JSON.stringify(current)).toBe(before);
    draft.facts.pop(); expect(buildAnalysisRecords(event, draft, current, base)).toHaveLength(99);
  });
});

describe('analysis browser request boundary', () => {
  it('sends only the current interaction text and date, with no profile or account payload', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(analysis()), { status: 200 })); vi.stubGlobal('fetch', fetcher);
    await expect(requestInteractionAnalysis(event)).resolves.toEqual({ ...analysis(), facts: [], backgrounds: [] });
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
