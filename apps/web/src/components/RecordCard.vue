<script setup lang="ts">
import type { Entity, Person, DirectoryEntry } from '@zhijiao/shared';
import { dateLabel, label, titleOf, isOverdue, thoughtTypeLabel } from '../format'; import Icon from './Icon.vue';
defineProps<{ record: Entity; people: Array<Person | DirectoryEntry> }>();
const emit = defineEmits<{ open: [record: Entity]; edit: [record: Entity]; complete: [record: Entity] }>();
function names(record: Entity, people: Array<Person | DirectoryEntry>) { const ids = 'participantIds' in record ? record.participantIds : 'personIds' in record ? record.personIds : 'personId' in record ? [record.personId] : []; return ids.map(id => people.find(person => ('personId' in person ? person.personId : person.id) === id)?.displayName ?? '已删除或待同步人物').join('、'); }
</script>
<template>
  <article class="record-card">
    <button v-if="record.kind === 'followUp'" class="task-check" :class="{ done: record.status === 'completed' }" :aria-label="record.status === 'completed' ? '重新设为待办' : '标记完成'" @click="emit('complete', record)"><Icon v-if="record.status === 'completed'" name="check" :size="16" /></button>
    <button class="card-content" @click="emit('open', record)">
      <div class="record-meta"><span>{{ record.kind === 'thought' ? thoughtTypeLabel(record.type) : record.kind === 'reflection' ? label(record.type) : record.kind === 'fact' ? label(record.basis) : label(record.kind) }}</span><span v-if="record.kind === 'interaction'">{{ dateLabel(record.occurredAt || record.occurredOn) }}</span><span v-else-if="record.kind === 'followUp'" :class="{ overdue: isOverdue(record) }">{{ isOverdue(record) ? '已逾期 · ' : '' }}{{ record.dueAt || record.dueDate ? dateLabel(record.dueAt || record.dueDate) : '未设期限' }}</span><span v-else-if="record.kind === 'reflection' || record.kind === 'thought'">{{ dateLabel(record.recordedAt || record.recordedOn) }}</span><span v-if="'status' in record && !['pending','current','active'].includes(record.status)" class="badge">{{ label(record.status) }}</span></div>
      <h3>{{ titleOf(record) }}</h3>
      <p v-if="(record.kind === 'interaction' || record.kind === 'thought' || record.kind === 'reflection' && record.title) && record.content" class="clamp">{{ record.content }}</p>
      <p v-if="record.kind === 'topic' && record.description" class="clamp">{{ record.description }}</p>
      <p v-if="record.kind === 'followUp' && record.details" class="clamp">{{ record.details }}</p>
      <p v-if="record.kind === 'contact'">{{ record.type }}{{ record.label ? ` · ${record.label}` : '' }}{{ record.preferred ? ' · 优先使用' : '' }}</p>
      <small v-if="names(record, people)" class="record-people">{{ names(record, people) }}</small>
    </button>
    <button class="icon-button card-edit" aria-label="编辑记录" @click="emit('edit', record)"><Icon name="edit" :size="17" /></button>
  </article>
</template>
