import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { parseFile, STYLE_RE, type FileInfo, type RawRoute } from './parse'
import { t } from './i18n'
import { createResolver, srcDirOf, type Resolver } from './resolve'

export type EdgeType = 'template' | 'script'

export interface GraphNode {
  id: string
  /** コンポーネント名（Foo/index.vue → Foo、自動 import ならディレクトリ名付き）。モジュールはパス */
  name: string
  /** 表示名。name が他と重なるときは、区別できるまで親ディレクトリを付ける */
  label: string
  kind: 'component' | 'module' | 'external'
  group: string
  entry: boolean
  lines: number
  /** template で使われているが解決できなかった（ライブラリ等の）コンポーネント */
  externals: string[]
  /** このコンポーネントが表示されるルート（Graph.routes の添字） */
  routes: number[]
  /** createApp() のルート配下で、全ページに表示される */
  shell: boolean
}

export interface RouteInfo {
  path: string
  /** path が式（`c.path` など）で、実際の URL は実行時に決まる */
  dynamic: boolean
  /** このルートのメインの画面（名前付きビューなら default） */
  view: string
  /** 親ルートの画面（外側 → 内側） */
  layouts: string[]
  /** このルートで描画されるルートコンポーネントすべて（layouts、view、名前付きビュー） */
  chain: string[]
  /** ルートを定義しているファイル */
  source: string
}

export interface GraphEdge {
  from: string
  to: string
  /** template = template で描画、script = import のみ（ルート定義・h() など） */
  type: EdgeType
  async: boolean
}

export interface Graph {
  root: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** 2 つ以上のコンポーネントからなる循環 */
  cycles: string[][]
  /** 自分自身を描画する再帰コンポーネント */
  recursive: string[]
  /** どこからも使われていないコンポーネント */
  orphans: string[]
  routes: RouteInfo[]
  /** createApp() を呼んでいるモジュール */
  entries: string[]
  warnings: string[]
  /** ルートを作れないファイルベースルーティングのディレクトリ（vue-router の Vite プラグインなど） */
  unsupportedPagesDir?: string
  /** VitePress のサイト。ページは Markdown で、ルートは列挙しない */
  vitepress?: boolean
}

/**
 * 影響分析用：ファイル id → そのファイルが参照しているファイル id。
 * static は import・CSS の @import・template のアセット参照、lazy は動的 import と import.meta.glob
 */
export interface FileDeps {
  static: Map<string, Set<string>>
  lazy: Map<string, Set<string>>
  /**
   * コンポーネントを集めるモジュール（ルート定義、createRouter、createApp、グローバル登録、glob、バレル）。
   * 部品が変わってもこれらを使う側には影響しない（ページは routes から求める）
   */
  hubs: Set<string>
  /** hubs のうちバレル以外。何が変わっても、ここから先（ストアなどを経由した利用者）には伝えない */
  sinks: Set<string>
}

export interface BuildOptions {
  externals?: boolean
}

const IGNORE_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.nuxt', '.output',
  '.vite', '.vercel', '.wrangler', '.turbo', 'test', 'tests', '__tests__', 'e2e', 'cypress', 'playwright',
])
const SOURCE_RE = /\.(vue|[cm]?[jt]sx?)$/
const SKIP_FILE_RE = /\.d\.ts$|\.(test|spec|stories|story)\.[^.]+$|(^|[\\/])[\w.-]+\.config\.[^.]+$/

export function scanFiles(root: string, { markdown = false } = {}): string[] {
  const out: string[] = []
  const visit = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) {
        // VitePress のテーマ（.vitepress/theme）は読む。キャッシュとビルド結果は除く
        const vitepress = ent.name === '.vitepress'
        const vitepressOutput = basename(dir) === '.vitepress' && (ent.name === 'cache' || ent.name === 'dist')
        if (!IGNORE_DIRS.has(ent.name) && (!ent.name.startsWith('.') || vitepress) && !vitepressOutput) visit(p)
      } else if (SKIP_FILE_RE.test(ent.name)) {
        continue
      } else if (SOURCE_RE.test(ent.name) || STYLE_RE.test(ent.name) || (markdown && ent.name.endsWith('.md'))) {
        out.push(p)
      }
    }
  }
  visit(root)
  return out.sort()
}

/** `my-comp` / `myComp` / `MyComp.vue` → `MyComp` */
export function toPascal(name: string): string {
  return name
    .replace(/\.vue$/, '')
    .split(/[-_]/)
    .filter(Boolean)
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join('')
}

interface Target {
  file?: string
  external?: string
  async: boolean
}

export function buildGraph(rootDir: string, options: BuildOptions = {}): Graph {
  return analyze(rootDir, options).graph
}

