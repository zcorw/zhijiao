import { describe, expect, it } from 'vitest';
import type { Entity, Interaction, PersonReflection, ReflectionInteraction, Topic, TopicThought } from '@zhijiao/shared';
import { reflectionsFor, thoughtTypeLabel, titleOf, topicsForPerson } from './format';

const common = { ownerId: crypto.randomUUID(), createdAt: '2026-10-01T12:00:00Z', updatedAt: '2026-10-01T12:00:00Z' };
const personId = crypto.randomUUID();
const topic: Topic = { ...common, id: crypto.randomUUID(), kind: 'topic', name: '虚构的合作原则' };
const thought: TopicThought = { ...common, id: crypto.randomUUID(), kind: 'thought', topicId: topic.id, title: '原则是否适用于所有情境', content: '对原则的疑问属于议题。', type: 'hypothesis', status: 'current' };
const interaction: Interaction = { ...common, id: crypto.randomUUID(), kind: 'interaction', participantIds: [personId], title: '虚构讨论', content: '仅用作测试来源。' };
const reflection: PersonReflection = { ...common, id: crypto.randomUUID(), kind: 'reflection', personId, type: 'feeling', content: '虚构人物感受正文', status: 'current' };
const link: ReflectionInteraction = { ...common, id: crypto.randomUUID(), kind: 'reflectionLink', reflectionId: thought.id, targetKind: 'thought', interactionId: interaction.id, relationType: 'arose' };

describe('topic and person presentation boundaries', () => {
  it('uses stable topic identity through rename and keeps thoughts separate from person evaluations', () => {
    const records: Entity[] = [topic, thought, interaction, reflection, link];
    expect(topicsForPerson(records, personId)).toEqual([topic]);
    expect(reflectionsFor(records, personId)).toEqual([reflection]);
    const renamed = { ...topic, name: '改名后的虚构原则' };
    expect(topicsForPerson([renamed, ...records.slice(1)], personId)).toEqual([renamed]);
    expect(topicsForPerson(records, crypto.randomUUID())).toEqual([]);
  });
  it('uses actual thought source links rather than quoted speakers, text, or legacy reflection links', () => {
    const quotedThought = { ...thought, quote: { kind: 'paraphrase' as const, text: '虚构转述', speakerPersonId: personId } };
    expect(topicsForPerson([topic, quotedThought, interaction], personId)).toEqual([]);
    expect(topicsForPerson([topic, thought, interaction, { ...link, targetKind: undefined }], personId)).toEqual([]);
    expect(topicsForPerson([topic, thought, { ...interaction, participantIds: [] }, link], personId)).toEqual([]);
    expect(topicsForPerson([topic, interaction, link], personId)).toEqual([]);
  });
  it('deduplicates a topic reached through multiple source interactions', () => {
    const second = { ...interaction, id: crypto.randomUUID() };
    const secondLink = { ...link, id: crypto.randomUUID(), interactionId: second.id };
    expect(topicsForPerson([topic, thought, interaction, second, link, secondLink], personId)).toEqual([topic]);
  });
  it('preserves legacy reflection titles and uses neutral topic thought categories', () => {
    expect(titleOf(topic)).toBe(topic.name);
    expect(titleOf(thought)).toBe(thought.title);
    expect(titleOf(reflection)).toBe(reflection.content);
    expect(titleOf({ ...reflection, title: '虚构人物感受标题' })).toBe('虚构人物感受标题');
    expect(thoughtTypeLabel('hypothesis')).toBe('推测');
    expect(thoughtTypeLabel('experience')).toBe('经验');
  });
});
