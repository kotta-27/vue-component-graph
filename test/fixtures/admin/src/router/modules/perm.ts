import { Layout } from '@/router/constant'
export default [{ path: '/perm', component: Layout, children: [{ path: 'button', component: () => import('@/views/perm/perms.vue') }, { path: 'badge', component: () => import('@/views/perm/Badge.vue') }] }]
// メニュー用の外部リンク（Layout を指定しているが子がない）
export const external = [{ path: '/external', name: 'https://example.com', component: Layout }]
