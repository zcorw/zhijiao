<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useId, watch, type InputHTMLAttributes } from 'vue';
import { VueDatePicker, type AriaLabelsConfig } from '@vuepic/vue-datepicker';
import { zhCN } from 'date-fns/locale';
import '@vuepic/vue-datepicker/dist/main.css';
import { changePrecision, datePrecision, fromPickerValue, pickerStart, toPickerValue, type DatePrecision, type PickerValue } from '../partial-date-picker';
import Icon from './Icon.vue';

const props = defineProps<{ modelValue: string; inputAttrs: InputHTMLAttributes; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string]; blur: [event?: Event] }>();
const root = ref<HTMLElement>(); const input = ref<HTMLInputElement>(); const popup = ref<HTMLElement>();
const popupId = `met-date-${useId()}`; const opened = ref(false); const precision = ref<DatePrecision>('day');
let sizeObserver: ResizeObserver | undefined;
const staged = ref(''); const choice = ref<PickerValue>(null); const start = ref(new Date());
const position = ref({ left: '0px', top: '0px', width: '340px', maxHeight: '600px' });
const yearRange = computed<[number, number]>(() => [Math.max(1, start.value.getFullYear() - 75), Math.min(9999, start.value.getFullYear() + 75)]);
const canConfirm = computed(() => fromPickerValue(choice.value, precision.value) !== null);
const ariaLabels: Partial<AriaLabelsConfig> = {
  toggleOverlay: '切换日期选择', menu: '相识日期日历', openYearsOverlay: '快速选择年份', openMonthsOverlay: '选择月份',
  nextMonth: '下个月', prevMonth: '上个月', nextYear: '下一年', prevYear: '上一年',
  yearPicker: () => '选择年份', monthPicker: () => '选择月份',
  day: day => `选择 ${fromPickerValue(day.value, 'day') ?? ''}`,
};

function place() {
  if (!opened.value || !root.value || !popup.value) return;
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0, top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
  const field = root.value.getBoundingClientRect(); const panelWidth = Math.min(340, width - 24);
  const panelHeight = Math.min(popup.value.offsetHeight, height - 24);
  const below = field.bottom + 8;
  const panelTop = below + panelHeight <= top + height - 12 ? below : field.top - panelHeight - 8;
  position.value = {
    left: `${Math.max(left + 12, Math.min(field.right - panelWidth, left + width - panelWidth - 12))}px`,
    top: `${Math.max(top + 12, Math.min(panelTop, top + height - panelHeight - 12))}px`,
    width: `${panelWidth}px`, maxHeight: `${Math.max(100, height - 24)}px`,
  };
}
function outside(event: Event) { if (event.target instanceof Node && !root.value?.contains(event.target)) close(false); }
function listen(add: boolean) {
  const action = add ? 'addEventListener' : 'removeEventListener';
  document[action]('pointerdown', outside, true); window[action]('resize', place); window[action]('scroll', place, true);
  window.visualViewport?.[action]('resize', place); window.visualViewport?.[action]('scroll', place);
}
async function open() {
  if (props.disabled || opened.value) return;
  staged.value = props.modelValue.trim(); precision.value = datePrecision(staged.value);
  choice.value = toPickerValue(staged.value, precision.value); start.value = pickerStart(staged.value);
  opened.value = true; listen(true); await nextTick(); place();
  sizeObserver = new ResizeObserver(place); if (popup.value) sizeObserver.observe(popup.value);
  popup.value?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
}
function close(restoreFocus = true) {
  if (!opened.value) return;
  opened.value = false; listen(false); sizeObserver?.disconnect(); sizeObserver = undefined; choice.value = null; staged.value = '';
  if (restoreFocus) input.value?.focus({ preventScroll: true });
}
function select(value: unknown) {
  staged.value = fromPickerValue(value, precision.value) ?? '';
  choice.value = toPickerValue(staged.value, precision.value);
  void nextTick(place);
}
function setPrecision(next: DatePrecision) {
  if (next === precision.value) return;
  const source = staged.value || props.modelValue.trim(); start.value = pickerStart(source);
  staged.value = changePrecision(source, next); precision.value = next;
  choice.value = toPickerValue(staged.value, next); void nextTick(place);
}
function confirm() {
  const value = fromPickerValue(choice.value, precision.value); if (value === null) return;
  emit('update:modelValue', value); emit('blur'); close();
}
function clear() { close(false); emit('update:modelValue', ''); emit('blur'); input.value?.focus({ preventScroll: true }); }
function escapeInput(event: KeyboardEvent) { if (opened.value) { event.stopPropagation(); event.preventDefault(); close(); } }
function key(event: KeyboardEvent) {
  event.stopPropagation();
  if (event.key === 'Escape') { event.preventDefault(); close(); }
  if (event.key !== 'Tab' || !popup.value) return;
  const fields = Array.from(popup.value.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),[tabindex="0"]')).filter(field => field.offsetParent !== null);
  const first = fields[0], last = fields.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
watch(() => props.disabled, disabled => { if (disabled) close(false); });
onBeforeUnmount(() => { listen(false); sizeObserver?.disconnect(); choice.value = null; staged.value = ''; start.value = new Date(); });
</script>
<template>
  <div ref="root" class="met-date-control">
    <div class="met-date-input">
      <input ref="input" v-bind="inputAttrs" :value="modelValue" :disabled="disabled" type="text" autocomplete="off"
        placeholder="选择日期，或输入年份 / 年月 / 年月日" aria-haspopup="dialog" :aria-expanded="opened" :aria-controls="opened ? popupId : undefined"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)" @blur="emit('blur', $event)"
        @keydown.enter.prevent="open" @keydown.down.prevent="open" @keydown.esc="escapeInput">
      <button v-if="modelValue" type="button" class="date-icon" aria-label="清空相识日期" :disabled="disabled" @click="clear"><Icon name="close" :size="16" /></button>
      <button type="button" class="date-icon" aria-label="选择相识日期" :disabled="disabled" :aria-expanded="opened" :aria-controls="opened ? popupId : undefined" @click="opened ? close() : open()"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M7 3v4m10-4v4M3 10h18m-11 5h2" /></svg></button>
    </div>
    <div v-if="opened" :id="popupId" ref="popup" class="met-date-popover" :style="position" role="dialog" aria-label="选择相识日期" @keydown="key" @keydown.enter.prevent>
      <header><strong>相识日期</strong><div class="date-precision" role="group" aria-label="日期精度">
        <button v-for="mode in (['day','month','year'] as const)" :key="mode" type="button" :aria-pressed="precision === mode" @click="setPrecision(mode)">{{ { day: '日', month: '月', year: '年' }[mode] }}</button>
      </div></header>
      <div class="date-calendar"><VueDatePicker :key="precision" :model-value="choice" :start-date="start" :year-range="yearRange" :locale="zhCN"
        inline auto-apply arrow-navigation :month-picker="precision === 'month'" :year-picker="precision === 'year'"
        :time-config="{ enableTimePicker: false }" :formats="{ month: 'M月', year: 'yyyy年' }" :aria-labels="ariaLabels" @update:model-value="select" /></div>
      <p class="date-preview" aria-live="polite">{{ canConfirm ? staged : precision === 'year' ? '请选择年份' : precision === 'month' ? '请选择月份' : '请选择具体日期' }}</p>
      <footer><button type="button" class="button secondary" @click="close()" @keydown.enter.stop.prevent="close()">取消日期选择</button><button type="button" class="button primary" :disabled="!canConfirm" @click="confirm" @keydown.enter.stop.prevent="confirm">确定日期</button></footer>
    </div>
  </div>
