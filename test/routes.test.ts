import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildGraph } from '../src/graph'
import { whoUses } from '../src/mcp'

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

describe('Nuxt without .nuxt/ (fresh clone, CI)', () => {
  const graph = buildGraph(fixture('nuxt-bare'))
  const node = (id: string) => graph.nodes.find((n) => n.id === `app/${id}`)!
  const childrenOf = (id: string) =>
    graph.edges.filter((e) => e.from === `app/${id}`).map((e) => e.to.replace(/^app\//, '')).sort()

  it('resolves components/ with Nuxt naming rules', () => {
    expect(childrenOf('pages/index.vue')).toEqual([
      'components/Chart.client.vue',
      'components/modal/index.vue',
      'components/user/Card.vue',
    ])
    expect(childrenOf('components/user/Card.vue')).toEqual(['components/base/BaseButton.vue'])
    expect(childrenOf('components/modal/index.vue')).toEqual(['components/form/input/Text.vue'])
    expect(graph.edges.find((e) => e.to === 'app/components/user/Card.vue')!.async).toBe(true)
    expect(graph.orphans).toEqual(['app/components/Unused.vue'])
  })

  it("resolves imports from '#components'", () => {
    const e = graph.edges.find((e) => e.from === 'app/components/nav/NavBottom.vue')!
    expect(e).toMatchObject({ to: 'app/components/nav/button/Home.vue', type: 'script' })
  })

  it('names nodes as Nuxt registers them', () => {
    expect(node('components/user/Card.vue').name).toBe('UserCard')
    expect(node('components/base/BaseButton.vue').name).toBe('BaseButton')
    expect(node('components/form/input/Text.vue').name).toBe('FormInputText')
    expect(node('components/modal/index.vue').name).toBe('Modal')
    expect(node('components/Chart.client.vue').name).toBe('Chart')
  })

  it('uses registered names in who_uses paths', () => {
    expect(whoUses(graph, 'BaseButton')).toContain('  index → UserCard → BaseButton')
  })

  it('treats Nuxt built-ins as external', () => {
    expect(node('pages/index.vue').externals).toEqual(['NuxtLink (nuxt)'])
    expect(node('app.vue').externals).toEqual(['NuxtLayout (nuxt)', 'NuxtPage (nuxt)'])
  })
})
