<script>
import { defineAsyncComponent } from 'vue'
import FooterLinks from './FooterLinks.vue'

export default {
  components: {
    FooterLinks,
    Lazy: defineAsyncComponent(() => import('./HeavyChart.vue')),
  },
}
</script>

<template>
  <footer>
    <FooterLinks />
    <lazy />
  </footer>
</template>
