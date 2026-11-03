import DefaultTheme from 'vitepress/theme'
import Badge from './components/Badge.vue'
export default { extends: DefaultTheme, enhanceApp({ app }) { app.component('Badge', Badge) } }
