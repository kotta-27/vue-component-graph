<script setup lang="ts">
const shareRequest = () => {}
const shareLink = () => {}
</script>
<template>
  <button @click="shareRequest()">share</button>
  <ShareRequest />
  <share-link />
</template>
