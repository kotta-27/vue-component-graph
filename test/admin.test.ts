import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it } from 'vitest'
import { analyze, buildGraph, globToRegExp } from '../src/graph'
import { setLang } from '../src/i18n'
import { analyzeImpact } from '../src/impact'
import { componentInfo } from '../src/report'

// 管理画面テンプレートによくある構成（ルートのモジュール分割、別ファイルの Layout、バレル、withInstall、glob）
const root = fileURLToPath(new URL('./fixtures/admin', import.meta.url))
const { graph, deps } = analyze(root)
const node = (id: string) => graph.nodes.find((n) => n.id === `src/${id}`)!
const hasEdge = (from: string, to: string) => graph.edges.some((e) => e.from === `src/${from}` && e.to === `src/${to}`)
const pathsOf = (id: string) => node(id).routes.map((i) => graph.routes[i].path).sort()
const impactOf = (...files: string[]) => {
  const impact = analyzeImpact(graph, deps, files.map((f) => join(root, 'src', f)), '', [])
  return { ...impact, affected: impact.affected.map((id) => id.replace(/^src\//, '')), paths: impact.routes.map((i) => graph.routes[i].path) }
}

beforeAll(() => setLang('en'))

describe('routes whose component is imported from another module', () => {
  it('follows export const Layout = () => import(...) to the layout', () => {
    expect(graph.routes.map((r) => r.path)).toEqual(['/home/index', '/perm/button', '/perm/badge'])
    expect(graph.routes[0].layouts).toEqual(['src/layout/index.vue'])
    expect(pathsOf('layout/components/Header.vue')).toEqual(['/home/index', '/perm/badge', '/perm/button'])
  })
})

describe('barrels', () => {
  it('prefers Foo/index.ts over Foo/index.vue, like Vite', () => {
    expect(hasEdge('layout/index.vue', 'layout/components/Logo/index.vue')).toBe(true)
    expect(node('layout/index.vue').externals).toEqual([])
  })

  it('follows export const Foo = withInstall(foo)', () => {
    expect(hasEdge('views/home/index.vue', 'components/CountTo/CountTo.vue')).toBe(true)
    expect(pathsOf('components/CountTo/CountTo.vue')).toEqual(['/home/index'])
  })
})

describe('template resolution', () => {
  it('resolves a global component before the file-name self reference', () => {
    expect(hasEdge('views/perm/perms.vue', 'components/Perms/index.vue')).toBe(true)
    expect(graph.recursive).toEqual([])
  })

  it('does not mistake a global registered from a .tsx for a self reference', () => {
    expect(node('views/perm/Badge.vue').externals).toEqual(['Badge (src/components/Badge/badge.tsx)'])
  })

  it('ignores function calls in :is', () => {
    expect(node('views/home/index.vue').externals).toEqual([])
  })

  it('keeps unresolved tags apart from library components', () => {
    const info = componentInfo(graph, 'App').join('\n')
    expect(info).toContain('Unresolved tags (registered by a plugin, or a missing import): RouterView')
  })
})

describe('unused', () => {
  it('counts files loaded by import.meta.glob as used', () => {
    expect(graph.orphans).not.toContain('src/views/dynamic/Foo.vue')
    expect(componentInfo(graph, 'dynamic/Foo').join('\n')).toContain(
      'Pages: none (loaded dynamically by src/router/utils.ts, so its pages are decided at runtime)',
    )
  })

  it('treats pages/ and layouts/ as entries only when a framework renders them', () => {
    expect(graph.orphans.sort()).toEqual(['src/layouts/Unused.vue', 'src/pages/index.vue'])
  })

  it('warns about stale components.d.ts entries', () => {
    expect(graph.warnings).toContain('src/components.d.ts: ./components/Gone.vue does not exist (components.d.ts may be stale)')
  })
})

describe('names', () => {
  it('skips structural directories when naming index.vue', () => {
    expect(node('components/ReText/src/index.vue').name).toBe('ReText')
    expect(node('pages/index.vue').name).toBe('pages/index')
    expect(node('layout/index.vue').name).toBe('layout')
  })
})

describe('impact', () => {
  it('does not spread a component change through the router and store', () => {
    const impact = impactOf('layout/components/Header.vue')
    expect(impact.affected).toEqual(['layout/components/Header.vue', 'layout/index.vue'])
    expect(impact.paths).toEqual(['/home/index', '/perm/button', '/perm/badge'])
  })

  it('follows CSS @import from the entry to every page', () => {
    expect(impactOf('styles/base.css').everywhere).toBe(true)
  })

  it('follows assets referenced from templates', () => {
    const impact = impactOf('assets/logo.svg')
    expect(impact.affected).toEqual(['App.vue'])
    expect(impact.everywhere).toBe(true)
  })

  it('maps a changed route module to its routes', () => {
    expect(impactOf('router/modules/perm.ts').paths).toEqual(['/perm/button', '/perm/badge'])
  })

  it('reports deleted files', () => {
    const impact = impactOf('views/home/Removed.vue')
    expect(impact.deleted).toEqual(['src/views/home/Removed.vue'])
  })
})

describe('Nuxt nested index pages', () => {
  it('lists /settings once, with settings.vue as its parent', () => {
    const g = buildGraph(fileURLToPath(new URL('./fixtures/nuxt-bare', import.meta.url)))
    const settings = g.routes.filter((r) => r.path === '/settings')
    expect(settings).toHaveLength(1)
    expect(settings[0].chain).toEqual(['app/pages/settings.vue', 'app/pages/settings/index.vue'])
    expect(g.routes.map((r) => r.path)).toContain('/settings/members')
  })
})

describe('VitePress', () => {
  const g = buildGraph(fileURLToPath(new URL('./fixtures/vitepress', import.meta.url)))
  const ids = g.nodes.map((n) => n.id)

  it('reads Markdown pages that use components, and the theme', () => {
    expect(ids).toContain('guide/intro.md')
    expect(ids).not.toContain('guide/plain.md')
    expect(g.edges.map((e) => `${e.from} -> ${e.to}`)).toEqual(
      expect.arrayContaining(['guide/intro.md -> guide/demos/Demo.vue', 'guide/intro.md -> .vitepress/theme/components/Badge.vue']),
    )
    expect(ids.some((id) => id.includes('cache'))).toBe(false)
  })

  it('reports only components no page or theme uses', () => {
    expect(g.orphans).toEqual(['.vitepress/theme/components/Orphan.vue'])
    expect(g.vitepress).toBe(true)
  })

  it('ignores tags inside code blocks', () => {
    expect(g.nodes.find((n) => n.id === 'guide/intro.md')!.externals).toEqual([])
  })
})

describe('lazy component variables', () => {
  it('does not treat const router = createRouter({ ...import() }) as a component', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vcg-router-'))
    mkdirSync(join(dir, 'src/router'), { recursive: true })
    mkdirSync(join(dir, 'src/views'))
    writeFileSync(join(dir, 'package.json'), '{}')
    writeFileSync(join(dir, 'src/views/About.vue'), '<template><p /></template>')
    writeFileSync(join(dir, 'src/App.vue'), '<template><RouterView /></template>')
    writeFileSync(
      join(dir, 'src/router/index.ts'),
      "const router = createRouter({ routes: [{ path: '/about', component: () => import('../views/About.vue') }] })\nexport default router\n",
    )
    writeFileSync(join(dir, 'src/main.ts'), "import App from './App.vue'\nimport router from './router'\ncreateApp(App).use(router)\n")
    const g = buildGraph(dir)
    expect(g.edges.filter((e) => e.from === 'src/main.ts').map((e) => e.to)).toEqual(['src/App.vue'])
    expect(g.routes.map((r) => r.path)).toEqual(['/about'])
  })
})

describe('globToRegExp', () => {
  it('handles **, * and {a,b}', () => {
    const re = globToRegExp('/p/src/views/**/*.{vue,tsx}')
    expect(re.test('/p/src/views/a.vue')).toBe(true)
    expect(re.test('/p/src/views/x/y/b.tsx')).toBe(true)
    expect(re.test('/p/src/views/x/b.ts')).toBe(false)
    expect(re.test('/p/src/other/b.vue')).toBe(false)
  })
})
