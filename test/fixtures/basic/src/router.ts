import { createRouter, createWebHistory } from 'vue-router'
import Home from './views/Home.vue'
import SideNav from './components/SideNav.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: Home },
    { path: '/about', component: () => import('@/views/About.vue') },
    {
      path: '/settings',
      component: () => import('@/views/Settings.vue'),
      children: [
        { path: 'profile', components: { default: () => import('@/views/SettingsProfile.vue'), side: SideNav } },
      ],
    },
    ...['a', 'b'].map((p) => ({ path: `/x/${p}`, component: () => import('@/views/CardA.vue') })),
    { path: '/old', redirect: '/' },
  ],
})