export function analyze(rootDir: string, options: BuildOptions = {}): { graph: Graph; deps: FileDeps } {
  // git が返すパスと揃えるため、シンボリックリンクを解決しておく
  const root = realpathSync(resolve(rootDir))
  const resolveImport = createResolver(root)
  const infos = new Map<string, FileInfo>()
  const warnings: string[] = []
  const rel = (f: string) => relative(root, f).split(sep).join('/')

  const vitepress = isVitepress(root)
  for (const file of scanFiles(root, { markdown: vitepress })) {
    const info = parseFile(file)
    // Markdown はコンポーネントを使っているページだけを残す
    if (file.endsWith('.md') && !info.imports.length && !info.tags.length) continue
    infos.set(file, info)
    for (const e of info.errors) warnings.push(`${rel(file)}: ${e.split('\n')[0]}`)
  }

  const barrel = createBarrelResolver(infos, resolveImport)

  const srcDir = srcDirOf(root)
  const auto = loadAutoImports(root, (spec, dts) => warnings.push(t('staleAutoImport', rel(dts), spec)))
  // .nuxt/ は nuxt dev / nuxt prepare で生成されるので、clone 直後や CI には無い
  if (isNuxt(root) && !existsSync(join(root, '.nuxt/components.d.ts'))) {
    for (const [key, t] of nuxtComponents(join(srcDir, 'components'))) if (!auto.has(key)) auto.set(key, t)
  }

  /** import のソースと名前から .vue ファイル（または外部パッケージ名）を求める */
  const targetOf = (source: string, imported: string, importer: string, async: boolean): Target | null => {
    if (source.includes('?')) return null // ?raw / ?url などはコンポーネントとしての依存ではない
    if (source === '#components') {
      // Nuxt の仮想モジュール。自動 import と同じ名前で引ける
      const t = auto.get(toPascal(imported))
      return t ? { ...t, async: async || t.async } : null
    }
    const file = resolveImport(source, importer)
    if (!file) return /^[@\w]/.test(source) && !source.startsWith('@/') ? { external: source, async } : null
    // コンポーネントは default エクスポート。名前付き（型など）は描画の依存ではない（影響分析では deps で辿る）
    if (file.endsWith('.vue')) return imported === 'default' ? { file, async } : null
    // JSX / TSX のコンポーネントは解析しないが、どのファイルかは示す
    const found = /\.[jt]sx$/.test(file) ? file : barrel(file, imported)
    if (!found) return null
    return found.endsWith('.vue') ? { file: found, async } : { external: rel(found), async }
  }

  // app.component() によるグローバル登録
  const globals = new Map<string, Target>()
  for (const info of infos.values()) {
    for (const g of info.globals) {
      const t = g.source
        ? targetOf(g.source, 'default', info.file, true)
        : bindingTarget(info, g.local!, targetOf)
      if (t?.file) globals.set(toPascal(g.name), t)
      // .vue に解決できなくても、その名前でグローバル登録されていること自体は覚えておく
      else if (!globals.has(toPascal(g.name))) globals.set(toPascal(g.name), { external: t?.external ?? 'app.component', async: false })
    }
  }

  /** import.meta.glob('./views/**\/*.vue') に一致するファイル */
  const allFiles = [...infos.keys()]
  const globFiles = (info: FileInfo): string[] => {
    if (!info.globs.length) return []
    const toRegex = (pattern: string) => {
      const abs = pattern.startsWith('/') ? join(root, pattern)
        : /^[@~]\//.test(pattern) ? join(srcDir, pattern.slice(2))
        : resolve(dirname(info.file), pattern)
      return globToRegExp(abs.split(sep).join('/'))
    }
    const include = info.globs.filter((g) => !g.startsWith('!')).map(toRegex)
    const exclude = info.globs.filter((g) => g.startsWith('!')).map((g) => toRegex(g.slice(1)))
    return allFiles.filter((f) => {
      const p = f.split(sep).join('/')
      return include.some((re) => re.test(p)) && !exclude.some((re) => re.test(p))
    })
  }

  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()
  // ページをファイルで決める構成では、pages/ のコンポーネントをパスで呼ぶ（index や [id] だらけになるため）
  const nuxtProject = isNuxt(root)
  const pagesDir = join(srcDir, 'pages')
  const fileRouting = nuxtProject || ([...infos.values()].every((i) => !i.routes.length) && existsSync(pagesDir))
  const nameOf = (file: string) => componentName(relative(srcDir, file), fileRouting)
  const entryOf = (file: string) => isFrameworkEntry(relative(srcDir, file), { fileRouting, nuxt: nuxtProject, vitepress })

  const addEdge = (from: string, to: string, type: EdgeType, async: boolean) => {
    const key = `${from}\0${to}`
    const prev = edges.get(key)
    if (!prev) edges.set(key, { from, to, type, async })
    else {
      if (type === 'template') prev.type = 'template'
      prev.async &&= async
    }
  }

  for (const info of infos.values()) {
    if (info.kind !== 'component') continue
    const id = rel(info.file)
    nodes.set(id, {
      id,
      name: nameOf(info.file),
      label: '',
      kind: 'component',
      group: groupOf(relative(srcDir, info.file)),
      entry: entryOf(info.file),
      lines: info.lines,
      externals: [],
      routes: [],
      shell: false,
    })
  }
  // 自動 import ではディレクトリ名が名前に付く（components/user/Card.vue → UserCard）
  for (const [key, t] of auto) {
    const n = t.file && !t.async ? nodes.get(rel(t.file)) : undefined
    if (n && toPascal(n.name) === toPascal(nameOf(t.file!))) n.name = key
  }

  for (const info of infos.values()) {
    const from = rel(info.file)
    const usedLocals = new Set<string>()
    const externals = new Set<string>()

    if (info.kind === 'component') {
      // 名前 → 対象（ローカル import と Options API の登録）
      const local = new Map<string, { target: Target; local?: string }>()
      for (const imp of info.imports) {
        const t = targetOf(imp.source, imp.imported, info.file, imp.async)
        if (t) local.set(toPascal(imp.local), { target: t, local: imp.local })
      }
      for (const r of info.registered) {
        const t = r.source
          ? targetOf(r.source, 'default', info.file, true)
          : bindingTarget(info, r.local!, targetOf)
        if (t) local.set(toPascal(r.name), { target: t, local: r.local })
      }
      const selfName = toPascal(basename(info.file))
      // <script setup> の変数とタグの対応は Vue と同じ規則にする（shareRequest() は <ShareRequest> ではない）
      const inline = new Set(info.locals)
      const isInline = (tag: string) => {
        const camel = tag.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())
        return inline.has(tag) || inline.has(camel) || inline.has(camel[0].toUpperCase() + camel.slice(1))
      }

      const use = (name: string, dynamic: boolean) => {
        const key = toPascal(name.split('.')[0])
        const hit = local.get(key)
        if (hit) {
          if (hit.local) usedLocals.add(hit.local)
          if (hit.target.file) addEdge(from, rel(hit.target.file), 'template', hit.target.async)
          else externals.add(`${key} (${hit.target.external})`)
          return
        }
        if (dynamic && !/^[A-Z]/.test(name) && !name.includes('-')) return // :is の変数名など
        if (isInline(name.split('.')[0])) return // 同じファイル内で定義したコンポーネント
        // Vue はグローバル登録を先に探し、ファイル名による自己参照は最後に試す
        const g = globals.get(key) ?? auto.get(key)
        if (g?.file) return addEdge(from, rel(g.file), 'template', g.async)
        if (g?.external) return void (dynamic || externals.add(`${key} (${g.external})`))
        if (key === selfName) return addEdge(from, from, 'template', false)
        if (!dynamic) externals.add(key)
      }
      for (const tag of info.tags) use(tag, false)
      for (const name of info.dynamicIs) use(name, true)

      // template で見つからなかった .vue の import は script 由来の依存
      for (const imp of info.imports) {
        if (usedLocals.has(imp.local)) continue
        const t = targetOf(imp.source, imp.imported, info.file, imp.async)
        if (t?.file) addEdge(from, rel(t.file), 'script', t.async)
      }
      nodes.get(from)!.externals = [...externals].sort()
    } else {
      for (const imp of info.imports) {
        const t = targetOf(imp.source, imp.imported, info.file, imp.async)
        if (t?.file) addEdge(from, rel(t.file), 'script', t.async)
      }
    }

    for (const b of info.bareImports) {
      if (b.source.includes('?')) continue
      const file = resolveImport(b.source, info.file)
      if (file?.endsWith('.vue')) addEdge(from, rel(file), 'script', b.async)
    }
    for (const file of globFiles(info)) if (file.endsWith('.vue')) addEdge(from, rel(file), 'script', true)
  }

  // .vue を import している JS/TS モジュールだけをノードにする
  for (const e of edges.values()) {
    if (nodes.has(e.from)) continue
    nodes.set(e.from, {
      id: e.from,
      name: e.from.split('/').pop()!,
      label: '',
      kind: 'module',
      group: 'module',
      entry: true,
      lines: infos.get(join(root, e.from))?.lines ?? 0,
      externals: [],
      routes: [],
      shell: false,
    })
  }
  // スキャン対象外（親ディレクトリなど）の .vue
  for (const e of edges.values()) {
    if (nodes.has(e.to)) continue
    nodes.set(e.to, {
      id: e.to,
      name: nameOf(join(root, e.to)),
      label: '',
      kind: 'component',
      group: '(outside)',
      entry: false,
      lines: 0,
      externals: [],
      routes: [],
      shell: false,
    })
  }

  if (options.externals) {
    for (const n of [...nodes.values()]) {
      for (const ext of n.externals) {
        const id = `external:${ext}`
        if (!nodes.has(id)) {
          nodes.set(id, {
            id, name: ext, label: ext, kind: 'external', group: 'external', entry: false, lines: 0, externals: [], routes: [], shell: false,
          })
        }
        addEdge(n.id, id, 'template', false)
      }
    }
  }

  assignLabels([...nodes.values()])

  const edgeList = [...edges.values()]
  const incoming = new Set(edgeList.filter((e) => e.from !== e.to).map((e) => e.to))
  const orphans = [...nodes.values()]
    .filter((n) => n.kind === 'component' && !n.entry && !incoming.has(n.id))
    .map((n) => n.id)

  // ルート定義と createApp() のルート
  const routes: RouteInfo[] = []
  const wrappers: { index: number; view: string; leaf: boolean }[] = []
  /** 画面ごとの、子ルートを持つ親としての使用回数 */
  const parentUses = new Map<string, number>()
  const shellRoots = new Set<string>()
  const entries = new Set<string>()
  for (const info of infos.values()) {
    for (const local of info.appRoots) {
      const t = bindingTarget(info, local, targetOf)
      if (!t?.file) continue
      shellRoots.add(rel(t.file))
      entries.add(rel(info.file))
    }
    const add = (r: RawRoute, parentChain: string[], parentPath: string, parentDynamic: boolean) => {
      const own: { id: string; view: string }[] = []
      for (const ref of r.refs) {
        const t = ref.source
          ? targetOf(ref.source, 'default', info.file, true)
          : bindingTarget(info, ref.local!, targetOf)
        if (t?.file) own.push({ id: rel(t.file), view: ref.view })
      }
      const path = r.dynamic ? (parentPath ? `${parentPath}/${r.path}` : r.path) : joinRoutePath(parentPath, r.path)
      const dynamic = parentDynamic || r.dynamic
      const view = (own.find((o) => o.view === 'default') ?? own[0])?.id
      // 子ルートの親として渡すのはメインの画面だけ（名前付きビューは子に引き継がない）
      const layouts = view ? [...parentChain, view] : parentChain
      if (view && r.children.length) parentUses.set(view, (parentUses.get(view) ?? 0) + 1)
      // redirect のあるルートはそれ自体を描画しない（子ルートのレイアウトとしては使う）
      if (view && !r.redirect) {
        // 空パスの子がないルートは、レイアウトだけを描画している可能性がある（判定は全ルートを見てから）
        if (!r.children.some((c) => c.path === '')) wrappers.push({ index: routes.length, view, leaf: !r.children.length })
        routes.push({
          path,
          dynamic,
          view,
          layouts: parentChain,
          chain: [...parentChain, ...own.map((o) => o.id)],
          source: rel(info.file),
        })
      }
      for (const c of r.children) add(c, layouts, path, dynamic)
    }
    for (const r of info.routes) add(r, [], '', false)
  }
  // 複数の親ルートで使われている画面はレイアウト（管理画面の Layout など）。その親ルート自体はページに数えない。
  // 子のないルートでレイアウトを指定したもの（メニュー用の外部リンクなど）も同じ。
  // 1 か所でしか使われない親（一覧の /users に詳細の :id がぶら下がる形など）はページとして残す
  const layoutOnly = new Set(
    wrappers.filter((w) => (parentUses.get(w.view) ?? 0) > (w.leaf ? 0 : 1)).map((w) => w.index),
  )
  if (layoutOnly.size) {
    const kept = routes.filter((_, i) => !layoutOnly.has(i))
    routes.length = 0
    routes.push(...kept)
  }
  const nuxt = nuxtRoutes(root, srcDir, rel)
  if (nuxt) {
    routes.push(...nuxt.routes)
    for (const id of nuxt.shell) shellRoots.add(id)
  }

  // ルートの起点から、コンポーネント同士の辺だけを辿る
  const childrenOf = new Map<string, string[]>()
  for (const e of edgeList) {
    if (e.from === e.to || nodes.get(e.from)?.kind !== 'component') continue
    if (!childrenOf.has(e.from)) childrenOf.set(e.from, [])
    childrenOf.get(e.from)!.push(e.to)
  }
  const reachFrom = (starts: Iterable<string>) => {
    const seen = new Set<string>()
    const queue = [...starts].filter((id) => nodes.has(id))
    for (const id of queue) seen.add(id)
    while (queue.length) {
      for (const next of childrenOf.get(queue.shift()!) ?? []) {
        if (!seen.has(next)) {
          seen.add(next)
          queue.push(next)
        }
      }
    }
    return seen
  }
  for (const id of reachFrom(shellRoots)) nodes.get(id)!.shell = true
  routes.forEach((r, i) => {
    for (const id of reachFrom(r.chain)) nodes.get(id)!.routes.push(i)
  })

  // 影響分析用：ファイル単位の参照（?raw、CSS、画像なども含む）
  const deps: FileDeps = { static: new Map(), lazy: new Map(), hubs: new Set(), sinks: new Set() }
  for (const info of infos.values()) {
    const statics = new Set<string>()
    const lazies = new Set<string>()
    const add = (set: Set<string>, file: string | null) => file && set.add(rel(file))
    for (const i of info.imports) add(i.async ? lazies : statics, resolveImport(i.source, info.file))
    for (const b of info.bareImports) add(b.async ? lazies : statics, resolveImport(b.source, info.file))
    for (const r of info.reExports) if (r.source) add(statics, resolveImport(r.source, info.file))
    for (const a of info.assets) add(statics, resolveAsset(a, info.file))
    for (const f of globFiles(info)) add(lazies, f)
    deps.static.set(rel(info.file), statics)
    deps.lazy.set(rel(info.file), lazies)
    if (info.kind === 'module') {
      const id = rel(info.file)
      const barrel = info.reExports.some((r) => r.source && resolveImport(r.source, info.file)?.endsWith('.vue'))
      const sink = info.routes.length || info.createsRouter || info.appRoots.length || info.globals.length || info.globs.length
      if (sink) deps.sinks.add(id)
      if (sink || barrel) deps.hubs.add(id)
    }
  }

  const graph: Graph = {
    root,
    nodes: [...nodes.values()],
    edges: edgeList,
    cycles: findCycles([...nodes.keys()], edgeList),
    recursive: edgeList.filter((e) => e.from === e.to).map((e) => e.from),
    orphans,
    routes,
    entries: [...entries],
    warnings,
  }
  if (vitepress) graph.vitepress = true
  else if (!routes.length && fileRouting && !nuxtProject) graph.unsupportedPagesDir = rel(pagesDir)
  return { graph, deps }

  /** CSS の @import 'variables'（拡張子・_ 省略）や、public/ を指す /logo.png も解決する */
  function resolveAsset(ref: string, importer: string): string | null {
    const spec = ref.split(/\s*,\s*/)[0].split(/\s+/)[0].replace(/[?#].*$/, '')
    if (spec.startsWith('/')) {
      for (const base of [join(root, 'public'), root]) if (isFile(join(base, spec))) return join(base, spec)
      return null
    }
    const hit = resolveImport(spec, importer)
    if (hit) return hit
    if (!STYLE_RE.test(importer) && !importer.endsWith('.vue')) return null
    const dir = dirname(spec)
    const name = basename(spec)
    for (const candidate of [name, `_${name}`]) {
      for (const ext of ['', '.scss', '.sass', '.less', '.styl', '.css']) {
        const p = resolveImport(join(dir, candidate + ext), importer)
        if (p) return p
      }
    }
    return null
  }
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** `./views/**\/*.{vue,tsx}` → 正規表現（** と * と {a,b} と ? に対応） */
export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      re += glob[i + 2] === '/' ? '(?:.*/)?' : '.*'
      i += glob[i + 2] === '/' ? 2 : 1
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if (c === '{') {
      const end = glob.indexOf('}', i)
      re += `(?:${glob.slice(i + 1, end).split(',').map(escapeRe).join('|')})`
      i = end
    } else re += escapeRe(c)
  }
  return new RegExp(`^${re}$`)
}

