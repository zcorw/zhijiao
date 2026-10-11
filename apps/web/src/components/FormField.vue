<script setup lang="ts" generic="T = string">
import { computed, ref, useId, watch } from 'vue';
import { useField, useFormContext } from 'vee-validate';
import type { FormRule } from '../validation';
const props = withDefaults(defineProps<{
  name: string; label: string; modelValue?: T; rules?: FormRule;
  type?: string; required?: boolean; placeholder?: string; autocomplete?: string;
  rows?: number; disabled?: boolean; hint?: string; options?: { value: string; label: string }[];
}>(), { type: 'text', rows: 3 });
defineEmits<{ 'update:modelValue': [value: T] }>();
const id = `field-${useId()}`;
const form = useFormContext();
const badInput = ref(false);
const rules = computed<FormRule>(() => {
  const currentRules = props.rules;
  const invalidInput = badInput.value;
  return (value, context) => invalidInput
    ? '请填写完整、合法的日期和时间。' : currentRules?.(value, context) ?? true;
});
const { value, errorMessage, meta, handleChange, handleBlur, validate } = useField<T>(() => props.name, rules, {
  syncVModel: true, validateOnValueUpdate: false, keepValueOnUnmount: false,
});
const shownError = computed(() => meta.touched || form.submitCount.value > 0 ? errorMessage.value : undefined);
const attrs = computed(() => ({
  id, name: props.name, disabled: props.disabled,
  'aria-invalid': shownError.value ? true : undefined,
  'aria-required': props.required ? true : undefined,
  'aria-describedby': [props.hint ? `${id}-hint` : '', shownError.value ? `${id}-error` : ''].filter(Boolean).join(' ') || undefined,
}));
const textValue = computed(() => String(value.value ?? ''));
function change(event: Event) {
  badInput.value = event.target instanceof HTMLInputElement && event.target.validity.badInput;
  handleChange(event, meta.touched || form.submitCount.value > 0);
}
function blur(event?: Event) { handleBlur(event, true); }
// vee-validate v4 does not watch function rules for dependency changes.
watch([() => props.modelValue, rules], () => {
  if (meta.touched || form.submitCount.value > 0) void validate();
}, { flush: 'post' });
</script>
<template>
  <div class="field validated-field" :class="{ 'field-has-error': shownError, checkbox: type === 'checkbox' }">
    <label :for="id" class="field-label">{{ label }} <b v-if="required" class="required" aria-hidden="true">*</b></label>
    <slot v-if="type === 'custom'" :attrs="attrs" :blur="blur" />
    <textarea v-else-if="type === 'textarea'" v-bind="attrs" :value="textValue" :rows="rows" :placeholder="placeholder" @input="change" @blur="blur" />
    <select v-else-if="type === 'select'" v-bind="attrs" :value="textValue" @change="change" @blur="blur"><option v-for="option in options" :key="option.value" :value="option.value">{{ option.label }}</option></select>
    <input v-else-if="type === 'checkbox'" v-bind="attrs" type="checkbox" :checked="!!value" @change="handleChange(($event.target as HTMLInputElement).checked, true)" @blur="blur">
    <input v-else v-bind="attrs" :type="type" :value="textValue" :placeholder="placeholder" :autocomplete="autocomplete" @input="change" @blur="blur">
    <small v-if="hint" :id="`${id}-hint`" class="field-hint">{{ hint }}</small>
    <p v-if="shownError" :id="`${id}-error`" class="field-error" aria-live="polite">
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M8 4.4v4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/><circle cx="8" cy="11" r=".7" fill="currentColor"/></svg>{{ shownError }}
    </p>
  </div>
</template>
