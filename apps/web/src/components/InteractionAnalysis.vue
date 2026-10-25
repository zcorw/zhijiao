<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import type { Interaction, Person } from '@zhijiao/shared';
import { base, entities, generation, isCurrent, saveEntities, vaultState } from '../state';
import { label } from '../format';
import { analysisAvailability, buildAnalysisRecords, createAnalysisDraft, requestInteractionAnalysis, type AnalysisDraft } from '../interaction-analysis';
import Drawer from './Drawer.vue';
import DateTimeInput from './DateTimeInput.vue';
import Icon from './Icon.vue';
import '../interaction-analysis.css';

const props = defineProps<{ record: Interaction }>();
const emit = defineEmits<{ close: [] }>();
// Keep the analyzed version so later sync or edits cannot silently change the source.
const source: Interaction = { ...props.record, participantIds: [...props.record.participantIds] };
const token = generation;
const checking = ref(true);
const available = ref(false);
const provider = ref('');
const analyzing = ref(false);
const saving = ref(false);
const saved = ref(false);
const error = ref('');
const errorElement = ref<HTMLElement>();
const draft = ref<AnalysisDraft>();
let controller = new AbortController();
const people = computed(() => entities.value.filter((entry): entry is Person => entry.kind === 'person').sort((a, b) => a.displayName.localeCompare(b.displayName, 'zh-CN')));
const selectedPeople = computed(() => draft.value?.people.filter(person => person.selected && !person.isSelf) ?? []);
const selectedReflections = computed(() => draft.value?.reflections.filter(item => item.selected) ?? []);
const selectedFollowUps = computed(() => draft.value?.followUps.filter(item => item.selected) ?? []);
const newPeople = computed(() => selectedPeople.value.filter(person => person.targetId === 'new'));
const selectedCount = computed(() => newPeople.value.length + selectedReflections.value.length + selectedFollowUps.value.length);
const empty = computed(() => draft.value && !draft.value.people.some(person => !person.isSelf) && !draft.value.reflections.length && !draft.value.followUps.length);

function name(key: string) { return draft.value?.people.find(person => person.key === key)?.name ?? '未识别人物'; }
function ready(keys: string[]) {
  const targets = keys.map(key => draft.value?.people.find(person => person.key === key)).filter(person => person && !person.isSelf);
  return targets.length > 0 && targets.every(person => person?.selected && !!person.targetId);
}
function deselectUnavailable() {
  if (!draft.value) return;
  for (const item of draft.value.reflections) if (!ready([item.personKey])) item.selected = false;
  for (const item of draft.value.followUps) if (!ready(item.personKeys)) item.selected = false;
}
function close() { if (saving.value) return; controller.abort(); emit('close'); }
async function showError(message: string) {
  error.value = message;
  await nextTick();
  errorElement.value?.focus();
}
async function check() {
  checking.value = true; error.value = '';
  try {
    const result = await analysisAvailability(controller.signal);
    if (!isCurrent(token)) return;
    available.value = result.available; provider.value = result.providerLabel ?? '';
  } catch (cause) {
    if (!controller.signal.aborted && isCurrent(token)) await showError(cause instanceof Error ? cause.message : '暂时无法检查分析服务，请重试。');
  } finally { if (isCurrent(token)) checking.value = false; }
}
async function analyze() {
  if (analyzing.value || !available.value || saving.value || saved.value) return;
  controller.abort(); controller = new AbortController();
  analyzing.value = true; error.value = '';
  try {
    const result = await requestInteractionAnalysis(source, controller.signal);
    if (!isCurrent(token)) return;
    draft.value = createAnalysisDraft(result, entities.value);
  } catch (cause) {
    if (!controller.signal.aborted && isCurrent(token)) await showError(cause instanceof Error ? cause.message : '分析未完成，请重试。');
  } finally { if (isCurrent(token)) analyzing.value = false; }
}
async function save() {
  if (saving.value || saved.value || !draft.value || !isCurrent(token)) return;
  error.value = ''; saving.value = true;
  try {
    const records = buildAnalysisRecords(source, draft.value, entities.value, () => base());
    if (!isCurrent(token)) return;
    await saveEntities(records);
    if (!isCurrent(token)) return;
    saved.value = true;
  } catch (cause) {
    if (isCurrent(token)) await showError(cause instanceof Error ? cause.message : '保存未完成，筛选内容已保留，请处理同步冲突后重试。');
  } finally { if (isCurrent(token)) saving.value = false; }
}
onMounted(check);
onBeforeUnmount(() => { controller.abort(); draft.value = undefined; error.value = ''; });
</script>

