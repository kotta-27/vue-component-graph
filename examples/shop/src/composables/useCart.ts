import { ref } from 'vue'

const items = ref<{ id: number; price: number }[]>([])

export function useCart() {
  return { items, count: () => items.value.length }
}
