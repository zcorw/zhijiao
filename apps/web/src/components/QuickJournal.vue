<script setup lang="ts">
import { ref, computed } from 'vue';
import type { Person, Interaction, Entity, PersonReflection, FollowUp } from '@zhijiao/shared';
import { partialDateSchema } from '@zhijiao/shared';
import { base, directory, entities } from '../state'; import { label, localDate, interactionTitle } from '../format';
import ValidatedForm from './ValidatedForm.vue'; import FormField from './FormField.vue';
import DateTimeInput from './DateTimeInput.vue';
import { requiredText, optionalText, interactionContentRule, partialDateRule, datetimeRule, timezoneRule, peopleRule, type FormRule } from '../validation';
import Drawer from './Drawer.vue'; import PersonPicker from './PersonPicker.vue'; import Icon from './Icon.vue';
const props = defineProps<{ personId?: string; busy?: boolean; failure?: string }>(); const emit = defineEmits<{ save: [records: Entity[], remove: string[]]; close: [] }>();
const selected = ref<string[]>(props.personId ? [props.personId] : []); const drafts = ref<Person[]>([]); const picker = ref(false); const error = ref('');
const title = ref(''); const content = ref(''); const date = ref(localDate()); const exactTime = ref(''); const timezone = ref(Intl.DateTimeFormat().resolvedOptions().timeZone); const channel = ref(''); const location = ref(''); const eventKind = ref('');
interface ReflectionDraft { id: string; personId: string; mode: 'new' | 'existing'; existingId: string; type: PersonReflection['type']; content: string; relation: 'arose' | 'supports' | 'contradicts' | 'revises'; explanation: string }
const reflections = ref<ReflectionDraft[]>([]); const taskOpen = ref(false); const taskTitle = ref(''); const taskType = ref<FollowUp['type']>('promise'); const responsibility = ref<FollowUp['responsibility']>('me'); const dueDate = ref(''); const details = ref('');
const needsPeople = computed(() => taskOpen.value || reflections.value.length > 0);
const names = computed(() => selected.value.map(id => ({ id, name: directory.value.find(person => person.personId === id)?.displayName ?? drafts.value.find(person => person.id === id)?.displayName ?? '尚未同步人物' })));
const availableReflections = computed(() => entities.value.filter((entity): entity is PersonReflection => entity.kind === 'reflection' && selected.value.includes(entity.personId)));
function addReflection() { reflections.value.push({ id: crypto.randomUUID(), personId: '', mode: 'new', existingId: '', type: 'feeling', content: '', relation: 'arose', explanation: '' }); }
function choose(ids: string[], people: Person[]) { selected.value = ids; drafts.value = people; picker.value = false; }
function reflectionPersonRule(): FormRule { return value => selected.value.includes(String(value)) || '请选择这条感受针对的参与人物。'; }
function existingReflectionRule(item: ReflectionDraft): FormRule { return value => availableReflections.value.some(record => record.id === value && record.personId === item.personId) || '请选择此人物的已有感受或印象。'; }
function submit() {
 if (props.busy) return; error.value = '';
 date.value = date.value.trim(); dueDate.value = dueDate.value.trim(); timezone.value = timezone.value.trim();
 if (!title.value.trim() && !content.value.trim()) { error.value = '请写下事件或感受，也可以只填写交往标题。'; return; }
 if (needsPeople.value && !selected.value.length) { error.value = '针对人物的感受或事项需要关联人物，也可移除附加条目后只保存事件或感受。'; return; }
 if (date.value && !partialDateSchema.safeParse(date.value).success || taskOpen.value && dueDate.value && !partialDateSchema.safeParse(dueDate.value).success) { error.value = '日期格式不正确，请保留已知精度。'; return; }
 if (exactTime.value) { try { new Intl.DateTimeFormat('zh-CN', { timeZone: timezone.value }); if (!Number.isFinite(new Date(exactTime.value).getTime())) throw Error(); } catch { error.value = '请填写合法的精确时间和 IANA 时区。'; return; } }
 const event: Interaction = { ...base(), kind: 'interaction', title: interactionTitle(title.value, content.value), participantIds: [...selected.value], content: content.value.trim(), ...(date.value ? { occurredOn: date.value } : {}), ...(exactTime.value ? { occurredAt: new Date(exactTime.value).toISOString(), timezone: timezone.value } : {}), ...(channel.value.trim() ? { channel: channel.value.trim() } : {}), ...(location.value.trim() ? { location: location.value.trim() } : {}), ...(eventKind.value.trim() ? { kindOfInteraction: eventKind.value.trim() } : {}) };
 const records: Entity[] = [...drafts.value.filter(person => selected.value.includes(person.id)), event];
 for (const item of reflections.value) {
   if (!selected.value.includes(item.personId)) { error.value = '每条感受都需要明确针对一名参与人物。'; return; }
   let reflectionId = item.existingId;
   if (item.mode === 'new') { if (!item.content.trim()) { error.value = '请填写感受，或移除空的感受条目。'; return; } const reflection: PersonReflection = { ...base(), kind: 'reflection', personId: item.personId, type: item.type, content: item.content.trim(), recordedOn: localDate(), status: 'current' }; records.push(reflection); reflectionId = reflection.id; }
   else if (!availableReflections.value.some(reflection => reflection.id === reflectionId && reflection.personId === item.personId)) { error.value = '请选择此人物的已有感受或印象。'; return; }
   records.push({ ...base(), kind: 'reflectionLink', reflectionId, interactionId: event.id, relationType: item.relation, explanation: item.explanation.trim() || undefined });
 }
 if (taskOpen.value && taskTitle.value.trim()) records.push({ ...base(), kind: 'followUp', title: taskTitle.value.trim(), personIds: [...selected.value], type: taskType.value, responsibility: responsibility.value, sourceInteractionId: event.id, details: details.value.trim() || undefined, dueDate: dueDate.value || undefined, status: 'pending' });
 if (taskOpen.value && !taskTitle.value.trim()) { error.value = '请填写事项标题，或收起该事项。'; return; }
 emit('save', records, []);
}
</script>
<template>
<Drawer title="记一笔" subtitle="记住这次相处" :busy="busy" @close="emit('close')">
  <ValidatedForm id="journal-form" :submit="submit" :busy="busy" :server-error="error || failure">
    <FormField name="people" label="关联人物" :model-value="selected" :rules="needsPeople ? peopleRule : undefined" type="custom" :required="needsPeople" :hint="needsPeople ? '针对人物的感受或事项需要关联人物；可移除附加条目后只保存事件或感受。' : '可不选，事件或感受会直接保存为完整交往记录，以后也可补关联。'">
      <template #default="{ attrs, blur }"><button v-bind="attrs" type="button" class="people-select" @click="picker = true" @blur="blur"><Icon name="people" />{{ names.map(person => person.name).join('、') || '选择人物（可不选）' }}<Icon name="arrow" :size="16" /></button></template>
    </FormField>
    <FormField v-model="title" name="title" label="这次交往" :rules="optionalText('交往标题', 300)" hint="可留空，将使用事件或感受的首行作为标题。" placeholder="给这条记录一个简短标题（可不填）" :disabled="busy" />
    <FormField v-model="content" name="content" label="事件或感受" :rules="interactionContentRule(title)" :required="!title.trim()" type="textarea" :rows="5" placeholder="发生的事、相处的细节，或此刻想记下的感受…" :disabled="busy" />
      <FormField :model-value="date" name="date" label="日期" :rules="partialDateRule('日期')" type="custom" hint="按已知精度记录，可留空。"><template #default="{ attrs, blur }"><DateTimeInput v-model="date" :input-attrs="attrs" label="日期" :disabled="busy" @blur="blur" /></template></FormField>
    <details class="form-details"><summary>时间、渠道和地点</summary><div class="form-grid">
      <FormField :model-value="exactTime" name="exactTime" label="精确时间（可不填）" :rules="datetimeRule" type="custom"><template #default="{ attrs, blur }"><DateTimeInput v-model="exactTime" :input-attrs="attrs" label="精确时间（可不填）" mode="datetime" :disabled="busy" @blur="blur" /></template></FormField>
      <FormField v-if="exactTime" v-model="timezone" name="timezone" label="时区" :rules="timezoneRule(() => !!exactTime)" required :disabled="busy" />
      <FormField v-model="eventKind" name="eventKind" label="交往类型" :rules="optionalText('交往类型')" placeholder="见面、消息、通话…" :disabled="busy" />
      <FormField v-model="channel" name="channel" label="渠道" :rules="optionalText('渠道')" :disabled="busy" />
      <FormField v-model="location" name="location" label="地点" :rules="optionalText('地点')" :disabled="busy" />
    </div></details>
    <section class="form-section"><div class="section-title"><h3>我的感受与印象</h3><button type="button" class="text-button" :disabled="busy" @click="addReflection"><Icon name="plus" :size="16" />添加</button></div>
      <p v-if="!reflections.length" class="muted">可选，针对具体人物。只记当时的感受，可直接写在上方“事件或感受”中。</p>
      <div v-for="(item, index) in reflections" :key="item.id" class="nested-form">
        <FormField v-model="item.personId" :name="'reflections.' + item.id + '.person'" label="针对谁" :rules="reflectionPersonRule()" type="select" required :options="[{ value: '', label: '请选择具体人物' }, ...names.map(person => ({ value: person.id, label: person.name }))]" />
        <div class="segmented"><button type="button" :class="{ active: item.mode === 'new' }" @click="item.mode = 'new'">新感受</button><button type="button" :class="{ active: item.mode === 'existing' }" @click="item.mode = 'existing'">已有印象</button></div>
        <template v-if="item.mode === 'new'">
          <FormField v-model="item.type" :name="'reflections.' + item.id + '.type'" label="类型" type="select" :options="['feeling','hypothesis','experience'].map(value => ({ value, label: label(value) }))" />
          <FormField v-model="item.content" :name="'reflections.' + item.id + '.content'" label="我的想法" :rules="requiredText('感受或想法')" type="textarea" required placeholder="我感觉… / 我暂时觉得…" />
        </template>
        <FormField v-else v-model="item.existingId" :name="'reflections.' + item.id + '.existing'" label="关联的感受或印象" :rules="existingReflectionRule(item)" type="select" required :options="[{ value: '', label: '选择已有印象' }, ...availableReflections.filter(record => record.personId === item.personId).map(record => ({ value: record.id, label: record.content.slice(0, 80) }))]" />
        <FormField v-model="item.relation" :name="'reflections.' + item.id + '.relation'" label="这次交往对它的影响" type="select" :options="['arose','supports','contradicts','revises'].map(value => ({ value, label: label(value) }))" />
        <FormField v-model="item.explanation" :name="'reflections.' + item.id + '.explanation'" label="说明" type="textarea" :rules="optionalText('说明')" :rows="2" />
        <button type="button" class="text-button danger" @click="reflections.splice(index, 1)">移除此条感受</button>
      </div>
    </section>
    <section class="form-section"><div class="section-title"><h3>约定或计划</h3><button type="button" class="text-button" :disabled="busy" @click="taskOpen = !taskOpen">{{ taskOpen ? '收起' : '添加事项' }}</button></div><div v-if="taskOpen" class="form-grid">
      <FormField v-model="taskTitle" name="taskTitle" label="事项标题" :rules="requiredText('事项标题', 300)" required placeholder="接下来需要做什么" />
      <FormField v-model="taskType" name="taskType" label="类型" type="select" :options="[{ value: 'promise', label: '约定' }, { value: 'plan', label: '个人计划' }]" />
      <FormField v-model="responsibility" name="responsibility" label="由谁负责" type="select" :options="[{ value: 'me', label: '我' }, { value: 'other', label: '对方' }, { value: 'joint', label: '共同' }]" />
      <FormField :model-value="dueDate" name="dueDate" label="期限日期（可不填）" :rules="partialDateRule('期限日期')" type="custom"><template #default="{ attrs, blur }"><DateTimeInput v-model="dueDate" :input-attrs="attrs" label="期限日期（可不填）" :disabled="busy" @blur="blur" /></template></FormField>
      <FormField v-model="details" name="details" label="细节" :rules="optionalText('事项细节')" type="textarea" :rows="2" />
    </div></section>
    <p class="muted form-note">这次交往、感受与事项会一次保存，事件依据自动关联。</p>
  </ValidatedForm>
  <template #footer><button class="button secondary" :disabled="busy" @click="emit('close')">取消</button><button class="button primary" type="submit" form="journal-form" :disabled="busy">{{ busy ? '正在加密保存…' : '保存这一笔' }}</button></template>
</Drawer>
<PersonPicker v-if="picker" multiple allow-empty :selected="selected" :initial-drafts="drafts" @confirm="choose" @cancel="picker = false" />
</template>
