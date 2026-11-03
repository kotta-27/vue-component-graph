<script setup lang="ts">
import { formatPrice } from '../../composables/usePrice'
defineProps<{ value: number }>()
</script>

<template>
  <span>{{ formatPrice(value) }}</span>
</template>