</template>
<style scoped>
.met-date-input { display: flex; align-items: center; border: 1px solid var(--line, #c9d3c6); border-radius: 10px; background: white; }
.met-date-input:focus-within { outline: 2px solid #c9d3c6; outline-offset: 2px; }
.met-date-input input { flex: 1; width: 0; min-width: 0; border: 0; background: transparent; }
.met-date-input input:focus { outline: 0; }
.met-date-input:has([aria-invalid="true"]) { border-color: #bd8577; background: #fffaf7; }
.met-date-input:has([aria-invalid="true"]):focus-within { outline-color: #d6aca0; }
.date-icon { border: 0; background: transparent; color: #547353; flex: none; width: 40px; height: 44px; display: grid; place-items: center; cursor: pointer; border-radius: 8px; }
.date-icon:hover { background: #e6eee4; }
.met-date-popover { position: fixed; z-index: 110; display: flex; flex-direction: column; padding: 14px; border: 1px solid #c9d3c6; border-radius: 14px; background: #f7f6f2; box-shadow: 0 12px 40px #2f3a3326; overflow: hidden; }
.date-calendar { min-height: 0; overflow: auto; overscroll-behavior: contain; }
.met-date-popover header, .met-date-popover footer, .date-preview { flex: none; }
.met-date-popover header { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.met-date-popover header strong { font-size: 14px; }
.date-precision { display: flex; padding: 3px; border-radius: 9px; background: #e6eee4; }
.date-precision button { border: 0; background: transparent; color: #547353; border-radius: 7px; min-width: 38px; min-height: 32px; cursor: pointer; }
.date-precision [aria-pressed="true"] { color: white; background: #547353; }
.met-date-popover :deep(.dp--theme-light) { --dp-background-color: #f7f6f2; --dp-text-color: #2f3a33; --dp-primary-color: #547353; --dp-primary-text-color: #fff; --dp-secondary-color: #8a9785; --dp-hover-color: #e6eee4; --dp-hover-text-color: #2f3a33; --dp-border-color: #c9d3c6; --dp-menu-border-color: transparent; --dp-border-color-hover: #547353; --dp-icon-color: #547353; --dp-border-radius: 9px; --dp-cell-border-radius: 8px; --dp-font-family: inherit; --dp-font-size: 14px; }
.met-date-popover :deep(.dp--main), .met-date-popover :deep(.dp--menu), .met-date-popover :deep(.dp--instance-calendar) { width: 100%; }
.met-date-popover :deep(.dp--flex-display) { display: block; }
.date-preview { color: #547353; min-height: 22px; font-size: 13px; margin: 10px 0; text-align: center; }
.met-date-popover footer { display: flex; justify-content: flex-end; gap: 8px; border-top: 1px solid #dbe2d8; padding-top: 12px; }
.met-date-popover footer .button { min-height: 40px; padding: 8px 12px; font-size: 12px; }
@media (max-width:650px) { .date-icon { width: 44px; min-height: 46px; } .date-precision button { min-height: 36px; } }
</style>
