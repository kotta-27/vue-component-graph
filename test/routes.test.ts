import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildGraph } from '../src/graph'

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url))

describe('vue-router routes', () => {
  const graph = buildGraph(fixture('basic'))
  const node = (id: string) => graph.nodes.find((n) => n.id === `src/${id}`)!
  const routeIndex = (path: string) => graph.routes.findIndex((r) => r.path === path)

  it('collects static, nested, named-view and dynamic routes (redirect-only is skipped)', () => {
    expect(graph.routes.map((r) => [r.path, r.dynamic])).toEqual([
      ['/', false],
      ['/about', false],
      ['/settings', false],
      ['/settings/profile', false],
      ['`/x/${p}`', true],
    ])
    expect(graph.routes[3].view).toBe('src/views/SettingsProfile.vue')
    expect(graph.routes[3].layouts).toEqual(['src/views/Settings.vue'])
    expect(graph.routes[3].chain).toEqual([
      'src/views/Settings.vue',
      'src/views/SettingsProfile.vue',
      'src/components/SideNav.vue',
    ])
    expect(graph.routes.every((r) => r.source === 'src/router.ts')).toBe(true)
  })

  it('createApp() root and its descendants are shown on every page', () => {
    expect(graph.entries).toEqual(['src/main.ts'])
    expect(node('App.vue').shell).toBe(true)
    expect(node('components/nav/NavLink.vue').shell).toBe(true)
    expect(node('views/Home.vue').shell).toBe(false)
  })

  it('maps each component to the routes that render it', () => {
    expect(node('components/SideNav.vue').routes).toEqual([routeIndex('/settings/profile')])
    expect(node('views/Settings.vue').routes).toEqual([routeIndex('/settings'), routeIndex('/settings/profile')])
    // Home の :is 経由と、動的ルートの両方
    expect(node('views/CardA.vue').routes).toEqual([routeIndex('/'), 4])
    expect(node('components/Orphan.vue').routes).toEqual([])
  })
})

describe('Nuxt pages', () => {
  const graph = buildGraph(fixture('nuxt'))
  const node = (id: string) => graph.nodes.find((n) => n.id === `app/${id}`)!

  it('derives routes from pages/', () => {
    expect(graph.routes.map((r) => r.path).sort()).toEqual(['/', '/:slug(.*)*', '/about', '/users', '/users/:id'])
    const user = graph.routes.find((r) => r.path === '/users/:id')!
    expect(user.chain).toEqual(['app/pages/users.vue', 'app/pages/users/[id].vue'])
  })

  it('app.vue and the default layout are on every page', () => {
    expect(node('app.vue').shell).toBe(true)
    expect(node('components/SiteHeader.vue').shell).toBe(true)
    expect(node('components/UserCard.vue').shell).toBe(false)
    const paths = node('components/UserCard.vue').routes.map((i) => graph.routes[i].path).sort()
    expect(paths).toEqual(['/', '/users/:id'])
  })
})
