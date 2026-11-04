import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { analyze, buildGraph, findNodes } from '../src/graph'
import { setLang } from '../src/i18n'
import { analyzeImpact, gitChangedFiles } from '../src/impact'
import { pick, QueryError, whoUses } from '../src/report'

/** ファイル一覧から一時プロジェクトを作る */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vcg5-'))
  for (const [path, text] of Object.entries({ 'package.json': '{}', ...files })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}
const view = (text = '<p />') => `<template>${text}</template>`
const ids = (g: { nodes: { id: string }[] }) => g.nodes.map((n) => n.id).sort()

beforeAll(() => setLang('en'))

describe('vue-router', () => {
  it('keeps a page whose component is the parent of one other tree', () => {
    const g = buildGraph(project({
      'src/D.vue': view('<RouterView />'),
      'src/E.vue': view('<RouterView />'),
      'src/B.vue': view(),
      'src/router.ts': `import D from './D.vue'
import E from './E.vue'
import B from './B.vue'
export const routes = [
  { path: '/d', component: D, children: [{ path: 'y', component: E }] },
  { path: '/e', component: E, children: [{ path: '/z', component: B }] },
]`,
    }))
    expect(g.routes.map((r) => r.path)).toEqual(['/d', '/d/y', '/e', '/z'])
  })

  it('treats a component import built from a variable like a glob', () => {
    const g = buildGraph(project({
      'src/pages/Lead.vue': view(),
      'src/pages/MobileLead.vue': view(),
      'src/pages/Other.vue': view(),
      'src/router.ts': "const mobile = (n: string) => n\nexport const routes = [{ path: '/leads/:id', component: () => import(`@/pages/${mobile('Lead')}.vue`) }]",
    }))
    expect(g.routes.map((r) => r.path)).toEqual(['/leads/:id'])
    expect(g.routes[0].chain.sort()).toEqual(['src/pages/Lead.vue', 'src/pages/MobileLead.vue'])
    // 一致しうるファイルは Vite がすべてバンドルするので、未使用とは言わない
    expect(g.orphans).toEqual([])
  })

  it('fills route paths built from constants, here or imported', () => {
    const g = buildGraph(project({
      'src/A.vue': view(),
      'src/config.ts': "export const REDIRECT_PATH = '/redirect'",
      'src/router.ts': `import A from './A.vue'
import { REDIRECT_PATH } from './config'
const BASE = '/admin'
export const routes = [
  { path: \`\${REDIRECT_PATH}/:path(.*)\`, component: A },
  { path: BASE + '/users', component: A, alias: ['/u'] },
]`,
    }))
    expect(g.routes.map((r) => [r.path, r.dynamic, r.aliases])).toEqual([
      ['/redirect/:path(.*)', false, undefined],
      ['/admin/users', false, ['/u']],
    ])
  })

  it('warns about routes whose component is a factory call', () => {
    const g = buildGraph(project({
      'src/router.ts': "const make = (t: string) => ({})\nexport const routes = [{ path: '/top', component: make('top') }]",
      'src/A.vue': view(),
    }))
    expect(g.warnings.join('\n')).toContain('1 routes use a function call as their component')
  })
})

