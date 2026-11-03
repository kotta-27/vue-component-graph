<script setup lang="ts">
import PriceTag from '../product/PriceTag.vue'
import BaseButton from '../ui/BaseButton.vue'
</script>

<template>
  <li>
    <PriceTag :value="1200" />
    <BaseButton>Remove</BaseButton>
  </li>
</template>
