import { createApp } from 'vue'
import App from './App.vue'
import GlobalBadge from '@/components/GlobalBadge.vue'
import { router } from './router'
import './style.css'

createApp(App).component('GlobalBadge', GlobalBadge).use(router).mount('#app')