describe('entries and global registration', () => {
  it('recognizes createApp({ render: () => h(App) }) and new Vue({ render })', () => {
    for (const main of [
      "import { createApp, h } from 'vue'\nimport App from './App.vue'\ncreateApp({ render: () => h(App) })",
      "import Vue from 'vue'\nimport App from './App.vue'\nnew Vue({ render: (h) => h(App) })",
    ]) {
      const g = buildGraph(project({ 'src/main.ts': main, 'src/App.vue': view('<Hdr />'), 'src/Hdr.vue': view() }))
      expect(g.entries).toEqual(['src/main.ts'])
      expect(g.nodes.filter((n) => n.shell).map((n) => n.id).sort()).toEqual(['src/App.vue'])
    }
  })

  it('treats only the largest app as shared by every page', () => {
    const g = buildGraph(project({
      'src/main.ts': "import { createApp } from 'vue'\nimport App from './App.vue'\nimport Dev from './Dev.vue'\ncreateApp(App)\ncreateApp(Dev)",
      'src/App.vue': `<script setup>import A from './A.vue'\nimport B from './B.vue'</script>${view('<A /><B />')}`,
      'src/A.vue': view(),
      'src/B.vue': view(),
      'src/Dev.vue': view(),
    }))
    expect(g.nodes.find((n) => n.id === 'src/Dev.vue')!.shell).toBe(false)
    expect(g.nodes.find((n) => n.id === 'src/A.vue')!.shell).toBe(true)
  })

  it('unwraps `as` casts and resolves app.component(Foo.name, Foo) with defineOptions', () => {
    const g = buildGraph(project({
      'src/main.ts': `import { createApp, type Component } from 'vue'
import App from './App.vue'
import Btn from './Btn.vue'
import Drawer from './drawer-pro/index.vue'
createApp(App).component('XButton', Btn as Component).component(Drawer.name, Drawer)`,
      'src/App.vue': view('<XButton /><DrawerPro />'),
      'src/Btn.vue': view(),
      'src/drawer-pro/index.vue': "<script setup>defineOptions({ name: 'DrawerPro' })</script><template><aside /></template>",
    }))
    const edges = g.edges.filter((e) => e.from === 'src/App.vue').map((e) => e.to).sort()
    expect(edges).toEqual(['src/Btn.vue', 'src/drawer-pro/index.vue'])
    expect(g.nodes.find((n) => n.id === 'src/drawer-pro/index.vue')!.name).toBe('DrawerPro')
    expect(findNodes(g, 'XButton').map((n) => n.id)).toEqual(['src/Btn.vue'])
  })
})

describe('aliases and unresolved imports', () => {
  it('reads resolve.alias from vite.config', () => {
    const g = buildGraph(project({
      'vite.config.ts': `import path from 'node:path'
import { fileURLToPath } from 'node:url'
export default { resolve: { alias: {
  dashboard: path.resolve(__dirname, './app/javascript/dashboard'),
  '@': fileURLToPath(new URL('./app/javascript', import.meta.url)),
} } }`,
      'app/javascript/dashboard/App.vue': `<script setup>import Item from 'dashboard/components/Item.vue'
import Card from '@/shared/Card.vue'</script>${view('<Item /><Card />')}`,
      'app/javascript/dashboard/components/Item.vue': view(),
      'app/javascript/shared/Card.vue': view(),
    }))
    expect(g.edges.map((e) => e.to).sort()).toEqual(['app/javascript/dashboard/components/Item.vue', 'app/javascript/shared/Card.vue'])
    expect(g.unresolvedImports).toEqual([])
  })

  it('reports a bare import of a project directory as unresolved, not as a package', () => {
    const g = buildGraph(project({
      'src/dashboard/Avatar.vue': view(),
      'src/App.vue': `<script setup>import Avatar from 'dashboard/missing/Avatar.vue'</script>${view('<Avatar />')}`,
    }))
    expect(g.unresolvedImports).toEqual([{ from: 'src/App.vue', spec: 'dashboard/missing/Avatar.vue' }])
    expect(g.nodes.find((n) => n.id === 'src/App.vue')!.externals).toEqual(['Avatar'])
  })

  it('infers unplugin-vue-components names when components.d.ts is missing', () => {
    const g = buildGraph(project({
      'package.json': JSON.stringify({ devDependencies: { 'unplugin-vue-components': '^0.27' } }),
      'src/App.vue': view('<UserCard />'),
      'src/components/user/UserCard.vue': view(),
    }))
    expect(g.edges.map((e) => `${e.from} -> ${e.to}`)).toEqual(['src/App.vue -> src/components/user/UserCard.vue'])
  })

  it('warns when unresolved tags match local component files', () => {
    const g = buildGraph(project({ 'src/App.vue': view('<UserCard />'), 'src/components/UserCard.vue': view() }))
    expect(g.warnings.join('\n')).toContain('1 tags have the same name as a .vue file')
  })
})

