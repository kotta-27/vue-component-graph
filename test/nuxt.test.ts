import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildGraph } from '../src/graph'

const fixture = (name: string) => buildGraph(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)))

describe('Nuxt layouts, global components and layers', () => {
  const graph = fixture('nuxt-bare')
  const node = (id: string) => graph.nodes.find((n) => n.id === id)!
  const pathsOf = (id: string) => node(id).routes.map((i) => graph.routes[i].path).sort()

  it('uses the layout each page selects with definePageMeta', () => {
    expect(graph.routes.find((r) => r.path === '/admin')!.layouts).toEqual(['app/layouts/admin.vue'])
    expect(graph.routes.find((r) => r.path === '/login')!.layouts).toEqual([])
    expect(graph.routes.find((r) => r.path === '/')!.layouts).toEqual(['app/layouts/default.vue'])
    expect(pathsOf('app/components/AdminNav.vue')).toEqual(['/admin'])
    expect(pathsOf('app/components/AppHeader.vue')).not.toContain('/admin')
    expect(pathsOf('app/components/AppHeader.vue')).not.toContain('/login')
    expect(node('app/components/AppHeader.vue').shell).toBe(false)
  })

  it('names components/global/Badge.vue as Badge', () => {
    expect(node('app/components/global/Badge.vue').name).toBe('Badge')
    expect(pathsOf('app/components/global/Badge.vue')).toEqual(['/login'])
  })

  it('reads components and pages from layers/ in the repository', () => {
    expect(pathsOf('layers/extra/app/components/LayerWidget.vue')).toEqual(['/extra', '/login'])
    expect(graph.orphans).not.toContain('layers/extra/app/pages/extra.vue')
    expect(node('layers/extra/app/pages/extra.vue').name).toBe('pages/extra')
  })
})

describe('Nuxt Content', () => {
  const graph = fixture('nuxt-content')

  it('counts components used from Markdown with MDC syntax', () => {
    const fromMd = graph.edges.filter((e) => e.from === 'content/docs/intro.md').map((e) => e.to).sort()
    expect(fromMd).toEqual(['app/components/content/Kbd.vue', 'app/components/content/ReadMore.vue'])
    expect(graph.orphans).toEqual(['app/components/content/Unused.vue'])
  })

  it('ignores MDC inside code blocks', () => {
    expect(graph.nodes.find((n) => n.id === 'content/docs/intro.md')!.externals).toEqual([])
  })
})
