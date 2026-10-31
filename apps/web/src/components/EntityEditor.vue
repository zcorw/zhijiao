<script setup lang="ts">
import { ref, computed } from 'vue';
import type { Entity, Person, PersonTag, ReflectionInteraction, Tag, Topic } from '@zhijiao/shared';
import { partialDateSchema } from '@zhijiao/shared';
import { base, entities, directory, vaultState } from '../state';
import { label, titleOf, localDate, interactionTitle } from '../format';
import ValidatedForm from './ValidatedForm.vue'; import FormField from './FormField.vue';
import DateTimeInput from './DateTimeInput.vue';
import { editDateTime } from '../datetime-picker';
import { requiredText, optionalText, interactionContentRule, partialDateRule, datetimeRule, timezoneRule, peopleRule, type FormRule } from '../validation';
import Drawer from './Drawer.vue'; import PersonPicker from './PersonPicker.vue'; import Icon from './Icon.vue';
type EditableKind = 'person' | 'contact' | 'fact' | 'interaction' | 'reflection' | 'followUp' | 'tag' | 'topic' | 'thought';
interface Field { name: string; label: string; type?: 'textarea' | 'select' | 'partial' | 'datetime' | 'checkbox' | 'reference'; required?: boolean; options?: string[]; referenceKind?: Entity['kind']; placeholder?: string }
const props = defineProps<{ kind: EditableKind; entity?: Entity; personId?: string; topicId?: string; interactionId?: string; supersedesId?: string; busy?: boolean; failure?: string }>();
const emit = defineEmits<{ save: [records: Entity[], remove: string[]]; close: [] }>();
const isReflection = props.kind === 'reflection' || props.kind === 'thought';
const defaultValues: Record<EditableKind, Record<string, unknown>> = { person: { status: 'active', aliases: '' }, contact: { type: '电话', status: 'active' }, fact: { basis: 'self-reported', status: 'current' }, interaction: { participantIds: props.personId ? [props.personId] : [], content: '' }, reflection: { type: 'feeling', status: 'current', recordedOn: localDate(), supersedesId: props.supersedesId }, thought: { topicId: props.topicId, type: 'hypothesis', status: 'current', recordedOn: localDate(), supersedesId: props.supersedesId }, topic: {}, followUp: { type: 'plan', responsibility: 'me', status: 'pending', personIds: props.personId ? [props.personId] : [] }, tag: {} };
const draft = ref<Record<string, unknown>>({ ...defaultValues[props.kind], ...props.entity, ...(['contact', 'fact', 'reflection'].includes(props.kind) && props.personId ? { personId: props.personId } : {}) });
if (Array.isArray(draft.value.aliases)) draft.value.aliases = (draft.value.aliases as string[]).join('，');
const duplicatePeople = computed(() => {
 if (props.kind !== 'person') return [];
 const normalizeName = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase();
 const enteredNames = new Set([String(draft.value.displayName ?? ''), String(draft.value.fullName ?? ''), ...String(draft.value.aliases ?? '').split(/[,，\n]/)].map(normalizeName).filter(Boolean));
 if (!enteredNames.size) return [];
 const downloadedPeople = new Map(entities.value.filter((entity): entity is Person => entity.kind === 'person').map(person => [person.id, person]));
 return directory.value.filter(person => person.personId !== props.entity?.id && [person.displayName, ...person.aliases, downloadedPeople.get(person.personId)?.fullName ?? ''].some(name => enteredNames.has(normalizeName(name))));
});
for (const name of ['occurredAt', 'dueAt', 'recordedAt']) if (typeof draft.value[name] === 'string') draft.value[name] = editDateTime(draft.value[name] as string);
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (props.kind === 'interaction' || props.kind === 'followUp') draft.value.timezone ??= timezone;
const fields: Record<EditableKind, Field[]> = {
 person: [{ name: 'displayName', label: '常用称呼', required: true, placeholder: '你平时怎么称呼对方' }, { name: 'summary', label: '一句话辨识', placeholder: '相识背景或共同话题' }, { name: 'fullName', label: '正式姓名' }, { name: 'aliases', label: '昵称 / 别名', placeholder: '用逗号分开' }, { name: 'metContext', label: '相识背景', type: 'textarea' }, { name: 'metOn', label: '相识日期', type: 'partial' }, { name: 'birthday', label: '生日', type: 'partial', placeholder: '--05-12（仅知月日）' }, { name: 'notes', label: '备注', type: 'textarea' }, { name: 'status', label: '来往状态', type: 'select', options: ['active', 'archived'] }],
 contact: [{ name: 'type', label: '方式', required: true }, { name: 'value', label: '号码 / 地址 / 账号', required: true }, { name: 'label', label: '用途说明' }, { name: 'preferred', label: '优先使用', type: 'checkbox' }, { name: 'status', label: '状态', type: 'select', options: ['active', 'inactive', 'unconfirmed'] }],
 fact: [{ name: 'content', label: '事实或偏好', type: 'textarea', required: true }, { name: 'category', label: '类别', placeholder: '如饮食、兴趣、近况' }, { name: 'basis', label: '来源性质', type: 'select', options: ['self-reported', 'observation', 'third-party'], required: true }, { name: 'sourceNote', label: '来源说明', type: 'textarea' }, { name: 'sourceInteractionId', label: '获知的交往', type: 'reference', referenceKind: 'interaction' }, { name: 'learnedOn', label: '获知日期', type: 'partial' }, { name: 'validFrom', label: '有效期起', type: 'partial' }, { name: 'validTo', label: '有效期止', type: 'partial' }, { name: 'status', label: '状态', type: 'select', options: ['current', 'unconfirmed', 'outdated'] }, { name: 'supersedesFactId', label: '替代的旧事实', type: 'reference', referenceKind: 'fact' }],
 interaction: [{ name: 'title', label: '交往标题', placeholder: '一个简短标题（可不填）' }, { name: 'content', label: '事件或感受', type: 'textarea', placeholder: '发生的事，或此刻想记下的感受' }, { name: 'kindOfInteraction', label: '交往类型', placeholder: '见面 / 消息 / 通话' }, { name: 'occurredOn', label: '发生日期', type: 'partial' }, { name: 'occurredAt', label: '精确时间（知道时才填）', type: 'datetime' }, { name: 'timezone', label: '时间所属时区' }, { name: 'channel', label: '沟通渠道' }, { name: 'location', label: '地点' }],
 reflection: [{ name: 'title', label: '感受标题' }, { name: 'type', label: '类型', type: 'select', options: ['feeling', 'hypothesis', 'experience'] }, { name: 'content', label: '我的感受或想法', type: 'textarea', required: true }, { name: 'context', label: '语境与限制', type: 'textarea' }, { name: 'evidence', label: '支持理由', type: 'textarea' }, { name: 'counterEvidence', label: '反例 / 其他解释', type: 'textarea' }, { name: 'certainty', label: '主观把握', placeholder: '如：暂时印象，仍待观察' }, { name: 'recordedOn', label: '记录日期', type: 'partial' }, { name: 'recordedAt', label: '精确形成时间（可不填）', type: 'datetime' }, { name: 'status', label: '状态', type: 'select', options: ['current', 'revised', 'withdrawn'] }, { name: 'supersedesId', label: '修正的旧印象', type: 'reference', referenceKind: 'reflection' }],
 thought: [{ name: 'title', label: '思考标题', required: true }, { name: 'type', label: '内容性质', type: 'select', options: ['feeling', 'hypothesis', 'experience'] }, { name: 'content', label: '思考正文', type: 'textarea', required: true }, { name: 'context', label: '语境与限制', type: 'textarea' }, { name: 'evidence', label: '支持理由', type: 'textarea' }, { name: 'counterEvidence', label: '反例 / 其他解释', type: 'textarea' }, { name: 'certainty', label: '主观把握', placeholder: '如：尚待验证的理解' }, { name: 'recordedOn', label: '形成日期', type: 'partial' }, { name: 'recordedAt', label: '精确形成时间（可不填）', type: 'datetime' }, { name: 'status', label: '状态', type: 'select', options: ['current', 'revised', 'withdrawn'] }, { name: 'supersedesId', label: '认识变化所关联的旧思考', type: 'reference', referenceKind: 'thought' }],
 topic: [{ name: 'name', label: '议题名称', required: true, placeholder: '想持续思考的问题' }, { name: 'description', label: '议题说明', type: 'textarea' }],
 followUp: [{ name: 'title', label: '事项标题', required: true }, { name: 'type', label: '事项类型', type: 'select', options: ['promise', 'plan'] }, { name: 'responsibility', label: '由谁负责', type: 'select', options: ['me', 'other', 'joint'], required: true }, { name: 'details', label: '约定与完成标准', type: 'textarea' }, { name: 'sourceInteractionId', label: '来源交往', type: 'reference', referenceKind: 'interaction' }, { name: 'dueDate', label: '期限日期', type: 'partial' }, { name: 'dueAt', label: '精确截止时间', type: 'datetime' }, { name: 'timezone', label: '时间所属时区' }, { name: 'status', label: '状态', type: 'select', options: ['pending', 'completed', 'cancelled'] }], tag: [{ name: 'name', label: '标签名称', required: true }, { name: 'color', label: '颜色（可不填）', placeholder: '#547353' }]
};
const error = ref(''); const picker = ref(false); const peopleDrafts = ref<Person[]>([]);
const selectionField = props.kind === 'interaction' ? 'participantIds' : props.kind === 'followUp' ? 'personIds' : 'personId';
const usesPeople = !['person', 'tag', 'topic', 'thought'].includes(props.kind); const multiple = props.kind === 'interaction' || props.kind === 'followUp'; const needsPeople = usesPeople && props.kind !== 'interaction';
const selectedIds = computed(() => multiple ? (draft.value[selectionField] as string[] ?? []) : draft.value.personId ? [draft.value.personId as string] : []);
function selectedNames() { return selectedIds.value.map(id => directory.value.find(person => person.personId === id)?.displayName ?? peopleDrafts.value.find(person => person.id === id)?.displayName ?? '尚未同步人物').join('、'); }
function choose(ids: string[], newPeople: Person[]) { draft.value[selectionField] = multiple ? ids : ids[0]; peopleDrafts.value = newPeople; picker.value = false; }
function references(field: Field) { return entities.value.filter(entity => entity.kind === field.referenceKind && entity.id !== props.entity?.id && (!('personId' in entity) || !draft.value.personId || entity.personId === draft.value.personId) && (entity.kind !== 'thought' || entity.topicId === draft.value.topicId)); }
const originalLinks = entities.value.filter((entity): entity is ReflectionInteraction => entity.kind === 'reflectionLink' && entity.reflectionId === props.entity?.id);
const links = ref(originalLinks.map(entity => ({ ...entity })));
function addLink(interactionId = '') { links.value.push({ ...base(), kind: 'reflectionLink', reflectionId: props.entity?.id ?? '', interactionId, relationType: 'arose', explanation: '', ...(props.kind === 'thought' ? { targetKind: 'thought' as const } : {}) }); }
if (isReflection && !props.entity && props.interactionId) addLink(props.interactionId);
const topics = computed(() => entities.value.filter((entity): entity is Topic => entity.kind === 'topic'));
const newTopic = ref(false); const topicName = ref(''); const topicDescription = ref('');
const topicChoice = computed({ get: () => newTopic.value ? '__new__' : String(draft.value.topicId ?? ''), set: (value: string) => { newTopic.value = value === '__new__'; draft.value.topicId = newTopic.value ? undefined : value; } });
const newTopicBase = base();
const quote = ref<{ text: string; kind: 'verbatim' | 'paraphrase'; speakerPersonId: string; speakerName: string; sourceInteractionId: string }>({ text: '', kind: 'paraphrase', speakerPersonId: '', speakerName: '', sourceInteractionId: '', ...(props.entity && 'quote' in props.entity ? props.entity.quote : {}) });
const showQuote = ref(!!quote.value.text);
const quotePeople = computed(() => directory.value.map(person => ({value: person.personId, label: person.displayName})));
const quoteSpeakerRule: FormRule = value => {
 const name = String(value ?? '').trim();
 return name.length > 200 ? '表达者称呼最多 200 个字符。' : quote.value.speakerPersonId || name ? true : '请填写引用表达者称呼。';
};
function sourceOptions() { return [{ value: '', label: '选择交往' }, ...entities.value.filter(record => record.kind === 'interaction').map(event => ({ value: event.id, label: titleOf(event) }))]; }
function validSource(id: string, value: unknown) { return !!value && entities.value.some(record => record.kind === 'interaction' && record.id === value) && !links.value.some(link => link.interactionId === value && link.id !== id); }
function sourceRule(id: string): FormRule { return value => validSource(id, value) || '请选择仍有效且未重复关联的交往。'; }
const tags = computed(() => entities.value.filter((entity): entity is Tag => entity.kind === 'tag'));
const originalTags = entities.value.filter((entity): entity is PersonTag => entity.kind === 'personTag' && entity.personId === props.entity?.id);
const selectedTags = ref(isReflection && props.entity && 'tagIds' in props.entity ? [...props.entity.tagIds ?? []] : originalTags.map(edge => edge.tagId)); const tagName = ref(''); const newTags = ref<Tag[]>([]);
function addTag() { const name = tagName.value.trim(); if (!name || name.length > 200) return; const existing = [...tags.value, ...newTags.value].find(tag => tag.name === name); const tag = existing ?? { ...base(), kind: 'tag' as const, name }; if (!existing) newTags.value.push(tag); if (!selectedTags.value.includes(tag.id)) selectedTags.value.push(tag.id); tagName.value = ''; }
function options(field: Field) {
 if (field.type === 'reference') return [{ value: '', label: '未关联' }, ...references(field).map(record => ({ value: record.id, label: titleOf(record).slice(0, 90) }))];
 const thoughtTypes: Record<string, string> = { feeling: '感受', hypothesis: '推测', experience: '经验' };
 return (field.options ?? []).map(value => ({ value, label: props.kind === 'thought' && field.name === 'type' ? thoughtTypes[value] ?? label(value) : label(value) }));
}
function fieldRule(field: Field): FormRule {
 if (props.kind === 'interaction' && field.name === 'content') return interactionContentRule(String(draft.value.title ?? ''));
 if (field.type === 'partial') return partialDateRule(field.label);
 if (field.type === 'datetime') return datetimeRule;
 if (field.name === 'timezone') return timezoneRule(() => !!(draft.value.occurredAt || draft.value.dueAt));
 if (field.name === 'aliases') return value => {
   const names = String(value ?? '').split(/[,，\n]/).map(name => name.trim()).filter(Boolean);
   return names.length <= 100 && names.every(name => name.length <= 200) || '最多 100 个别名，每个不超过 200 个字符。';
 };
 if (field.name === 'color') return value => !value || /^#[0-9a-fA-F]{6}$/.test(String(value)) || '请填写六位十六进制颜色，如 #547353。';
 if (field.type === 'select') return value => (field.options ?? []).includes(String(value)) || '请选择有效选项。';
 if (field.type === 'reference') return value => !value || references(field).some(record => record.id === value) || '请选择仍有效且属于同一人物或议题的关联记录。';
 const max = ['displayName','fullName','name'].includes(field.name) || props.kind === 'contact' && field.name === 'type' ? 200 : field.name === 'title' ? 300 : props.kind === 'contact' && field.name === 'value' ? 10000 : 100000;
 return field.required ? requiredText(field.label, max) : optionalText(field.label, max);
}
function submit() {
 if (props.busy) return; error.value = '';
 const value: Record<string, unknown> = { ...draft.value, ...base(props.entity), kind: props.kind };
 for (const field of fields[props.kind]) {
   const raw = value[field.name]; if (typeof raw === 'string') value[field.name] = raw.trim();
   if (field.required && !value[field.name]) { error.value = `请填写${field.label}。`; return; }
   if (field.type === 'partial' && value[field.name] && !partialDateSchema.safeParse(value[field.name]).success) { error.value = `${field.label}格式不正确。可填写 YYYY、YYYY-MM、YYYY-MM-DD 或 --MM-DD。`; return; }
   if (field.type === 'datetime' && value[field.name]) {
     const date = new Date(value[field.name] as string); if (!Number.isFinite(date.getTime())) { error.value = '精确时间不合法。'; return; }
     const original = props.entity && field.name in props.entity ? (props.entity as unknown as Record<string, unknown>)[field.name] : undefined;
     value[field.name] = typeof original === 'string' && value[field.name] === editDateTime(original) ? original : date.toISOString();
   }
   // Interaction content is a required string in the encrypted schema; an empty body is valid.
   if (value[field.name] === '' && !(props.kind === 'interaction' && field.name === 'content')) delete value[field.name];
 }
 if (needsPeople && !selectedIds.value.length) { error.value = '请选择至少一名人物。'; return; }
 if (props.kind === 'interaction') {
   value.title = interactionTitle(String(value.title ?? ''), String(value.content ?? ''));
   if (!value.title) { error.value = '请写下事件或感受，也可以只填写交往标题。'; return; }
 }
 if ((value.occurredAt || value.dueAt) && !value.timezone) { error.value = '精确时间需要填写 IANA 时区。'; return; }
 if (value.timezone) { try { new Intl.DateTimeFormat('zh-CN', { timeZone: value.timezone as string }); } catch { error.value = '时区格式不合法，如 Asia/Shanghai。'; return; } }
 if (props.kind === 'person') value.aliases = String(draft.value.aliases ?? '').split(/[,，\n]/).map(alias => alias.trim()).filter(Boolean);
 if (isReflection) {
   if (!links.value.length || links.value.some(link => !validSource(link.id, link.interactionId))) { error.value = '请关联至少一条仍有效的交往，同一交往不重复添加。'; return; }
   if (value.supersedesId && !references(fields[props.kind].find(field => field.name === 'supersedesId')!).some(record => record.id === value.supersedesId)) { error.value = '认识变化只能关联同一人物或议题的旧记录。'; return; }
   value.tagIds = [...selectedTags.value];
   if (showQuote.value) {
     if (!quote.value.text.trim() || !quote.value.speakerPersonId && !quote.value.speakerName.trim()) { error.value = '引用需要填写内容及表达者，不会由交往参与者推定。'; return; }
     if (quote.value.speakerPersonId && !directory.value.some(person => person.personId === quote.value.speakerPersonId)) { error.value = '请选择仍有效的引用表达者，或填写称呼。'; return; }
     if (quote.value.sourceInteractionId && !links.value.some(link => link.interactionId === quote.value.sourceInteractionId)) { error.value = '引用来源请选择已关联的交往。'; return; }
     value.quote = Object.fromEntries(Object.entries(quote.value).map(([key, text]) => [key, text.trim()]).filter(([, text]) => text));
   } else delete value.quote;
 }
 if (props.kind === 'followUp') { if (value.status === 'completed') value.completedAt = value.completedAt ?? new Date().toISOString(); else delete value.completedAt; }
 let topic: Topic | undefined;
 if (props.kind === 'thought') {
   if (newTopic.value) {
     if (!topicName.value.trim() || topicName.value.trim().length > 200) { error.value = '请填写议题名称，最多 200 个字符。'; return; }
     topic = { ...newTopicBase, kind: 'topic', name: topicName.value.trim(), ...(topicDescription.value.trim() ? { description: topicDescription.value.trim() } : {}) };
     value.topicId = topic.id;
   } else if (!topics.value.some(topic => topic.id === value.topicId)) { error.value = '请选择议题，或直接新建一个议题。'; return; }
 }
 const record = value as unknown as Entity; const records: Entity[] = [...peopleDrafts.value.filter(person => selectedIds.value.includes(person.id)), ...(topic ? [topic] : []), record]; const remove: string[] = [];
 if (isReflection) {
   records.push(...newTags.value.filter(tag => selectedTags.value.includes(tag.id)));
   records.push(...links.value.map(link => ({ ...link, ...base(link), reflectionId: record.id, explanation: link.explanation?.trim() || undefined })));
   remove.push(...originalLinks.filter(link => !links.value.some(candidate => candidate.id === link.id)).map(link => link.id));
 }
 if (props.kind === 'person') { records.push(...newTags.value.filter(tag => selectedTags.value.includes(tag.id))); for (const id of selectedTags.value) if (!originalTags.some(edge => edge.tagId === id)) records.push({ ...base(), kind: 'personTag', personId: record.id, tagId: id }); remove.push(...originalTags.filter(edge => !selectedTags.value.includes(edge.tagId)).map(edge => edge.id)); }
 emit('save', records, remove);
}
</script>
<template>
<Drawer :title="(entity ? '编辑' : '新建') + label(kind)" subtitle="在本机加密后保存" :busy="busy" @close="emit('close')">
  <ValidatedForm id="entity-form" :submit="submit" :busy="busy" :server-error="error || failure">
    <div v-if="kind === 'person' && (duplicatePeople.length || !vaultState?.directoryComplete)" class="notice" role="status">
      <p v-if="duplicatePeople.length">已有 {{ duplicatePeople.slice(0, 3).map(person => person.displayName).join('、') }}{{ duplicatePeople.length > 3 ? ' 等 ' + duplicatePeople.length + ' 位人物' : '' }} 的称呼、姓名或别名与本次填写相同。可核对后继续保存，不会自动合并。</p>
      <p v-if="!vaultState?.directoryComplete">人物目录尚未完整同步，同名提示仅检查本机已下载的人物。</p>
    </div>
    <FormField v-if="usesPeople" name="people" :label="kind === 'interaction' ? '关联人物' : kind === 'reflection' ? '评价对象' : multiple ? '涉及人物' : '所属人物'" :model-value="selectedIds" :rules="needsPeople ? peopleRule : undefined" type="custom" :required="needsPeople" :hint="kind === 'interaction' ? '可不选。补关联或取消全部选择都只更新人物关联，事件会保留。' : kind === 'reflection' ? '明确这条感受针对谁，来源交往的参与者不会自动成为评价对象。' : undefined">
      <template #default="{ attrs, blur }"><button v-bind="attrs" type="button" class="people-select" @click="picker = true" @blur="blur"><Icon name="people" />{{ selectedNames() || (kind === 'interaction' ? '选择人物（可不选）' : '选择人物') }}<Icon name="arrow" :size="16" /></button></template>
    </FormField>
    <section v-if="kind === 'thought'" class="form-section">
      <FormField v-model="topicChoice" name="topicId" label="所属议题" type="select" required :disabled="busy" :rules="value => value === '__new__' || topics.some(topic => topic.id === value) || '请选择议题或新建议题。'" :options="[{ value: '', label: '选择议题' }, ...topics.map(topic => ({ value: topic.id, label: topic.name })), { value: '__new__', label: '＋ 直接新建议题' }]" />
      <div v-if="newTopic" class="nested-form">
        <FormField v-model="topicName" name="newTopicName" label="新议题名称" required :rules="requiredText('新议题名称', 200)" :disabled="busy" />
        <FormField v-model="topicDescription" name="newTopicDescription" label="新议题说明" type="textarea" :rules="optionalText('新议题说明')" :disabled="busy" />
        <p class="muted">议题会与本条思考一同保存，取消不会创建。</p>
      </div>
      <p class="muted">记录我对问题的认识。形成时间与来源交往的发生时间分别保存。</p>
    </section>
    <template v-for="field in fields[kind]" :key="field.name">
      <FormField v-if="field.type === 'partial' || field.type === 'datetime'" :name="field.name" :label="field.label" :model-value="draft[field.name]" :rules="fieldRule(field)" :required="field.required" type="custom" :hint="field.type === 'partial' ? '按已知精度记录，可留空；只知月日可输入 --MM-DD。' : field.name === 'recordedAt' ? '24 小时制，按本机时区输入并保存为精确时刻。' : '24 小时制，按本机时区输入；需填写时间所属时区。'">
        <template #default="{ attrs, blur }"><DateTimeInput :model-value="String(draft[field.name] ?? '')" :input-attrs="attrs" :label="field.label" :mode="field.type === 'datetime' ? 'datetime' : 'partial'" :disabled="busy" @update:model-value="draft[field.name] = $event" @blur="blur" /></template>
      </FormField>
      <FormField v-else v-model="draft[field.name]" :name="field.name" :label="field.label" :rules="fieldRule(field)" :required="field.required || kind === 'interaction' && field.name === 'content' && !String(draft.title ?? '').trim()" :type="field.type === 'reference' ? 'select' : field.type || 'text'" :options="options(field)" :placeholder="field.placeholder" :hint="field.name === 'basis' ? '推测请记录在“感受与印象”，不要作为事实。' : kind === 'interaction' && field.name === 'title' ? '可留空，将使用事件或感受的首行作为标题。' : undefined" :disabled="busy" />
    </template>
    <section v-if="isReflection" class="form-section">
      <FormField name="evidenceCount" :label="kind === 'thought' ? '来源交往' : '事件依据'" :model-value="links.length" :rules="value => Number(value) > 0 || '请关联至少一条具体交往。'" type="custom" required :disabled="busy">
        <template #default="{ attrs, blur }"><button v-bind="attrs" type="button" class="text-button" @click="addLink()" @blur="blur"><Icon name="plus" :size="16" />关联交往</button></template>
      </FormField>
      <p class="muted">可关联多次交往，并说明支持、反证或修正。关联只表示来源，参与者不代表赞同。</p>
      <div v-for="(link, index) in links" :key="link.id" class="nested-form">
        <FormField v-model="link.interactionId" :name="'links.' + link.id + '.interaction'" label="具体交往" :rules="sourceRule(link.id)" type="select" required :options="sourceOptions()" :disabled="busy" />
        <FormField v-model="link.relationType" :name="'links.' + link.id + '.relation'" :label="kind === 'thought' ? '如何影响这条思考' : '如何影响这条印象'" type="select" :options="['arose', 'supports', 'contradicts', 'revises'].map(value => ({ value, label: label(value) }))" :disabled="busy" />
        <FormField v-model="link.explanation" :name="'links.' + link.id + '.explanation'" label="说明" type="textarea" :rules="optionalText('说明')" :rows="2" :disabled="busy" />
        <button type="button" class="text-button danger" :disabled="busy" @click="links.splice(index, 1)">移除此关联</button>
      </div>
    </section>
    <section v-if="isReflection" class="form-section">
      <FormField v-model="showQuote" name="showQuote" label="添加引用（可选）" type="checkbox" :disabled="busy" />
      <div v-if="showQuote" class="nested-form">
        <FormField v-model="quote.kind" name="quote.kind" label="引用方式" type="select" :options="[{value:'verbatim',label:'原话'}, {value:'paraphrase',label:'转述'}]" :disabled="busy" />
        <FormField v-model="quote.text" name="quote.text" label="引用内容" type="textarea" required :rules="requiredText('引用内容')" :disabled="busy" />
        <FormField v-model="quote.speakerPersonId" name="quote.speakerPersonId" label="引用表达者（已有的人物）" type="select" :options="[{value:'',label:'不关联人物，填写表达者称呼'}, ...quotePeople]" :disabled="busy" />
        <FormField v-model="quote.speakerName" name="quote.speakerName" label="引用表达者称呼" :rules="quoteSpeakerRule" :required="!quote.speakerPersonId" :disabled="busy" hint="请明确是谁表达，不会从交往参与者推断；思考作者仍是我。" />
        <FormField v-model="quote.sourceInteractionId" name="quote.sourceInteractionId" label="引用来源交往（可选）" type="select" :options="[{value:'',label:'未指定'}, ...sourceOptions().filter(option => links.some(link => link.interactionId === option.value))]" :disabled="busy" />
      </div>
    </section>
    <section v-if="kind === 'person' || isReflection" class="form-section"><h3>{{ isReflection ? '主题标签' : '标签' }}</h3><div class="tag-options"><label v-for="tag in [...tags, ...newTags]" :key="tag.id" class="chip checkbox"><input v-model="selectedTags" type="checkbox" :value="tag.id" :disabled="busy">{{ tag.name }}</label></div><div class="inline-form"><FormField v-model="tagName" name="newTagName" label="新标签名称" :rules="optionalText('标签名称', 200)" placeholder="添加标签" :disabled="busy" /><button type="button" class="button secondary" :disabled="busy" @click="addTag">添加</button></div></section>
    <p class="muted form-note">未知的信息可留空。保存后保留历史版本，可在记录详情中恢复。</p>
  </ValidatedForm>
  <template #footer><button class="button secondary" :disabled="busy" @click="emit('close')">取消</button><button class="button primary" type="submit" form="entity-form" :disabled="busy">{{ busy ? '正在加密保存…' : '保存' }}</button></template>
</Drawer>
<PersonPicker v-if="picker" :selected="selectedIds" :multiple="multiple" :allow-empty="kind === 'interaction'" :initial-drafts="peopleDrafts" @confirm="choose" @cancel="picker = false" />
</template>
