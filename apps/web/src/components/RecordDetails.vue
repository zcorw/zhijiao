<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { Entity, ReflectionInteraction } from '@zhijiao/shared';
import { entities, directory } from '../state';
import { titleOf, label, dateLabel, thoughtTypeLabel } from '../format';
import Drawer from './Drawer.vue'; import Icon from './Icon.vue'; import InteractionAnalysis from './InteractionAnalysis.vue';
const props = defineProps<{ record: Entity }>();
const emit = defineEmits<{ close: []; edit: [record: Entity]; history: [record: Entity]; remove: [record: Entity]; open: [record: Entity]; addReflection: [interactionId: string]; addThought: [interactionId: string]; evolve: [record: Entity]; topic: [topicId: string] }>();
const analysisOpen = ref(false);
watch(() => props.record.id, () => { analysisOpen.value = false; });
const isReflection = computed(() => props.record.kind === 'reflection' || props.record.kind === 'thought');
const fieldLabels: Record<string, string> = { fullName:'正式姓名',aliases:'别名',summary:'摘要',metContext:'相识背景',metOn:'相识日期',birthday:'生日',notes:'备注',status:'状态',type:'类型',value:'联系内容',preferred:'优先使用',basis:'来源性质',category:'类别',sourceNote:'来源说明',sourceInteractionId:'来源交往',learnedOn:'获知日期',validFrom:'有效期起',validTo:'有效期止',supersedesFactId:'替代事实',kindOfInteraction:'交往类型',occurredOn:'发生日期',occurredAt:'发生精确时间',timezone:'时区',channel:'渠道',location:'地点',content:'内容',context:'语境',evidence:'支持理由',counterEvidence:'反例或其他解释',certainty:'主观把握',recordedOn:'形成日期',recordedAt:'形成精确时间',supersedesId:'修正的旧印象',responsibility:'责任',details:'细节',dueDate:'期限日期',dueAt:'精确期限',completedAt:'完成时间',label:'用途说明',description:'议题说明' };
const fields = computed(() => Object.entries(props.record).filter(([key, value]) => key in fieldLabels && value !== undefined && value !== '' && !(props.record.kind === 'thought' && key === 'supersedesId')).map(([key, value]) => {
  const related = key.endsWith('Id') ? entities.value.find(record => record.id === value) : undefined;
  return { key, title: fieldLabels[key], related, value: key.endsWith('Id') ? related ? titleOf(related) : '已删除或尚未同步的记录' : Array.isArray(value) ? value.join('、') : typeof value === 'boolean' ? value ? '是' : '否' : key === 'type' && props.record.kind === 'thought' ? thoughtTypeLabel(String(value)) : ['status','type','basis','responsibility'].includes(key) ? label(String(value)) : /On$|Date$|At$/.test(key) ? dateLabel(String(value)) : String(value) };
}));
const participantIds = computed(() => 'participantIds' in props.record ? props.record.participantIds : 'personIds' in props.record ? props.record.personIds : 'personId' in props.record ? [props.record.personId] : []);
const links = computed(() => entities.value.filter((record): record is ReflectionInteraction => record.kind === 'reflectionLink' && (isReflection.value ? record.reflectionId === props.record.id && (record.targetKind ?? 'reflection') === props.record.kind : props.record.kind === 'interaction' && record.interactionId === props.record.id)).map(record => {
  const relatedId = isReflection.value ? record.interactionId : record.reflectionId;
  const relatedKind = isReflection.value ? 'interaction' : record.targetKind ?? 'reflection';
  return { record, related: entities.value.find(entity => entity.id === relatedId && entity.kind === relatedKind) };
}));
const linkGroups = computed(() => isReflection.value ? [{ title: '来源交往', items: links.value }] : [
  { title: '人物感受', items: links.value.filter(item => (item.record.targetKind ?? 'reflection') === 'reflection') },
  { title: '议题思考', items: links.value.filter(item => item.record.targetKind === 'thought') }
]);
const topicRecord = computed(() => props.record.kind === 'thought' ? entities.value.find(record => record.kind === 'topic' && record.id === (props.record.kind === 'thought' ? props.record.topicId : '')) : undefined);
const quote = computed(() => isReflection.value && 'quote' in props.record ? props.record.quote : undefined);
const quoteSource = computed(() => quote.value?.sourceInteractionId ? entities.value.find(record => record.kind === 'interaction' && record.id === quote.value?.sourceInteractionId) : undefined);
const quoteSpeaker = computed(() => quote.value?.speakerPersonId ? directory.value.find(person => person.personId === quote.value?.speakerPersonId)?.displayName ?? quote.value.speakerName ?? '已删除或尚未同步的表达者' : quote.value?.speakerName ?? '表达者未注明');
const tags = computed(() => 'tagIds' in props.record ? props.record.tagIds?.map(id => entities.value.find(record => record.kind === 'tag' && record.id === id)).filter((record): record is Extract<Entity, { kind: 'tag' }> => record?.kind === 'tag') ?? [] : []);
const previousThought = computed(() => props.record.kind === 'thought' && props.record.supersedesId ? entities.value.find(record => record.kind === 'thought' && record.id === (props.record.kind === 'thought' ? props.record.supersedesId : '')) : undefined);
const hasSuccessors = computed(() => isReflection.value && entities.value.some(record => (record.kind === 'thought' || record.kind === 'reflection') && record.kind === props.record.kind && record.supersedesId === props.record.id));
const laterThoughts = computed(() => props.record.kind === 'thought' ? entities.value.filter(record => record.kind === 'thought' && record.supersedesId === props.record.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)) : []);
</script>
<template>
  <Drawer :title="titleOf(record)" :subtitle="record.kind === 'reflection' ? '人物感受' : label(record.kind)" @close="emit('close')">
    <p v-if="participantIds.length" class="muted form-note">{{ record.kind === 'reflection' ? '评价人物' : record.kind === 'interaction' ? '交往参与者' : '涉及人物' }}</p>
    <div v-if="participantIds.length" class="record-participants"><span v-for="id in participantIds" :key="id" class="chip">{{ directory.find(person => person.personId === id)?.displayName || '已删除或尚未同步人物' }}</span></div>
    <p v-else-if="record.kind === 'interaction'" class="muted">未关联人物，可在编辑时补关联。</p>
    <div v-if="record.kind === 'interaction'" class="form-section">
      <div class="tag-options"><button class="button secondary" @click="emit('addReflection', record.id)"><Icon name="plus" :size="16" />添加人物感受</button><button class="button secondary" @click="emit('addThought', record.id)"><Icon name="plus" :size="16" />添加议题思考</button></div>
      <button class="button secondary record-analysis-button" @click="analysisOpen = true"><Icon name="people" :size="17" />分析人物与事项</button>
    </div>
    <template v-if="record.kind === 'thought'"><p class="muted form-note">思考作者：我</p><button class="link-card" :disabled="!topicRecord" @click="emit('topic', record.topicId)"><span class="badge">所属议题</span><strong>{{ topicRecord ? titleOf(topicRecord) : '已删除或尚未同步的议题' }}</strong></button></template>
    <p v-else-if="record.kind === 'reflection'" class="muted form-note">记录作者：我</p>
    <dl class="definition-list record-definition"><template v-for="field in fields" :key="field.key"><dt>{{ field.title }}</dt><dd class="preserve"><button v-if="field.related" class="text-button" @click="emit('open', field.related)">{{ field.value }}</button><template v-else>{{ field.value }}</template></dd></template></dl>
    <div v-if="tags.length" class="tag-options form-section"><span v-for="tag in tags" :key="tag.id" class="chip">{{ tag.name }}</span></div>
    <section v-if="quote" class="form-section"><h3>引用 · {{ quote.kind === 'verbatim' ? '原话' : '转述' }}</h3><p class="muted">表达者：{{ quoteSpeaker }}</p><p class="preserve">{{ quote.text }}</p><button v-if="quote.sourceInteractionId" class="text-button" :disabled="!quoteSource" @click="quoteSource && emit('open', quoteSource)">引用来源：{{ quoteSource ? titleOf(quoteSource) : '已删除或尚未同步的交往' }}</button></section>
    <template v-for="group in linkGroups" :key="group.title"><section v-if="group.items.length" class="form-section"><h3>{{ group.title }}</h3><button v-for="item in group.items" :key="item.record.id" class="link-card" :disabled="!item.related" @click="item.related && emit('open', item.related)"><span class="badge">{{ label(item.record.relationType) }}</span><strong>{{ item.related ? titleOf(item.related) : '已删除或尚未同步的记录' }}</strong><p v-if="item.related?.kind === 'interaction'">发生于 {{ dateLabel(item.related.occurredAt || item.related.occurredOn) }}</p><p v-else-if="item.related?.kind === 'thought' || item.related?.kind === 'reflection'">形成于 {{ dateLabel(item.related.recordedAt || item.related.recordedOn) }}</p><p v-if="item.record.explanation">{{ item.record.explanation }}</p></button></section></template>
    <section v-if="record.kind === 'thought'" class="form-section"><h3>认识变化</h3><button v-if="record.supersedesId" class="link-card" :disabled="!previousThought" @click="previousThought && emit('open', previousThought)"><span class="badge">关联的旧思考</span><strong>{{ previousThought ? titleOf(previousThought) : '已删除或尚未同步的思考' }}</strong></button><button v-for="thought in laterThoughts" :key="thought.id" class="link-card" @click="emit('open', thought)"><span class="badge">后续思考</span><strong>{{ titleOf(thought) }}</strong></button><p class="muted form-note">修正表述可编辑并保留历史；认识变化时追加一条新思考。</p><button class="button secondary" @click="emit('evolve', record)"><Icon name="plus" :size="16" />追加新思考</button></section>
    <p class="muted form-note">更新于 {{ dateLabel(record.updatedAt) }}</p><p v-if="hasSuccessors" class="muted form-note">已有后续认识关联本条记录，请先处理后续记录再删除，以保留完整的认识变化。</p><button class="text-button danger" :disabled="hasSuccessors" @click="emit('remove', record)">删除这条记录</button>
    <template #footer><button class="button secondary" @click="emit('history', record)"><Icon name="history" :size="17" />查看历史</button><button class="button primary" @click="emit('edit', record)">编辑</button></template>
  </Drawer>
  <InteractionAnalysis v-if="analysisOpen && record.kind === 'interaction'" :record="record" @close="analysisOpen = false" />
</template>
