<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue'; import type { BackupPreview } from '@zhijiao/client'; import { client, generation } from '../state'; import { dateLabel } from '../format'; import Drawer from './Drawer.vue';
import ValidatedForm from './ValidatedForm.vue'; import FormField from './FormField.vue'; import FormNotice from './FormNotice.vue'; import { secretRule, type FormRule } from '../validation';
const emit = defineEmits<{ close: []; imported: [vaultId: string] }>();
const text = ref(''); const secret = ref(''); const recovery = ref(false); const preview = ref<BackupPreview>(); const confirmed = ref(false); const busy = ref(false); const error = ref(''); let active = true;
const selectedFile = ref<File>(); const reading = ref(false); let readVersion = 0;
const fileRule: FormRule = value => !(value instanceof File) ? '请选择加密备份文件。' : value.size > 200_000_000 ? '备份超过 200 MB 的验证上限。' : true;
async function read(event: Event) {
 const version = ++readVersion; preview.value = undefined; confirmed.value = false; text.value = ''; error.value = ''; selectedFile.value = (event.target as HTMLInputElement).files?.[0];
 const file = selectedFile.value; if (!file || file.size > 200_000_000) { reading.value = false; return; }
 reading.value = true;
 try { const value = await file.text(); if (active && version === readVersion) text.value = value; }
 catch { if (active && version === readVersion) error.value = '无法读取该备份文件，请重新选择。'; }
 finally { if (active && version === readVersion) reading.value = false; }
}
function restart() { readVersion++; preview.value = undefined; confirmed.value = false; selectedFile.value = undefined; text.value = ''; secret.value = ''; error.value = ''; }
async function verify() { if (busy.value) return; busy.value = true; error.value = ''; const token = generation; try { const result = await client.value!.previewBackup(text.value, secret.value, { recovery: recovery.value }); if (active && token === generation) preview.value = result; } catch { if (active && token === generation) error.value = '备份未通过验证。请确认解锁口令或恢复秘密，并检查文件是否完整。'; } finally { secret.value = ''; if (active && token === generation) busy.value = false; } }
async function restore() { if (!preview.value || !confirmed.value || busy.value) return; busy.value = true; const token = generation; try { const id = preview.value.vaultId; await client.value!.importBackup(preview.value, { confirm: true }); if (active && token === generation) emit('imported', id); } catch { if (active && token === generation) error.value = '导入未完成：当前设备的同一资料库必须没有记录或待同步操作，且备份须属于当前账号。请在干净设备恢复，不要清空现有数据。'; } finally { if (active && token === generation) busy.value = false; } }
onBeforeUnmount(() => { active = false; readVersion++; secret.value = ''; text.value = ''; selectedFile.value = undefined; preview.value = undefined; });
</script>
<template>
<Drawer title="从加密备份恢复" subtitle="先验证，再明确确认" :busy="busy || reading" @close="emit('close')">
  <p class="notice">恢复会在本机验证历史、图片与完整性。为保护已有内容，当前实现仅允许导入空的本机资料库；不会覆盖已有记录。恢复后仍需解锁并同步。</p>
  <ValidatedForm v-if="!preview" id="backup-verify-form" :submit="verify" :busy="busy || reading" :server-error="error">
    <FormField name="backupFile" label="加密备份文件" :model-value="selectedFile" :rules="fileRule" type="custom" required>
      <template #default="{ attrs, blur }"><input v-bind="attrs" type="file" accept="application/json,.json,.zhijiao" :disabled="busy || reading" @change="read" @blur="blur"></template>
    </FormField>
    <label class="checkbox"><input v-model="recovery" type="checkbox" :disabled="busy || reading">使用独立恢复秘密</label>
    <FormField v-model="secret" name="backupSecret" :label="recovery ? '恢复秘密' : '备份对应的资料库解锁口令'" :rules="secretRule(recovery)" type="password" autocomplete="off" required :disabled="busy || reading" />
    <button class="button secondary" :disabled="busy || reading">{{ reading ? '正在读取文件…' : busy ? '正在本机验证…' : '验证并预览' }}</button>
  </ValidatedForm>
  <section v-else class="panel backup-preview"><h3>已验证的备份</h3><dl class="definition-list"><dt>备份时间</dt><dd>{{ dateLabel(preview.createdAt) }}</dd><dt>人物</dt><dd>{{ preview.people }}</dd><dt>记录及历史版本</dt><dd>{{ preview.records }}</dd><dt>加密图片版本</dt><dd>{{ preview.assets }}</dd><dt>待同步操作</dt><dd>{{ preview.pending }}</dd></dl><p class="muted">备份之后的新记录不会包含在此文件中。原有历史与同步删除标记保留。</p><label class="checkbox"><input v-model="confirmed" type="checkbox">我确认将该备份导入空的本机资料库</label><button class="text-button" :disabled="busy" @click="restart">重新选择文件</button><FormNotice v-if="error" :message="error" /></section>
  <template #footer><button class="button secondary" :disabled="busy || reading" @click="emit('close')">取消</button><button class="button primary" :disabled="!preview || !confirmed || busy || reading" @click="restore">{{ busy ? '正在导入…' : '确认导入' }}</button></template>
</Drawer>
</template>
