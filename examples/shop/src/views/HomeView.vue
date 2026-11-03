<script setup lang="ts">
import ProductCard from '../components/product/ProductCard.vue'
import { defineAsyncComponent } from 'vue'
const PromoCarousel = defineAsyncComponent(() => import('../components/PromoCarousel.vue'))
</script>

<template>
  <PromoCarousel />
  <ProductCard v-for="i in 8" :key="i" />
</template>
