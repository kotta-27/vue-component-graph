<script setup lang="ts">
import { NavButtonHome } from '#components'
const buttons = [NavButtonHome]
</script>
<template><nav><component :is="b" v-for="b in buttons" /></nav></template>
