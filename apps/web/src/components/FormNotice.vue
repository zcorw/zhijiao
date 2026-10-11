<script setup lang="ts">
defineProps<{ message: string }>();
</script>
<template>
  <div class="form-notice" role="alert">
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 5.8v4.8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="13.6" r=".9" fill="currentColor"/></svg>
    <span>{{ message }}</span>
  </div>
</template>
