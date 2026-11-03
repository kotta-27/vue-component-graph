import { createRouter, createWebHistory } from 'vue-router'
import HomeView from './views/HomeView.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: HomeView },
    { path: '/products/:id', component: () => import('./views/ProductView.vue') },
    { path: '/cart', component: () => import('./views/CartView.vue') },
    {
      path: '/account',
      component: () => import('./views/account/AccountView.vue'),
      children: [
        { path: 'orders', component: () => import('./views/account/OrdersView.vue') },
        { path: 'settings', component: () => import('./views/account/SettingsView.vue') },
      ],
    },
  ],
})
