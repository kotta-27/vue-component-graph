export {}
declare module 'vue' {
  export interface GlobalComponents {
    Gone: typeof import('./components/Gone.vue')['default']
  }
}
