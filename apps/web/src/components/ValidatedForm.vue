<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { useForm } from 'vee-validate';
import { focusFirstError } from '../validation';
import FormNotice from './FormNotice.vue';
const props = defineProps<{ submit: () => void | Promise<void>; busy?: boolean; serverError?: string }>();
const element = ref<HTMLFormElement>();
const { handleSubmit, errors, submitCount, isSubmitting, resetForm, values } = useForm({ validateOnMount: false });
const errorCount = computed(() => Object.values(errors.value).filter(Boolean).length);
let active = true;
const validateAndSubmit = handleSubmit(async () => {
  if (!active || props.busy) return;
  await props.submit();
  // Parent handlers clear secrets after each attempt; do not mark that clearing as a new user error.
  await nextTick();
  if (active) resetForm({ values: { ...values } }, { force: true });
}, async () => {
  await nextTick();
  if (active) focusFirstError(element.value);
});
function onSubmit(event: Event) {
  event.preventDefault();
  if (!active || props.busy || isSubmitting.value) return;
  void validateAndSubmit(event);
}
onBeforeUnmount(() => { active = false; resetForm({ values: {} }, { force: true }); });
</script>
<template>
  <form ref="element" class="form-grid" novalidate :aria-busy="busy || isSubmitting ? 'true' : undefined" @submit="onSubmit">
    <FormNotice v-if="serverError" :message="serverError" />
    <FormNotice v-else-if="submitCount && errorCount" :message="`还有 ${errorCount} 项需要确认，请从已定位的字段开始。`" />
    <slot />
  </form>
</template>
