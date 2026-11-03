<script setup lang="ts">
import SearchBox from '../SearchBox.vue'
import CartBadge from '../cart/CartBadge.vue'
import UserMenu from '../UserMenu.vue'
</script>

<template>
  <header>
    <RouterLink to="/">Shop</RouterLink>
    <SearchBox />
    <CartBadge />
    <UserMenu />
  </header>
</template>
