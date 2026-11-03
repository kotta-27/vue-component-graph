export {}
declare module 'vue' {
  export interface GlobalComponents {
    AutoWidget: typeof import('./src/components/AutoWidget.vue')['default']
    RouterView: typeof import('vue-router')['RouterView']
  }
}
