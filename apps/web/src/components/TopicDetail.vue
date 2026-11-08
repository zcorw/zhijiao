<script setup lang="ts">
import { computed } from 'vue';
import type { Entity, Topic, TopicThought, Interaction } from '@zhijiao/shared';
import { entities, directory } from '../state';
import { dateLabel } from '../format';
import Icon from './Icon.vue';
import RecordCard from './RecordCard.vue';
const props = defineProps<{ topic: Topic }>();
const emit = defineEmits<{ back: []; edit: [record: Entity]; add: [topicId: string]; open: [record: Entity]; history: [record: Entity]; remove: [record: Entity] }>();
const thoughts = computed(() => entities.value.filter((record): record is TopicThought => record.kind === 'thought' && record.topicId === props.topic.id).sort((a,b) => (b.recordedAt ?? b.recordedOn ?? b.createdAt).localeCompare(a.recordedAt ?? a.recordedOn ?? a.createdAt)));
function sources(thoughtId: string): Interaction[] {
  const ids = new Set(entities.value.filter(record => record.kind === 'reflectionLink' && record.targetKind === 'thought' && record.reflectionId === thoughtId).map(record => record.kind === 'reflectionLink' ? record.interactionId : ''));
  return entities.value.filter((record): record is Interaction => record.kind === 'interaction' && ids.has(record.id));
}
</script>
<template>
  <div class="topic-detail">
    <button class="text-button back-button" @click="emit('back')"><Icon name="back" :size="17" />返回议题</button>
    <div class="page-heading"><div><p class="eyebrow">围绕问题，持续思考</p><h1>{{ topic.name }}</h1><p v-if="topic.description" class="muted preserve">{{ topic.description }}</p></div><button class="button primary" @click="emit('add', topic.id)"><Icon name="plus" :size="17" />添加思考</button></div>
    <div class="topic-actions"><button class="text-button" @click="emit('edit', topic)">编辑议题</button><button class="text-button" @click="emit('history', topic)"><Icon name="history" :size="16" />议题历史</button><button v-if="!thoughts.length" class="text-button danger" @click="emit('remove', topic)">删除议题</button></div>
    <div class="section-title"><h2>思考时间线</h2><span class="muted">{{ thoughts.length }} 条思考</span></div>
    <p class="muted form-note">按思考形成时间排列。修正表述可编辑，认识变化可在原思考中追加一条新思考。</p>
    <div v-if="thoughts.length" class="thought-timeline">
      <section v-for="thought in thoughts" :key="thought.id" class="thought-entry">
        <RecordCard :record="thought" :people="directory" @open="emit('open', $event)" @edit="emit('edit', $event)" />
        <div class="thought-sources"><span class="eyebrow">来源交往</span><button v-for="source in sources(thought.id)" :key="source.id" class="text-button" @click="emit('open', source)">{{ source.title }} · {{ dateLabel(source.occurredAt || source.occurredOn) }}<Icon name="arrow" :size="13" /></button><p v-if="!sources(thought.id).length" class="muted">来源交往已删除或尚未同步。</p></div>
      </section>
    </div>
    <div v-else class="empty panel"><Icon name="topic" :size="36" /><h3>给这个问题留下第一条思考</h3><p>记录自己的理解，并关联让它产生或变化的交往。</p><button class="button secondary" @click="emit('add', topic.id)">添加思考</button></div>
  </div>
</template>
