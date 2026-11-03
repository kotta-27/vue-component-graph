<script setup lang="ts">
import PriceTag from './PriceTag.vue'
import RatingStars from './RatingStars.vue'
import BaseButton from '../ui/BaseButton.vue'
</script>

<template>
  <article>
    <PriceTag :value="1200" />
    <RatingStars />
    <BaseButton>Add to cart</BaseButton>
  </article>
</template>