const escapeRe = (s: string) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')

/** VitePress のサイト（.vitepress がルートか docs/・src/ にある） */
function isVitepress(root: string): boolean {
  return ['', 'docs', 'src'].some((d) => existsSync(join(root, d, '.vitepress')))
}

function joinRoutePath(parent: string, child: string): string {
  if (child.startsWith('/')) return child
  if (!child) return parent || '/'
  return `${parent.replace(/\/$/, '')}/${child}`
}

/** Nuxt のファイルベースルーティング（pages/）と、全ページ共通の app.vue / layouts/default.vue */
function nuxtRoutes(root: string, srcDir: string, rel: (f: string) => string) {
  if (!isNuxt(root)) return null
  const shell = ['app.vue', 'layouts/default.vue']
    .map((p) => join(srcDir, p))
    .filter((p) => existsSync(p))
    .map(rel)
  const routes: RouteInfo[] = []
  const pagesDir = join(srcDir, 'pages')
  if (!existsSync(pagesDir)) return { routes, shell }

  const files: string[] = []
  const visit = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) visit(p)
      else if (ent.name.endsWith('.vue')) files.push(p)
    }
  }
  visit(pagesDir)

  for (const file of files.sort()) {
    // pages/settings.vue と pages/settings/index.vue があれば、/settings は index.vue（settings.vue はその親）
    if (existsSync(join(file.replace(/\.vue$/, ''), 'index.vue'))) continue
    const segs = relative(pagesDir, file).replace(/\.vue$/, '').split(sep)
    const parts = segs
      .filter((seg) => seg !== 'index' && !/^\(.*\)$/.test(seg))
      .map((seg) =>
        seg
          .replace(/\[\[(\w+)\]\]/g, ':$1?')
          .replace(/\[\.\.\.(\w+)\]/g, ':$1(.*)*')
          .replace(/\[(\w+)\]/g, ':$1'),
      )
    // pages/users.vue があれば pages/users/[id].vue の親ルートになる
    const layouts: string[] = []
    for (let i = 1; i < segs.length; i++) {
      const parent = join(pagesDir, ...segs.slice(0, i)) + '.vue'
      if (existsSync(parent)) layouts.push(rel(parent))
    }
    const view = rel(file)
    routes.push({ path: '/' + parts.join('/'), dynamic: false, view, layouts, chain: [...layouts, view], source: rel(pagesDir) })
  }
  return { routes, shell }
}

