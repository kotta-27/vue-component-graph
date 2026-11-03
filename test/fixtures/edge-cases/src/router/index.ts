import Layout from '../views/Layout.vue'
export const routes = [
  { path: '/', component: Layout, redirect: '/dashboard', children: [{ path: 'dashboard', component: () => import('../views/Dashboard.vue') }] },
  { path: '/console', component: () => import('../views/ConsoleView.vue') },
]

import Users from '../views/Users.vue'
// Layout だけを描画する親（レイアウトとして 2 か所で使う）と、一覧＋詳細の親
export const more = [
  { path: '/docs', component: Layout, children: [{ path: 'index', component: () => import('../views/Docs.vue') }] },
  { path: '/users', component: Users, children: [{ path: ':id', component: () => import('../views/UserDetail.vue') }] },
]
