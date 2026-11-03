<script setup lang="ts">
import RatingStars from './RatingStars.vue'
defineProps<{ replies: { id: number; replies: any[] }[] }>()
</script>

<template>
  <ul>
    <li v-for="r in replies" :key="r.id">
      <RatingStars />
      <ReviewThread :replies="r.replies" />
    </li>
  </ul>
</template>