function isNuxt(root: string): boolean {
  return ['ts', 'js', 'mjs', 'mts'].some((ext) => existsSync(join(root, `nuxt.config.${ext}`)))
}

const NUXT_BUILTINS = [
  'NuxtLink', 'NuxtPage', 'NuxtLayout', 'NuxtErrorBoundary', 'NuxtLoadingIndicator', 'NuxtRouteAnnouncer',
  'NuxtAnnouncer', 'NuxtClientFallback', 'NuxtIsland', 'NuxtTime', 'NuxtWelcome', 'NuxtImg', 'NuxtPicture',
  'ClientOnly', 'DevOnly', 'ServerPlaceholder',
]

/**
 * .nuxt/components.d.ts が無いときに、components/ から Nuxt と同じ規則で名前を組み立てる。
 * components/user/Card.vue → UserCard、components/base/BaseButton.vue → BaseButton（重複は省く）
 */
function nuxtComponents(componentsDir: string): Map<string, Target> {
  const map = new Map<string, Target>(NUXT_BUILTINS.map((name) => [name, { external: 'nuxt', async: false }]))
  if (!existsSync(componentsDir)) return map
  const visit = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) visit(p)
      else if (ent.name.endsWith('.vue')) {
        let fileName = basename(ent.name, '.vue').replace(/(\.(server|client))?(\.global)?$/, '')
        if (fileName.toLowerCase() === 'index') fileName = ''
        const prefix = splitByCase(relative(componentsDir, dir))
        const name = nuxtComponentName(splitByCase(fileName), prefix)
        if (!name || map.has(name)) continue
        map.set(name, { file: p, async: false })
        map.set(`Lazy${name}`, { file: p, async: true })
      }
    }
  }
  visit(componentsDir)
  return map
}

