<script setup lang="ts">
defineProps<{ children: unknown[] }>()
</script>

<template>
  <li>
    <TreeItem v-for="c in children" :children="[]" />
  </li>
</template>