<template>
  <Drawer title="分析人物与事项" subtitle="从这次交往整理，逐条确认后写入" :busy="saving" @close="close">
    <div class="interaction-analysis">
      <p v-if="saved" class="success" role="status">已将确认的人物、感受与印象、事项在本机加密保存，并关联这次交往作为来源。</p>
      <p v-if="error" ref="errorElement" class="error" role="alert" tabindex="-1">{{ error }}</p>
      <template v-if="!saved">
        <div class="analysis-intro">
          <p>描述中的“我”默认指当前操作的用户；引语中的“我”按说话者理解。不会为当前用户自动新建人物。</p>
          <p class="muted">开始分析会将本次交往的标题、内容及日期经本应用服务器发送给 DeepSeek{{ provider ? '（' + provider + '）' : '' }}。分析只生成候选，请检查人物归属和原文依据后再写入。</p>
          <details class="analysis-source"><summary>查看本次交往原文</summary><strong>{{ source.title }}</strong><p class="preserve">{{ source.content || '（仅有标题）' }}</p></details>
        </div>
        <p v-if="checking" class="muted" role="status">正在检查分析服务…</p>
        <p v-else-if="!available && !error" class="notice">尚未配置 DeepSeek 分析服务。请在服务端配置 DeepSeek API 密钥后使用。</p>
        <p v-if="analyzing" class="notice" role="status">正在整理人物、感受与印象及约定事项，可以随时取消。</p>
        <template v-if="draft">
          <p class="notice">候选默认均未选中。先勾选人物并确认对应档案，再选择要写入的感受与事项。已有记录会保留。</p>
          <p v-if="!vaultState?.directoryComplete || !vaultState?.recordsComplete" class="muted">资料仍在同步，已有档案仅显示本机已下载的完整人物。新建前请留意重复人物。</p>
          <div v-if="empty" class="empty compact"><Icon name="journal" :size="28" /><h3>这次没有可写入的候选</h3><p>原文中可能未明确提及其他人物、感受或待办事项。可以保留原有交往记录。</p></div>
          <form v-else id="analysis-review-form" @submit.prevent="save">
            <section class="analysis-section" aria-labelledby="analysis-people-heading">
              <h3 id="analysis-people-heading">涉及的人物 <span class="badge">{{ draft.people.length }}</span></h3>
              <article v-for="person in draft.people" :key="person.key" class="analysis-candidate" :class="{ 'is-selected': person.selected }">
                <p v-if="person.isSelf" class="analysis-self"><strong>{{ person.name }}</strong><span class="badge">当前用户 · 不建人物档案</span></p>
                <label v-else class="checkbox analysis-choice"><input v-model="person.selected" type="checkbox" :aria-label="'选择人物：' + person.name" :disabled="saving" @change="deselectUnavailable"><strong>{{ person.name }}</strong></label>
                <blockquote class="analysis-evidence"><span>原文依据</span>{{ person.mention }}</blockquote>
                <template v-if="!person.isSelf">
                  <label class="field analysis-field"><span>对应人物档案</span><select v-model="person.targetId" :aria-label="person.name + '对应人物档案'" :disabled="!person.selected || saving" :required="person.selected" @change="deselectUnavailable"><option value="">请选择已有档案或新建人物</option><option value="new">新建人物（确认写入时创建）</option><option v-for="existing in people" :key="existing.id" :value="existing.id">{{ existing.displayName }}{{ existing.summary ? ' · ' + existing.summary.slice(0, 40) : '' }}{{ existing.status === 'archived' ? ' · 已归档' : '' }} · {{ existing.id.slice(0, 8) }}</option></select></label>
                  <label v-if="person.targetId === 'new'" class="field analysis-field"><span>新人物姓名</span><input v-model="person.newName" :aria-label="person.name + '新人物姓名'" :disabled="!person.selected || saving" :required="person.selected" maxlength="200"></label>
                  <p v-if="!person.targetId" class="muted analysis-hint">同名或别名不明确时，请手动选择；不会自动合并人物。</p>
                </template>
              </article>
            </section>
            <section class="analysis-section" aria-labelledby="analysis-reflections-heading">
              <h3 id="analysis-reflections-heading">感受与印象 <span class="badge">{{ draft.reflections.length }}</span></h3>
              <p v-if="!draft.reflections.length" class="muted">没有明确的感受与印象候选。</p>
              <article v-for="(item, index) in draft.reflections" :key="index" class="analysis-candidate" :class="{ 'is-selected': item.selected }">
                <label class="checkbox analysis-choice"><input v-model="item.selected" type="checkbox" :aria-label="'选择感受与印象：' + name(item.personKey) + '，第' + (index + 1) + '条'" :disabled="!ready([item.personKey]) || saving"><strong>关于 {{ name(item.personKey) }}</strong><span class="badge">{{ label(item.type) }}</span></label>
                <p v-if="!ready([item.personKey])" class="muted analysis-hint">请先选择对应人物并确认档案。</p>
                <label class="field analysis-field"><span>类型</span><select v-model="item.type" :aria-label="'感受' + (index + 1) + '类型'" :disabled="!item.selected || saving"><option value="feeling">个人感受</option><option value="hypothesis">性格推测</option><option value="experience">相处体会</option></select></label>
                <label class="field analysis-field"><span>内容（可修改）</span><textarea v-model="item.content" :aria-label="'感受' + (index + 1) + '内容'" :disabled="!item.selected || saving" :required="item.selected" rows="3" maxlength="3000" /></label>
                <blockquote class="analysis-evidence"><span>原文依据</span>{{ item.evidence }}</blockquote>
              </article>
            </section>
            <section class="analysis-section" aria-labelledby="analysis-followups-heading">
              <h3 id="analysis-followups-heading">约定与计划 <span class="badge">{{ draft.followUps.length }}</span></h3>
              <p v-if="!draft.followUps.length" class="muted">没有明确的待跟进事项。</p>
              <article v-for="(item, index) in draft.followUps" :key="index" class="analysis-candidate" :class="{ 'is-selected': item.selected }">
                <label class="checkbox analysis-choice"><input v-model="item.selected" type="checkbox" :aria-label="'选择事项：' + item.title" :disabled="!ready(item.personKeys) || saving"><strong>{{ item.title }}</strong></label>
                <p class="muted analysis-hint">涉及：{{ item.personKeys.map(name).join('、') }}</p>
                <p v-if="!ready(item.personKeys)" class="muted analysis-hint">请先选择这件事项涉及的其他人物并确认档案。</p>
                <label class="field analysis-field"><span>事项标题（可修改）</span><input v-model="item.title" :aria-label="'事项' + (index + 1) + '标题'" :disabled="!item.selected || saving" :required="item.selected" maxlength="300"></label>
                <div class="analysis-field-pair">
                  <label class="field analysis-field"><span>类型</span><select v-model="item.type" :aria-label="'事项' + (index + 1) + '类型'" :disabled="!item.selected || saving"><option value="promise">约定</option><option value="plan">个人计划</option></select></label>
                  <label class="field analysis-field"><span>由谁负责</span><select v-model="item.responsibility" :aria-label="'事项' + (index + 1) + '责任'" :disabled="!item.selected || saving"><option value="me">我</option><option value="other">对方</option><option value="joint">共同</option></select></label>
                </div>
                <div class="field analysis-field"><span>期限日期（可不填）</span><DateTimeInput v-model="item.dueDate" :input-attrs="{ 'aria-label': '事项' + (index + 1) + '期限日期' }" :label="'事项' + (index + 1) + '期限日期'" :disabled="!item.selected || saving" /></div>
                <label class="field analysis-field"><span>细节（可修改）</span><textarea v-model="item.details" :aria-label="'事项' + (index + 1) + '细节'" :disabled="!item.selected || saving" rows="2" maxlength="3000" /></label>
                <blockquote class="analysis-evidence"><span>原文依据</span>{{ item.evidence }}</blockquote>
              </article>
            </section>
            <div class="analysis-summary" aria-live="polite"><strong>已选 {{ selectedPeople.length }} 位人物、{{ selectedReflections.length }} 条感受与印象、{{ selectedFollowUps.length }} 件事项</strong><p>其中 {{ newPeople.length }} 位将新建档案。确认后一次加密保存，感受与事项保留本次交往来源。</p></div>
          </form>
        </template>
      </template>
    </div>
    <template #footer>
      <button class="button secondary" :disabled="saving" @click="close">{{ saved ? '关闭' : '取消' }}</button>
      <button v-if="!draft && !saved && !checking && error && !available" class="button primary" @click="check">重试检查</button>
      <button v-else-if="!draft && !saved" class="button primary" :disabled="checking || !available || analyzing" @click="analyze">{{ analyzing ? '正在分析…' : error ? '重试分析' : '开始分析' }}</button>
      <button v-else-if="draft && !saved && !empty" class="button primary" type="submit" form="analysis-review-form" :disabled="saving || !selectedCount">{{ saving ? '正在加密保存…' : '确认写入（' + selectedCount + '）' }}</button>
    </template>
  </Drawer>
</template>
