import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildGraph, findNodes, subgraph, toPascal } from '../src/graph'
import { stripJsonc } from '../src/resolve'

const root = fileURLToPath(new URL('./fixtures/basic', import.meta.url))
const graph = buildGraph(root)
const edge = (from: string, to: string) =>
  graph.edges.find((e) => e.from === `src/${from}` && e.to === `src/${to}`)

describe('buildGraph', () => {
  it('relative import + PascalCase tag', () => {
    expect(edge('App.vue', 'components/AppHeader.vue')).toMatchObject({ type: 'template', async: false })
  })

  it('tsconfig paths alias + kebab-case tag', () => {
    expect(edge('App.vue', 'components/AppFooter.vue')?.type).toBe('template')
  })

  it('barrel re-export', () => {
    expect(edge('components/AppHeader.vue', 'components/nav/NavLink.vue')?.type).toBe('template')
  })

  it('global registration via app.component()', () => {
    expect(edge('components/AppHeader.vue', 'components/GlobalBadge.vue')?.type).toBe('template')
  })

  it('Options API components option, including async', () => {
    expect(edge('components/AppFooter.vue', 'components/FooterLinks.vue')?.type).toBe('template')
    expect(edge('components/AppFooter.vue', 'components/HeavyChart.vue')).toMatchObject({ type: 'template', async: true })
  })

  it('auto-import via components.d.ts', () => {
    expect(edge('views/Home.vue', 'components/AutoWidget.vue')?.type).toBe('template')
  })

  it('<component :is> expression', () => {
    expect(edge('views/Home.vue', 'views/CardA.vue')?.type).toBe('template')
    expect(edge('views/Home.vue', 'views/CardB.vue')?.type).toBe('template')
  })

  it('import not used in template becomes a script edge', () => {
    expect(edge('views/Home.vue', 'views/Unused.vue')?.type).toBe('script')
  })

  it('query imports (?raw) are not component dependencies', () => {
    expect(edge('views/About.vue', 'views/CardA.vue')).toBeUndefined()
  })

  it('JS modules that import .vue become nodes (main / router)', () => {
    expect(edge('main.ts', 'App.vue')?.type).toBe('script')
    expect(edge('router.ts', 'views/Home.vue')).toMatchObject({ type: 'script', async: false })
    expect(edge('router.ts', 'views/About.vue')).toMatchObject({ type: 'script', async: true })
    expect(graph.nodes.find((n) => n.id === 'src/router.ts')?.kind).toBe('module')
    expect(graph.nodes.find((n) => n.id === 'src/components/nav/index.ts')).toBeUndefined()
  })

  it('externals', () => {
    const about = graph.nodes.find((n) => n.id === 'src/views/About.vue')!
    expect(about.externals).toEqual(['ElButton', 'Plus (lucide-vue-next)'])
    const app = graph.nodes.find((n) => n.id === 'src/App.vue')!
    expect(app.externals).toEqual(['RouterView (vue-router)'])
  })

  it('recursive, cycles, orphans', () => {
    expect(graph.recursive).toEqual(['src/components/TreeItem.vue'])
    expect(graph.cycles.map((c) => [...c].sort())).toEqual([['src/components/CycleA.vue', 'src/components/CycleB.vue']])
    expect(graph.orphans).toEqual(['src/components/Orphan.vue'])
  })

  it('groups by first directory under src', () => {
    const group = (id: string) => graph.nodes.find((n) => n.id === id)?.group
    expect(group('src/components/nav/NavLink.vue')).toBe('components')
    expect(group('src/views/Home.vue')).toBe('views')
    expect(group('src/App.vue')).toBe('(root)')
  })

  it('no parse warnings', () => {
    expect(graph.warnings).toEqual([])
  })
})

describe('subgraph / findNodes', () => {
  it('down: descendants only', () => {
    const [home] = findNodes(graph, 'Home')
    const ids = subgraph(graph, home.id, 'down').nodes.map((n) => n.id).sort()
    expect(ids).toContain('src/components/CycleB.vue')
    expect(ids).not.toContain('src/App.vue')
  })

  it('up: who uses', () => {
    const ids = subgraph(graph, 'src/components/GlobalBadge.vue', 'up').nodes.map((n) => n.id).sort()
    expect(ids).toEqual(['src/App.vue', 'src/components/AppHeader.vue', 'src/components/GlobalBadge.vue', 'src/main.ts'])
  })

  it('findNodes accepts kebab-case and path suffix', () => {
    expect(findNodes(graph, 'app-header').map((n) => n.id)).toEqual(['src/components/AppHeader.vue'])
    expect(findNodes(graph, 'nav/NavLink').map((n) => n.id)).toEqual(['src/components/nav/NavLink.vue'])
  })
})

describe('helpers', () => {
  it('toPascal', () => {
    expect(toPascal('my-comp')).toBe('MyComp')
    expect(toPascal('myComp')).toBe('MyComp')
    expect(toPascal('MyComp.vue')).toBe('MyComp')
  })

  it('stripJsonc keeps // inside strings', () => {
    expect(JSON.parse(stripJsonc('{ "a": "http://x/*", // c\n "b": [1,], }'))).toEqual({ a: 'http://x/*', b: [1] })
  })
})

describe('module names', () => {
  it('adds parent directories until the name is unambiguous', () => {
    const g = buildGraph(fileURLToPath(new URL('./fixtures/modules', import.meta.url)))
    const names = Object.fromEntries(g.nodes.filter((n) => n.kind === 'module').map((n) => [n.id, n.name]))
    expect(names).toEqual({
      'src/router/index.ts': 'router/index.ts',
      'src/a/setup.ts': 'a/setup.ts',
      'src/b/setup.ts': 'b/setup.ts',
      'src/lib/main.ts': 'main.ts',
    })
  })
})
