<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue';
import type { AvatarRef } from '@zhijiao/shared';
import { client, generation, isCurrent } from '../state';
const props = defineProps<{ name: string; avatar?: AvatarRef; large?: boolean }>();
const host = ref<HTMLElement>(); const url = ref('');
let observer: IntersectionObserver | undefined; let release: (() => void) | undefined; let visible = false; let request = 0;
async function load() {
  const sequence = ++request; release?.(); release = undefined; url.value = '';
  if (!visible || !props.avatar || !client.value) return;
  const token = generation;
  try { const result = await client.value.acquireAvatar(props.avatar, props.large ? 'main' : 'thumb'); if (sequence !== request || !isCurrent(token)) { result.release(); return; } url.value = result.url; release = result.release; } catch { /* Use initials if offline or authentication fails. */ }
}
watch(() => [props.avatar, props.large], load);
onMounted(() => { observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { visible = true; observer?.disconnect(); void load(); } }, { rootMargin: '80px' }); if (host.value) observer.observe(host.value); });
onBeforeUnmount(() => { request++; observer?.disconnect(); release?.(); url.value = ''; });
</script>
<template><span ref="host" class="avatar" :class="{ large }"><img v-if="url" :src="url" alt="" loading="lazy"><span v-else>{{ name.trim().slice(0, 1) || '·' }}</span></span></template>