/** Nuxt の resolveComponentNameSegments と同じ。ファイル名がディレクトリ名で始まるなら、その分を省く */
function nuxtComponentName(fileParts: string[], prefixParts: string[]): string {
  const fileContent = fileParts.join('/').toLowerCase()
  const nameParts = [...prefixParts]
  const matched: string[] = []
  for (let i = prefixParts.length - 1; i >= 0; i--) {
    matched.unshift(prefixParts[i].toLowerCase())
    const m = matched.join('/')
    if (
      fileContent === m ||
      fileContent.startsWith(m + '/') ||
      // Item/Item/Item.vue → Item
      (prefixParts[i].toLowerCase() === fileContent && prefixParts[i] === prefixParts[i + 1])
    ) {
      nameParts.length = i
    }
  }
  return [...nameParts, ...fileParts].map((s) => s[0].toUpperCase() + s.slice(1)).join('')
}

/** `base/myButton` → ['base', 'my', 'Button']、`HTMLParser` → ['HTML', 'Parser'] */
function splitByCase(s: string): string[] {
  return s.split(/[-_./\\]/).flatMap((p) => p.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z0-9]+|[A-Z]/g) ?? [])
}

function bindingTarget(
  info: FileInfo,
  local: string,
  targetOf: (source: string, imported: string, importer: string, async: boolean) => Target | null,
): Target | null {
  const imp = findImport(info, local)
  return imp ? targetOf(imp.source, imp.imported, info.file, imp.async) : null
}

