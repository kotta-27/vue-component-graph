export {}
declare module 'vue' {
  export interface GlobalComponents {
    ShareRequest: typeof import('./components/share/Request.vue')['default']
  }
}
