import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { parseFile, type FileInfo, type RawRoute } from './parse'
import { createResolver, srcDirOf, type Resolver } from './resolve'

export type EdgeType = 'template' | 'script'

export interface GraphNode {
  id: string
  name: string
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
  /** 外側 → 内側の順に描画されるコンポーネント（ネストしたルートの親を含む） */
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
}

/** ファイル id → そのファイルが import しているファイル id（影響分析用） */
export type FileDeps = Map<string, Set<string>>

export interface BuildOptions {
  externals?: boolean
}

const IGNORE_DIRS = new Set([
  'node_modules', 'dist', 'build', 'out', 'coverage', '.git', '.nuxt', '.output',
  '.vite', '.vercel', '.wrangler', '.turbo', 'test', 'tests', '__tests__', 'e2e', 'cypress', 'playwright',
])
const SOURCE_RE = /\.(vue|[cm]?[jt]sx?)$/
const SKIP_FILE_RE = /\.d\.ts$|\.(test|spec|stories|story)\.[^.]+$|(^|[\\/])[\w.-]+\.config\.[^.]+$/

export function scanFiles(root: string): string[] {
  const out: string[] = []
  const visit = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (!IGNORE_DIRS.has(ent.name) && !ent.name.startsWith('.')) visit(p)
      } else if (SOURCE_RE.test(ent.name) && !SKIP_FILE_RE.test(ent.name)) {
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

  for (const file of scanFiles(root)) {
    const info = parseFile(file)
    infos.set(file, info)
    for (const e of info.errors) warnings.push(`${rel(file)}: ${e.split('\n')[0]}`)
  }

  const barrel = createBarrelResolver(infos, resolveImport)

  /** import のソースと名前から .vue ファイル（または外部パッケージ名）を求める */
  const targetOf = (source: string, imported: string, importer: string, async: boolean): Target | null => {
    if (source.includes('?')) return null // ?raw / ?url などはコンポーネントとしての依存ではない
    const file = resolveImport(source, importer)
    if (!file) return /^[@\w]/.test(source) && !source.startsWith('@/') ? { external: source, async } : null
    if (file.endsWith('.vue')) return { file, async }
    const vue = barrel(file, imported)
    return vue ? { file: vue, async } : null
  }

  // app.component() によるグローバル登録
  const globals = new Map<string, Target>()
  for (const info of infos.values()) {
    for (const g of info.globals) {
      const t = g.source
        ? targetOf(g.source, 'default', info.file, true)
        : bindingTarget(info, g.local!, targetOf)
      if (t?.file) globals.set(toPascal(g.name), t)
    }
  }

  const auto = loadAutoImports(root)

  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()
  const srcDir = srcDirOf(root)

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
      name: basename(info.file, '.vue'),
      kind: 'component',
      group: groupOf(relative(srcDir, info.file)),
      entry: isFrameworkEntry(relative(srcDir, info.file)),
      lines: info.lines,
      externals: [],
      routes: [],
      shell: false,
    })
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
      const inline = new Set(info.locals.map(toPascal))

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
        if (key === selfName) return addEdge(from, from, 'template', false)
        if (inline.has(key)) return // 同じファイル内で定義したコンポーネント
        const g = globals.get(key) ?? auto.get(key)
        if (g?.file) return addEdge(from, rel(g.file), 'template', g.async)
        if (!dynamic) externals.add(g?.external ? `${key} (${g.external})` : key)
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
  }

  // .vue を import している JS/TS モジュールだけをノードにする
  for (const e of edges.values()) {
    if (nodes.has(e.from)) continue
    nodes.set(e.from, {
      id: e.from,
      name: e.from.split('/').pop()!,
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
      name: basename(e.to, '.vue'),
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
            id, name: ext, kind: 'external', group: 'external', entry: false, lines: 0, externals: [], routes: [], shell: false,
          })
        }
        addEdge(n.id, id, 'template', false)
      }
    }
  }

  const edgeList = [...edges.values()]
  const incoming = new Set(edgeList.filter((e) => e.from !== e.to).map((e) => e.to))
  const orphans = [...nodes.values()]
    .filter((n) => n.kind === 'component' && !n.entry && !incoming.has(n.id))
    .map((n) => n.id)

  // ルート定義と createApp() のルート
  const routes: RouteInfo[] = []
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
      const chain = [...parentChain]
      for (const ref of r.refs) {
        const t = ref.source
          ? targetOf(ref.source, 'default', info.file, true)
          : bindingTarget(info, ref.local!, targetOf)
        if (t?.file) chain.push(rel(t.file))
      }
      const path = r.dynamic ? (parentPath ? `${parentPath}/${r.path}` : r.path) : joinRoutePath(parentPath, r.path)
      const dynamic = parentDynamic || r.dynamic
      if (chain.length > parentChain.length) routes.push({ path, dynamic, chain, source: rel(info.file) })
      for (const c of r.children) add(c, chain, path, dynamic)
    }
    for (const r of info.routes) add(r, [], '', false)
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

  // 影響分析用：ファイル単位の import 関係（?raw なども含む）
  const deps: FileDeps = new Map()
  for (const info of infos.values()) {
    const targets = new Set<string>()
    const sources = [
      ...info.imports.map((i) => i.source),
      ...info.bareImports.map((b) => b.source),
      ...info.reExports.flatMap((r) => (r.source ? [r.source] : [])),
    ]
    for (const source of sources) {
      const file = resolveImport(source, info.file)
      if (file) targets.add(rel(file))
    }
    deps.set(rel(info.file), targets)
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
  return { graph, deps }
}

