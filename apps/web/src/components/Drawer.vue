<script lang="ts">let openDrawers = 0;</script>
<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import Icon from './Icon.vue';
defineProps<{ title: string; subtitle?: string; busy?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const panel = ref<HTMLElement>(); let previousFocus: Element | null = null;
function key(event: KeyboardEvent) { if (document.querySelector('.person-picker') || Array.from(document.querySelectorAll('.drawer')).at(-1) !== panel.value) return; if (event.key === 'Escape') emit('close'); if (event.key !== 'Tab' || !panel.value) return; const elements = Array.from(panel.value.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]')); if (!elements.length) return; const first = elements[0]; const last = elements[elements.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } }
onMounted(() => { previousFocus = document.activeElement; document.addEventListener('keydown', key); openDrawers++; document.body.style.overflow = 'hidden'; panel.value?.focus(); });
onBeforeUnmount(() => { document.removeEventListener('keydown', key); openDrawers--; if (!openDrawers) document.body.style.overflow = ''; if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus(); });
</script>
<template><Teleport to="body"><div class="overlay" @click.self="!busy && emit('close')"><section ref="panel" class="drawer" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1"><header class="drawer-heading"><div><p v-if="subtitle" class="eyebrow">{{ subtitle }}</p><h2>{{ title }}</h2></div><button class="icon-button" aria-label="关闭" :disabled="busy" @click="emit('close')"><Icon name="close" /></button></header><div class="drawer-body"><slot /></div><footer v-if="$slots.footer" class="drawer-footer"><slot name="footer" /></footer></section></div></Teleport></template>