/** 変数の元になった import。`const Perms = withInstall(perms)` のような別名も辿る */
function findImport(info: FileInfo, local: string) {
  for (let name: string | undefined = local, i = 0; name && i < 5; name = info.aliases[name], i++) {
    const imp = info.imports.find((x) => x.local === name)
    if (imp) return imp
  }
  return undefined
}

/** `export { default as Foo } from './Foo.vue'` のようなバレルを辿る */
function createBarrelResolver(infos: Map<string, FileInfo>, resolveImport: Resolver) {
  const lookup = (file: string, name: string, depth: number): string | null => {
    const info = infos.get(file)
    if (!info || depth > 5) return null
    for (const r of info.reExports) {
      if (r.exported !== name && r.exported !== '*') continue
      let source = r.source
      let imported = r.exported === '*' ? name : r.imported
      if (r.local) {
        const imp = findImport(info, r.local)
        if (!imp) continue
        source = imp.source
        imported = imp.imported
      }
      const target = source ? resolveImport(source, file) : null
      if (!target) continue
      if (target.endsWith('.vue')) {
        if (imported === 'default') return target
        continue
      }
      // JSX / TSX のコンポーネント（解析はしないが、どこにあるかは返す）
      if (/\.[jt]sx$/.test(target) && imported === 'default') return target
      const hit = lookup(target, imported, depth + 1)
      if (hit) return hit
    }
    return null
  }
  return (file: string, name: string) => (name === '*' ? null : lookup(file, name, 0))
}

