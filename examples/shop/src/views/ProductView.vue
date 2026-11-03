<script setup lang="ts">
import PriceTag from '../components/product/PriceTag.vue'
import RatingStars from '../components/product/RatingStars.vue'
import ReviewThread from '../components/product/ReviewThread.vue'
import BaseButton from '../components/ui/BaseButton.vue'
</script>

<template>
  <PriceTag :value="1200" />
  <RatingStars />
  <BaseButton>Add to cart</BaseButton>
  <ReviewThread :replies="[]" />
</template>
