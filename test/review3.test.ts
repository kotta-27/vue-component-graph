import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { analyze, buildGraph } from '../src/graph'
import { setLang } from '../src/i18n'
import { analyzeImpact, gitChangedFiles } from '../src/impact'

/** ファイル一覧から一時プロジェクトを作る */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'vcg-'))
  for (const [path, text] of Object.entries({ 'package.json': '{}', ...files })) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}
const view = (text = '<p />') => `<template>${text}</template>`

beforeAll(() => setLang('en'))

describe('vue-router pages', () => {
  it('keeps a parent whose children only fill named views, even when it is reused', () => {
    const g = buildGraph(project({
      'src/views/Collection.vue': view('<RouterView name="addNew" />'),
      'src/views/AddNew.vue': view(),
      'src/router.ts': `import Collection from './views/Collection.vue'
import AddNew from './views/AddNew.vue'
export const routes = [
  { path: '/', component: Collection, children: [{ path: '+', components: { addNew: AddNew } }] },
  { path: '/folders/:folder', component: Collection, children: [{ path: '+', components: { addNew: AddNew } }] },
  { path: '/all', component: Collection },
]`,
    }))
    expect(g.routes.map((r) => r.path)).toEqual(['/', '/+', '/folders/:folder', '/folders/:folder/+', '/all'])
  })

  it('treats a parent that only lays out named views in several trees as a layout, and picks the unshared view', () => {
    const g = buildGraph(project({
      'src/SettingsLayout.vue': view('<RouterView name="header" /><RouterView name="content" /><RouterView name="sidebar" />'),
      'src/Header.vue': view(),
      'src/Sidebar.vue': view(),
      'src/Group.vue': view(),
      'src/Users.vue': view(),
      'src/router.ts': `const Layout = () => import('./SettingsLayout.vue')
const header = () => import('./Header.vue')
const sidebar = () => import('./Sidebar.vue')
export const routes = [
  { path: '/:org/settings', component: Layout, children: [{ path: 'group', components: { header, content: () => import('./Group.vue'), sidebar } }] },
  { path: '/:org/settings', component: Layout, children: [{ path: 'users', components: { header, content: () => import('./Users.vue'), sidebar } }] },
]`,
    }))
    expect(g.routes.map((r) => `${r.path} ${r.view}`)).toEqual(['/:org/settings/group src/Group.vue', '/:org/settings/users src/Users.vue'])
  })

  it("lets an empty-path child stand for its parent's URL", () => {
    const g = buildGraph(project({
      'src/layouts/Main.vue': view('<RouterView />'),
      'src/pages/Dashboard.vue': view(),
      'src/router.ts': `import Main from './layouts/Main.vue'
import Dashboard from './pages/Dashboard.vue'
export const routes = [{ path: '/', component: Main, children: [{ path: '', component: Dashboard }] }]`,
    }))
    expect(g.routes.map((r) => `${r.path} ${r.view}`)).toEqual(['/ src/pages/Dashboard.vue'])
  })

  it('drops external links', () => {
    const g = buildGraph(project({
      'src/Layout.vue': view('<RouterView />'),
      'src/Home.vue': view(),
      'src/router.ts': `import Layout from './Layout.vue'
import Home from './Home.vue'
export const routes = [
  { path: '/', component: Home },
  { path: 'https://example.com', component: Layout },
  { path: '/link', component: Layout, children: [{ path: 'https://example.com/docs' }] },
]`,
    }))
    expect(g.routes.map((r) => r.path)).toEqual(['/'])
  })
})

describe('webpack-era projects', () => {
  it('resolves require.ensure, require() and project-dir paths like src/components/...', () => {
    const g = buildGraph(project({
      'src/App.vue': view('<RouterView />'),
      'src/page/msite.vue': `<script>import headTop from 'src/components/header/head'
export default { components: { headTop } }</script>
<template><head-top /></template>`,
      'src/components/header/head.vue': view(),
      'src/router.js': `const msite = r => require.ensure([], () => r(require('../src/page/msite.vue')), 'msite')
export default [{ path: '/', component: msite }]`,
    }))
    expect(g.routes.map((r) => `${r.path} ${r.view}`)).toEqual(['/ src/page/msite.vue'])
    expect(g.orphans).toEqual([])
    expect(g.unresolvedImports).toEqual([])
  })

  it('treats require.context like a glob', () => {
    const g = buildGraph(project({
      'src/main.js': "const req = require.context('./components/global', true, /\\.vue$/)\nreq.keys().forEach(() => {})",
      'src/components/global/Icon.vue': view(),
    }))
    expect(g.orphans).toEqual([])
  })

  it('reports imports it cannot resolve', () => {
    const g = buildGraph(project({ 'src/App.vue': `<script setup>import X from '@/missing/X.vue'</script>${view()}` }))
    expect(g.unresolvedImports).toEqual([{ from: 'src/App.vue', spec: '@/missing/X.vue' }])
  })
})