describe('Nuxt', () => {
  const nuxt = (files: Record<string, string>) =>
    buildGraph(project({ 'nuxt.config.ts': 'export default defineNuxtConfig({})', 'app/app.vue': view('<NuxtLayout><NuxtPage /></NuxtLayout>'), ...files }))

  it('maps layout names the way Nuxt does (kebab-case, subdirectories joined)', () => {
    const g = nuxt({
      'app/layouts/AuthPage.vue': view('<slot />'),
      'app/layouts/desktop/default.vue': view('<slot />'),
      'app/layouts/side.vue': view('<slot />'),
      'app/pages/login.vue': `<script setup>definePageMeta({ layout: 'auth-page' })</script>${view()}`,
      'app/pages/mobile.vue': `<script setup>definePageMeta({ layout: 'desktop-default' })</script>${view()}`,
      'app/pages/obj.vue': `<script setup>definePageMeta({ layout: { name: 'side' } })</script>${view()}`,
      'app/pages/moved.vue': `<script setup>definePageMeta({ path: '/elsewhere', alias: ['/old'] })</script>${view()}`,
    })
    const layoutOf = (path: string) => g.routes.find((r) => r.path === path)!.layouts
    expect(layoutOf('/login')).toEqual(['app/layouts/AuthPage.vue'])
    expect(layoutOf('/mobile')).toEqual(['app/layouts/desktop/default.vue'])
    expect(layoutOf('/obj')).toEqual(['app/layouts/side.vue'])
    expect(g.routes.find((r) => r.path === '/elsewhere')!.aliases).toEqual(['/old'])
  })

  it('follows <NuxtLayout name> and resolveComponent', () => {
    const g = nuxt({
      'app/layouts/never.vue': view('<slot />'),
      'app/components/ViaResolve.vue': view(),
      'app/pages/index.vue': `<script setup>definePageMeta({ layout: false })
const C = resolveComponent('ViaResolve')</script>${view('<NuxtLayout name="never"><component :is="C" /></NuxtLayout>')}`,
    })
    expect(g.orphans).toEqual([])
  })

  it('reads Nuxt 3 layers next to an app without app/', () => {
    const g = buildGraph(project({
      'nuxt.config.ts': 'export default defineNuxtConfig({})',
      'app.vue': view('<NuxtLayout><NuxtPage /></NuxtLayout>'),
      'pages/index.vue': view(),
      'layers/site/nuxt.config.ts': 'export default defineNuxtConfig({ components: [{ path: "~/components", pathPrefix: false }] })',
      'layers/site/layouts/default.vue': view('<MainNav /><slot />'),
      'layers/site/components/nav/MainNav.vue': view(),
    }))
    expect(g.orphans).toEqual([])
    expect(g.routes[0].layouts).toEqual(['layers/site/layouts/default.vue'])
  })

  it('links Content pages to the pages that render them, including layer content and og images', () => {
    const g = buildGraph(project({
      'nuxt.config.ts': "export default defineNuxtConfig({ modules: ['@nuxt/content'] })",
      'app/app.vue': view('<NuxtPage />'),
      'app/pages/[...slug].vue': `<script setup>defineOgImage('Docs')\nconst page = await queryCollection('docs').first()</script>${view('<ContentRenderer :value="page" />')}`,
      'app/components/content/Note.vue': view('<slot />'),
      'app/components/OgImage/Docs.takumi.vue': view(),
      'layers/blog/content/hello.md': '# Hi\n\n::note\nhello\n::\n\n::div\nnative\n::\n',
    }))
    expect(g.orphans).toEqual([])
    const note = g.nodes.find((n) => n.id === 'app/components/content/Note.vue')!
    expect(note.routes.map((i) => g.routes[i].path)).toEqual(['/:slug(.*)*'])
    expect(g.nodes.find((n) => n.id === 'layers/blog/content/hello.md')!.externals).toEqual([])
  })

  it('follows auto-imported composables, utils and Content data in impact', () => {
    const root = project({
      'nuxt.config.ts': "export default defineNuxtConfig({ modules: ['@nuxt/content'] })",
      'app/app.vue': view('<NuxtPage />'),
      'app/pages/index.vue': `<script setup>const { data } = await useAsyncData(() => queryCollection('index').first())
const links = navLinks()
const ui = useUiState()</script>${view()}`,
      'app/pages/about.vue': view(),
      'app/utils/links.ts': 'export function navLinks() { return [] }',
      'app/composables/ui.ts': 'export const useUiState = () => ({})',
      'content/index.yml': 'title: Home',
    })
    const { graph, deps } = analyze(root)
    const pagesOf = (file: string) => analyzeImpact(graph, deps, [join(root, file)], '').routes.map((i) => graph.routes[i].path)
    expect(pagesOf('app/utils/links.ts')).toEqual(['/'])
    expect(pagesOf('app/composables/ui.ts')).toEqual(['/'])
    expect(pagesOf('content/index.yml')).toEqual(['/'])
  })
})