function joinRoutePath(parent: string, child: string): string {
  if (child.startsWith('/')) return child
  if (!child) return parent || '/'
  return `${parent.replace(/\/$/, '')}/${child}`
}

/** Nuxt のファイルベースルーティング（pages/）と、全ページ共通の app.vue / layouts/default.vue */
function nuxtRoutes(root: string, srcDir: string, rel: (f: string) => string) {
  const isNuxt = ['ts', 'js', 'mjs', 'mts'].some((ext) => existsSync(join(root, `nuxt.config.${ext}`)))
  if (!isNuxt) return null
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
    const chain: string[] = []
    for (let i = 1; i < segs.length; i++) {
      const parent = join(pagesDir, ...segs.slice(0, i)) + '.vue'
      if (existsSync(parent)) chain.push(rel(parent))
    }
    chain.push(rel(file))
    routes.push({ path: '/' + parts.join('/'), dynamic: false, chain, source: rel(pagesDir) })
  }
  return { routes, shell }
}

function bindingTarget(
  info: FileInfo,
  local: string,
  targetOf: (source: string, imported: string, importer: string, async: boolean) => Target | null,
): Target | null {
  const imp = info.imports.find((i) => i.local === local)
  return imp ? targetOf(imp.source, imp.imported, info.file, imp.async) : null
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
        const imp = info.imports.find((i) => i.local === r.local)
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
      const hit = lookup(target, imported, depth + 1)
      if (hit) return hit
    }
    return null
  }
  return (file: string, name: string) => (name === '*' ? null : lookup(file, name, 0))
}

/** unplugin-vue-components / Nuxt が生成する components.d.ts を読む */
function loadAutoImports(root: string): Map<string, Target> {
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
        map.set(key, { file: resolve(dirname(file), spec), async })
      } else {
        const pkg = spec.replace(/^(\.\.?\/)*node_modules\//, '').match(/^(@[^/]+\/)?[^/]+/)?.[0] ?? spec
        map.set(key, { external: pkg, async })
      }
    }
  }
  return map
}

function groupOf(pathFromSrc: string): string {
  const parts = pathFromSrc.split(sep)
  return parts.length > 1 && parts[0] !== '..' ? parts[0] : '(root)'
}

/** Nuxt など、フレームワークが直接描画するファイル */
function isFrameworkEntry(pathFromSrc: string): boolean {
  const p = pathFromSrc.split(sep).join('/')
  return /^(pages|layouts)\//.test(p) || /^(app|App|error)\.vue$/.test(p)
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
  const byName = graph.nodes.filter((n) => toPascal(n.name) === toPascal(q))
  if (byName.length) return byName
  return graph.nodes.filter((n) => n.id.endsWith('/' + q) || n.id.endsWith('/' + q + '.vue'))
}