describe('scanning', () => {
  it('reads test/ and build/ inside src, but not at the project root', () => {
    const g = buildGraph(project({
      'src/views/test/Demo.vue': view(),
      'test/Spec.vue': view(),
      'build/Out.vue': view(),
    }))
    expect(g.nodes.map((n) => n.id)).toEqual(['src/views/test/Demo.vue'])
  })

  it('warns at a monorepo root', () => {
    const g = buildGraph(project({
      'pnpm-workspace.yaml': "packages: ['packages/*']",
      'packages/app/package.json': '{}',
      'packages/app/src/App.vue': view(),
    }))
    expect(g.workspacePackages).toEqual(['packages/app'])
  })

  it('does not warn when the root itself is the app (only docs/ is a separate package)', () => {
    const g = buildGraph(project({
      'pnpm-workspace.yaml': "packages: ['docs']",
      'src/App.vue': view(),
      'docs/package.json': '{}',
      'docs/Demo.vue': view(),
    }))
    expect(g.workspacePackages).toBeUndefined()
  })

  it('labels UI library components by prefix', () => {
    const g = buildGraph(project({
      'package.json': JSON.stringify({ dependencies: { quasar: '^2' } }),
      'src/App.vue': view('<q-btn /><RouterView /><MyMissing />'),
    }))
    expect(g.nodes[0].externals).toEqual(['MyMissing', 'QBtn (quasar)', 'RouterView (vue-router)'])
  })
})

describe('impact', () => {
  const root = project({
    'src/main.ts': "import { createApp } from 'vue'\nimport App from './App.vue'\nimport './styles/main.scss'\ncreateApp(App)",
    'src/App.vue': view('<RouterView />'),
    'src/styles/main.scss': "@use 'tooltip';\n@use 'sass:math';",
    'src/styles/_tooltip.scss': '.t {}',
    'src/styles/mixins/_index.scss': '@mixin x {}',
    'src/views/Home.vue': `<script setup>import Item from '../components/Item.vue'</script>${view('<Item />')}<style lang="scss">@use '@/styles/mixins';</style>`,
    'src/components/Item.vue': view(),
    'src/router.ts': "import Home from './views/Home.vue'\nexport const routes = [{ path: '/', component: Home }]",
    'src/unused.ts': 'export const x = 1',
  })
  const { graph, deps } = analyze(root)
  const impactOf = (...files: string[]) => analyzeImpact(graph, deps, files.map((f) => join(root, f)), '')

  it('follows Sass partials and _index files', () => {
    expect(impactOf('src/styles/_tooltip.scss').everywhere).toBe(true)
    expect(impactOf('src/styles/mixins/_index.scss').affected).toEqual(['src/views/Home.vue'])
  })

  it('marks files that still import a deleted file', () => {
    rmSync(join(root, 'src/components/Item.vue'))
    const { graph: g, deps: d } = analyze(root)
    const impact = analyzeImpact(g, d, [join(root, 'src/components/Item.vue')], '')
    expect(impact.deleted).toEqual(['src/components/Item.vue'])
    expect(impact.affected).toEqual(['src/views/Home.vue'])
    expect(impact.routes.map((i) => g.routes[i].path)).toEqual(['/'])
    writeFileSync(join(root, 'src/components/Item.vue'), view())
  })

  it('lists changes that reach nothing instead of silently reporting no impact', () => {
    expect(impactOf('src/unused.ts').unlinked).toEqual(['src/unused.ts'])
  })

  it('suggests refs that exist when the given one does not', () => {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@e', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'pipe' })
    git('init', '-q', '-b', 'trunk')
    git('add', '-A')
    git('commit', '-qm', 'init')
    expect(() => gitChangedFiles(root, 'main')).toThrow('git ref "main" not found')
  })
})
