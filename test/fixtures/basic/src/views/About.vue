<script setup lang="ts">
import { defineComponent, h } from 'vue'
import { Plus } from 'lucide-vue-next'
import cardSource from './CardA.vue?raw'
const InlineBox = defineComponent(() => () => h('div'))
</script>

<template>
  <Plus />
  <InlineBox />
  <el-button>ok</el-button>
</template>
