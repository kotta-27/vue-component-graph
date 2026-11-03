<script setup lang="ts">
import CartItem from '../components/cart/CartItem.vue'
import CheckoutDialog from '../components/cart/CheckoutDialog.vue'
import { useCart } from '../composables/useCart'
const { items } = useCart()
</script>

<template>
  <ul><CartItem v-for="item in items" :key="item.id" /></ul>
  <CheckoutDialog />
</template>
