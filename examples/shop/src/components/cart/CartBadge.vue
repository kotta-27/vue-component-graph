<script setup lang="ts">
import { useCart } from '../../composables/useCart'
const { count } = useCart()
</script>

<template>
  <RouterLink to="/cart">Cart ({{ count() }})</RouterLink>
</template>
