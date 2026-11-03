import { Layout } from '@/router/constant'
export default [
  { path: '/home', component: Layout, redirect: '/home/index', children: [{ path: 'index', component: () => import('@/views/home/index.vue') }] },
]