/** unplugin-vue-components / Nuxt が生成する components.d.ts を読む */
function loadAutoImports(root: string, onMissing: (spec: string, dts: string) => void): Map<string, Target> {
  const map = new Map<string, Target>()
  const candidates = [
    'components.d.ts',
    'src/components.d.ts',
    'types/components.d.ts',
    'src/types/components.d.ts',
    '.nuxt/components.d.ts',
  ].map((p) => join(root, p))
  const re = /['"]?([A-Za-z][\w]*)['"]?\s*:\s*(\w+<\s*)?typeof import\(\s*['"]([^'"]+)['"]\s*\)/g
  for (const file of candidates) {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    for (const m of text.matchAll(re)) {
      const [, name, wrapper, spec] = m
      const key = toPascal(name)
      if (map.has(key)) continue
      const async = !!wrapper && /^Lazy/.test(name)
      if (spec.startsWith('.') && !spec.includes('node_modules') && spec.endsWith('.vue')) {
        const target = resolve(dirname(file), spec)
        // 消したファイルの登録が残った古い components.d.ts
        if (!existsSync(target)) {
          if (!async) onMissing(spec, file)
          continue
        }
        map.set(key, { file: target, async })
      } else {
        const pkg = spec.replace(/^(\.\.?\/)*node_modules\//, '').match(/^(@[^/]+\/)?[^/]+/)?.[0] ?? spec
        map.set(key, { external: pkg, async })
      }
    }
  }
  return map
}

/** index.vue の名前にしない、構成上のディレクトリ */
const GENERIC_DIRS = new Set(['src', 'lib', 'app', 'components', 'views', 'pages', 'packages', 'theme'])

/**
 * Foo/index.vue → Foo（Foo/src/index.vue も Foo）。名前にできるディレクトリがなければパス（pages/index）。
 * ファイルベースルーティングの pages/ と Markdown のページはパスのまま（pages/users/[id]、guide/intro.md）
 */
function componentName(pathFromSrc: string, fileRouting: boolean): string {
  const path = pathFromSrc.split(sep).join('/').replace(/^(\.\.\/)+/, '')
  if (path.endsWith('.md')) return path
  const p = path.replace(/\.vue$/, '')
  if (fileRouting && p.startsWith('pages/')) return p
  const parts = p.split('/')
  if (parts[parts.length - 1] !== 'index' || parts.length === 1) return parts[parts.length - 1]
  const dir = parts.slice(0, -1).reverse().find((d) => !GENERIC_DIRS.has(d))
  return dir ?? p
}

/**
 * 表示名を決める。名前が重なるもの（components/a/Item.vue と b/Item.vue、index.ts どうしなど）は、
 * 区別できるまで親ディレクトリを付ける。index.* のモジュールは単独でもディレクトリを付ける
 */
function assignLabels(nodes: GraphNode[]) {
  const trimmed = (n: GraphNode) => (n.kind === 'component' ? n.id.replace(/\.vue$/, '').replace(/\/index$/, '') : n.id)
  const tail = (n: GraphNode, k: number) => trimmed(n).split('/').slice(-k).join('/')
  const groups = new Map<string, GraphNode[]>()
  for (const n of nodes) {
    if (n.kind === 'external') continue
    const key = n.name.toLowerCase()
    groups.set(key, [...(groups.get(key) ?? []), n])
  }
  for (const group of groups.values()) {
    for (const n of group) {
      const depth = trimmed(n).split('/').length
      let k = n.kind === 'module' && /^index\./.test(n.name) ? 2 : 1
      if (group.length > 1) {
        k = Math.max(k, 2)
        while (k < depth && group.some((m) => m !== n && tail(m, k) === tail(n, k))) k++
      }
      n.label = k === 1 ? n.name : tail(n, k)
    }
  }
}

function groupOf(pathFromSrc: string): string {
  const parts = pathFromSrc.split(sep)
  return parts.length > 1 && parts[0] !== '..' ? parts[0] : '(root)'
}

/** フレームワークが直接描画するファイル（Nuxt の pages/・layouts/、ファイルベースルーティングの pages/、App.vue など） */
function isFrameworkEntry(
  pathFromSrc: string,
  { fileRouting, nuxt, vitepress }: { fileRouting: boolean; nuxt: boolean; vitepress: boolean },
): boolean {
  const p = pathFromSrc.split(sep).join('/')
  if (/^(app|App)\.vue$/.test(p)) return true
  if (vitepress && p.endsWith('.md')) return true
  // ファイルベースルーティングでは layouts/ も vite-plugin-vue-layouts などが描画する
  if (fileRouting && /^(pages|layouts)\//.test(p)) return true
  return nuxt && p === 'error.vue'
}

/** Tarjan の強連結成分分解で、要素数 2 以上の循環を返す */
function findCycles(ids: string[], edges: GraphEdge[]): string[][] {
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const e of edges) if (e.from !== e.to) adj.get(e.from)?.push(e.to)

  let index = 0
  const idx = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const result: string[][] = []

  const strong = (v: string) => {
    idx.set(v, index)
    low.set(v, index++)
    stack.push(v)
    onStack.add(v)
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) {
        strong(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, idx.get(w)!))
      }
    }
    if (low.get(v) === idx.get(v)) {
      const scc: string[] = []
      let w
      do {
        w = stack.pop()!
        onStack.delete(w)
        scc.push(w)
      } while (w !== v)
      if (scc.length > 1) result.push(scc.reverse())
    }
  }
  for (const id of ids) if (!idx.has(id)) strong(id)
  return result
}