describe('impact', () => {
  it('treats dependency and config changes as affecting every page, and never prints a bare "no changes"', () => {
    const root = project({
      'src/main.ts': "import { createApp } from 'vue'\nimport App from './App.vue'\ncreateApp(App)",
      'src/App.vue': view(),
      'vite.config.ts': 'export default {}',
    })
    const { graph, deps } = analyze(root)
    const impact = analyzeImpact(graph, deps, [join(root, 'package.json'), join(root, 'vite.config.ts')], '')
    expect(impact.projectWide).toEqual(['package.json', 'vite.config.ts'])
    expect(impact.everywhere).toBe(true)
  })

  it('reports files that still import a deleted file through any tsconfig alias', () => {
    const root = project({
      'tsconfig.json': JSON.stringify({ compilerOptions: { paths: { '@/*': ['src/*'], '@@/*': ['src/common/*'] } } }),
      'src/App.vue': `<script setup>import { useDevice } from '@@/composables/useDevice'\nuseDevice()</script>${view()}`,
      'src/common/composables/useDevice.ts': 'export const useDevice = () => 1',
    })
    rmSync(join(root, 'src/common/composables/useDevice.ts'))
    const { graph, deps } = analyze(root)
    const impact = analyzeImpact(graph, deps, [join(root, 'src/common/composables/useDevice.ts')], '')
    expect(impact.affected).toEqual(['src/App.vue'])
  })

  it('reports the old path of a renamed file as deleted', () => {
    const root = project({
      'src/App.vue': `<script setup>import Avatar from './users/Avatar.vue'</script>${view('<Avatar />')}`,
      'src/users/Avatar.vue': view(),
    })
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'pipe' })
    git('init', '-q')
    git('add', '-A')
    git('commit', '-qm', 'init')
    git('mv', 'src/users/Avatar.vue', 'src/Avatar.vue')
    const { graph, deps } = analyze(root)
    const impact = analyzeImpact(graph, deps, gitChangedFiles(root, 'HEAD'), 'HEAD')
    expect(impact.deleted).toEqual(['src/users/Avatar.vue'])
    expect(impact.affected).toContain('src/App.vue')
  })

  it('follows lazily loaded locale modules from the entry', () => {
    const root = project({
      'src/main.ts': "import { createApp } from 'vue'\nimport App from './App.vue'\nimport './i18n'\ncreateApp(App)",
      'src/i18n.ts': "export const load = () => import('./locales/en')",
      'src/locales/en.ts': 'export default {}',
      'src/App.vue': view(),
    })
    const { graph, deps } = analyze(root)
    expect(analyzeImpact(graph, deps, [join(root, 'src/locales/en.ts')], '').everywhere).toBe(true)
  })
})

describe('queries', () => {
  const root = project({
    'src/main.ts': "import { createApp } from 'vue'\nimport App from './App.vue'\ncreateApp(App).component('SvgIcon', {})",
    'src/App.vue': `<script setup>import A from './A.vue'\nimport B from './B.vue'</script>${view('<A /><B /><SvgIcon />')}`,
    'src/A.vue': `<script setup>import C from './C.vue'</script>${view('<C />')}`,
    'src/B.vue': `<script setup>import C from './C.vue'</script>${view('<C />')}`,
    'src/C.vue': `<script setup>import Leaf from './Leaf.vue'</script>${view('<Leaf />')}`,
    'src/Leaf.vue': view(),
  })
  const g = buildGraph(root)

  it('counts every ancestor in who_uses', () => {
    expect(whoUses(g, 'Leaf').join('\n')).toContain('Ancestors (4):')
  })

  it('finds components by absolute path, ./ path, path without extension, and Lazy prefix', () => {
    for (const q of [join(g.root, 'src/C.vue'), './src/C.vue', 'src/C', 'LazyC']) expect(findNodes(g, q).map((n) => n.id)).toEqual(['src/C.vue'])
  })

  it('explains external and globally registered names instead of "no match"', () => {
    expect(() => pick(g, 'SvgIcon')).toThrow(QueryError)
    expect(() => pick(g, 'SvgIcon')).toThrow('is not a file in this project')
  })

  it('flags an incomplete analysis at the top of answers', () => {
    const g2 = buildGraph(project({ 'src/App.vue': `<script setup>import X from '@/nope/X.vue'</script>${view()}` }))
    expect(whoUses(g2, 'App')[0]).toMatch(/^! 1 imports couldn't be resolved/)
  })

  it('treats a parent directory with apps in sub-packages like a monorepo root', () => {
    const g3 = buildGraph(project({ 'apps/admin/package.json': '{}', 'apps/admin/src/App.vue': view() }))
    expect(g3.workspacePackages).toEqual(['apps/admin'])
  })
})
