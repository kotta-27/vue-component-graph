import { createApp } from 'vue'
import App from './App.vue'
import Perms from './components/Perms/index.vue'
import { Badge } from './components/Badge'
import './styles/main.css'
createApp(App).component('Perms', Perms).component('Badge', Badge).mount('#app')