export type Direction = 'down' | 'up'

/** 指定ノードから辿れる部分グラフ（down = 子孫、up = 祖先） */
export function subgraph(graph: Graph, startId: string, direction: Direction): Graph {
  const keep = new Set([startId])
  const queue = [startId]
  while (queue.length) {
    const cur = queue.shift()!
    for (const e of graph.edges) {
      const [a, b] = direction === 'down' ? [e.from, e.to] : [e.to, e.from]
      if (a === cur && !keep.has(b)) {
        keep.add(b)
        queue.push(b)
      }
    }
  }
  return {
    ...graph,
    nodes: graph.nodes.filter((n) => keep.has(n.id)),
    edges: graph.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    cycles: graph.cycles.filter((c) => c.every((id) => keep.has(id))),
    recursive: graph.recursive.filter((id) => keep.has(id)),
    orphans: graph.orphans.filter((id) => keep.has(id)),
  }
}

/** コンポーネント名またはパスの末尾一致でノードを探す */
export function findNodes(graph: Graph, query: string): GraphNode[] {
  const q = query.replace(/\\/g, '/')
  const exact = graph.nodes.filter((n) => n.id === q)
  if (exact.length) return exact
  // 大文字小文字は区別しない（tableaction でも TableAction）
  const key = (s: string) => toPascal(s).toLowerCase()
  const byName = graph.nodes.filter((n) => key(n.name) === key(q))
  if (byName.length) return byName
  const byLabel = graph.nodes.filter((n) => n.label === q)
  if (byLabel.length) return byLabel
  return graph.nodes.filter(
    (n) => n.id.endsWith('/' + q) || n.id.endsWith('/' + q + '.vue') || n.id.endsWith('/' + q + '/index.vue'),
  )
}
