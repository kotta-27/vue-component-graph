import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { buildGraph, findNodes } from '../src/graph'
import { explicitLang, setLang } from '../src/i18n'
import { pick, QueryError, whoUses } from '../src/report'
import { checkProjectRoot } from '../src/root'

const root = fileURLToPath(new URL('./fixtures/edge-cases', import.meta.url))
const graph = buildGraph(root)
const node = (id: string) => graph.nodes.find((n) => n.id === `src/${id}`)!
const hasEdge = (from: string, to: string) => graph.edges.some((e) => e.from === `src/${from}` && e.to === `src/${to}`)

beforeAll(() => setLang('en'))

describe('setup bindings follow Vue resolution rules', () => {
  it('does not treat shareRequest() as <ShareRequest>', () => {
    expect(hasEdge('components/share/index.vue', 'components/share/Request.vue')).toBe(true)
    expect(graph.orphans).not.toContain('src/components/share/Request.vue')
  })

  it('still treats <share-link> as the shareLink binding', () => {
    expect(node('components/share/index.vue').externals).toEqual([])
  })
})

describe('named imports from .vue', () => {
  it('are not component dependencies, so type imports do not create cycles', () => {
    expect(hasEdge('components/console/Item.vue', 'components/console/Panel.vue')).toBe(false)
    expect(hasEdge('components/console/Panel.vue', 'components/console/Item.vue')).toBe(true)
    expect(graph.cycles).toEqual([])
  })
})

describe('component names', () => {
  it('names Foo/index.vue after its directory', () => {
    expect(node('components/SvgIcon/index.vue').name).toBe('SvgIcon')
    expect(node('components/share/index.vue').name).toBe('share')
  })

  it('finds Foo/index.vue by name, kebab-case or path', () => {
    for (const q of ['SvgIcon', 'svg-icon', 'components/SvgIcon', 'SvgIcon/index']) {
      expect(findNodes(graph, q).map((n) => n.id)).toEqual(['src/components/SvgIcon/index.vue'])
    }
  })

  it('labels duplicate names with their directories', () => {
    expect(node('components/a/Item.vue').label).toBe('a/Item')
    expect(node('components/b/Item.vue').label).toBe('b/Item')
    expect(node('components/console/Item.vue').label).toBe('console/Item')
    expect(node('components/SvgIcon/index.vue').label).toBe('SvgIcon')
    expect(node('router/index.ts').label).toBe('router/index.ts')
  })

  it('suggests labels when nothing matches', () => {
    expect(() => pick(graph, 'Itme')).toThrow(QueryError)
    expect(() => pick(graph, 'Ite')).toThrow('Did you mean: a/Item, b/Item, console/Item')
  })

  it('uses labels in who_uses paths', () => {
    expect(whoUses(graph, 'SvgIcon')).toContain('  src/router/index.ts → Dashboard → SvgIcon')
    expect(whoUses(graph, 'a/Item').join('\n')).toContain('a/Item (src/components/a/Item.vue)')
  })
})

describe('routes', () => {
  it('does not count redirect-only parents as pages', () => {
    const paths = graph.routes.map((r) => r.path)
    expect(paths).not.toContain('/')
    expect(graph.routes.find((r) => r.path === '/dashboard')!.layouts).toEqual(['src/views/Layout.vue'])
  })

  it('does not count parents that only wrap a shared layout, but keeps list/detail parents', () => {
    expect(graph.routes.map((r) => r.path)).toEqual(['/dashboard', '/console', '/docs/index', '/users', '/users/:id'])
  })

  it('explains file-based routing it cannot read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vcg-pages-'))
    mkdirSync(join(dir, 'src/pages/users'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{}')
    writeFileSync(join(dir, 'src/pages/index.vue'), '<template><p /></template>')
    writeFileSync(join(dir, 'src/pages/users/[id].vue'), '<template><p /></template>')
    const g = buildGraph(dir)
    expect(g.routes).toEqual([])
    expect(g.unsupportedPagesDir).toBe('src/pages')
    expect(g.nodes.map((n) => n.name).sort()).toEqual(['pages/index', 'pages/users/[id]'])
    expect(g.orphans).toEqual([])
  })
})

describe('project root check', () => {
  it('accepts the project root', () => {
    expect(checkProjectRoot(root)).toBeNull()
  })

  it('points to the nearest project root from a subdirectory', () => {
    expect(checkProjectRoot(join(root, 'src/views'))).toContain(`Did you mean the project root ${root}?`)
  })

  it('rejects missing paths and files', () => {
    expect(checkProjectRoot(join(root, 'nope'))).toContain('Directory not found')
    expect(checkProjectRoot(join(root, 'src/App.vue'))).toContain('Not a directory')
  })
})

describe('explicitLang', () => {
  it('is set only by --lang or VUE_COMPONENT_GRAPH_LANG', () => {
    expect(explicitLang(['node', 'cli'], { LANG: 'ja_JP.UTF-8' })).toBeUndefined()
    expect(explicitLang(['node', 'cli', '--lang', 'ja'], {})).toBe('ja')
    expect(explicitLang(['node', 'cli'], { VUE_COMPONENT_GRAPH_LANG: 'en' })).toBe('en')
  })
})
