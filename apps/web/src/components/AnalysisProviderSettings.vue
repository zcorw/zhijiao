<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { interactionAnalysisSettingsSchema, type InteractionAnalysisProvider, type InteractionAnalysisSettings } from '@zhijiao/shared';
import { api, ApiError } from '../auth';
import FormNotice from './FormNotice.vue';

const props = defineProps<{ offline?: boolean }>();
const providerNames = { deepseek: 'DeepSeek', openai: 'OpenAI' } satisfies Record<InteractionAnalysisProvider, string>;
const settings = ref<InteractionAnalysisSettings>();
const choice = ref<InteractionAnalysisProvider | 'default'>('default');
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const message = ref('');
let active = true;

function describe(provider: InteractionAnalysisProvider | null) {
  if (!provider) return '暂无可用服务';
  const model = settings.value?.providers.find(option => option.id === provider)?.model;
  return model ? `${providerNames[provider]} · ${model}` : `${providerNames[provider]}（尚未配置）`;
}

const canSave = computed(() => {
  const current = settings.value;
  if (!current || props.offline || loading.value || saving.value) return false;
  if (choice.value === (current.preferredProvider ?? 'default')) return false;
  return choice.value === 'default' || current.providers.some(option => option.id === choice.value && option.model);
});

function applySettings(value: unknown) {
  const result = interactionAnalysisSettingsSchema.parse(value);
  settings.value = result;
  choice.value = result.preferredProvider ?? 'default';
}

async function load() {
  if (props.offline || loading.value || saving.value) return;
  loading.value = true;
  error.value = '';
  message.value = '';
  try {
    const value = await api<unknown>('/analysis/settings');
    if (active) applySettings(value);
  } catch {
    if (active) error.value = '暂时无法读取分析设置。请检查登录状态和网络后重试。';
  } finally {
    if (active) loading.value = false;
  }
}

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  error.value = '';
  message.value = '';
  try {
    const provider = choice.value === 'default' ? null : choice.value;
    const value = await api<unknown>('/analysis/settings', 'PUT', { provider });
    if (!active) return;
    applySettings(value);
    message.value = '分析设置已保存，下次分析将使用当前服务。';
  } catch (cause) {
    if (active) error.value = cause instanceof ApiError && cause.status === 409
      ? '所选分析服务暂不可用，请刷新配置状态或选择其他服务。'
      : '分析设置未能确认保存。请刷新配置状态后重试。';
  } finally {
    if (active) saving.value = false;
  }
}

watch(() => props.offline, (offline) => { if (!offline) void load(); }, { immediate: true });
onBeforeUnmount(() => { active = false; });
</script>

<template>
  <section class="panel" aria-labelledby="analysis-provider-settings-heading">
    <h2 id="analysis-provider-settings-heading">交往分析服务</h2>
    <p class="muted">开始交往分析时，标题、内容和日期会发送到当前服务。API 密钥由服务器管理。</p>
    <p v-if="offline" class="notice">联网登录后可以查看和更改分析服务。</p>
    <template v-else>
      <p v-if="loading" class="muted" role="status">正在读取分析设置…</p>
      <FormNotice v-if="error" :message="error" />
      <button v-if="error" type="button" class="text-button" :disabled="loading || saving" @click="load">刷新配置状态</button>
      <template v-if="settings">
        <p>当前服务 <strong>{{ describe(settings.provider) }}</strong></p>
        <form class="form-grid" @submit.prevent="save">
          <label class="field">
            <span>分析服务</span>
            <select v-model="choice" :disabled="loading || saving">
              <option value="default">跟随服务器默认（{{ describe(settings.defaultProvider) }}）</option>
              <option v-for="option in settings.providers" :key="option.id" :value="option.id" :disabled="!option.model">{{ describe(option.id) }}</option>
            </select>
          </label>
          <button class="button secondary" type="submit" :disabled="!canSave">{{ saving ? '正在保存…' : '保存分析设置' }}</button>
        </form>
        <p v-if="message" class="success" role="status">{{ message }}</p>
      </template>
    </template>
  </section>
</template>
