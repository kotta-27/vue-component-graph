<script setup lang="ts">
import { ref } from 'vue'
import TreeItem from '@/components/TreeItem.vue'
import CycleA from '@/components/CycleA.vue'
import CardA from './CardA.vue'
import CardB from './CardB.vue'
import Unused from './Unused.vue'
const flag = ref(true)
console.log(Unused)
</script>

<template>
  <TreeItem :children="[]" />
  <CycleA />
  <component :is="flag ? CardA : CardB" />
  <AutoWidget />
</template>
