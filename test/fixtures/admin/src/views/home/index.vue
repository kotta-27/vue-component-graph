<script setup lang="ts">
import { toRaw } from 'vue'
import { CountTo } from '@/components/CountTo'
import ReText from '@/components/ReText/src/index.vue'
const icon = {}
const useIcon = (x: unknown) => x
</script>
<template><div><CountTo /><ReText /><component :is="useIcon(toRaw(icon))" /></div></template>
