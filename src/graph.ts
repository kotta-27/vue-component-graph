import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { HTML_TAGS, parseFile, STYLE_RE, type FileInfo, type RawRoute } from './parse'
import { t } from './i18n'
import { createResolver, srcDirOf, type Resolver } from './resolve'

export type EdgeType = 'template' | 'script'

export interface GraphNode {
  id: string
  /** コンポーネント名（Foo/index.vue → Foo、自動 import ならディレクトリ名付き）。モジュールはパス */
  name: string
  /** 表示名。name が他と重なるときは、区別できるまで親ディレクトリを付ける */
  label: string
  /** app.component('XButton', Button) のようにグローバル登録された名前 */
  registeredAs?: string[]
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
  /** 同じ画面を表示する別の URL（`alias`） */
  aliases?: string[]
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
  /** 解決できなかった、プロジェクト内を指すはずの import（alias を読めていないなど） */
  unresolvedImports: { from: string; spec: string }[]
  /** モノレポのルートで実行したときの、.vue を含むパッケージ */
  workspacePackages?: string[]
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
  /** 解決できなかった相対・エイリアスの import が指していたはずのパス（拡張子なし）→ import していたファイル。削除の影響に使う */
  missing: Map<string, Set<string>>
  /** Nuxt Content のディレクトリ（ここのファイルが変わると contentUsers に影響する） */
  contentDirs: string[]
  /** Nuxt Content を描画・取得しているコンポーネント */
  contentUsers: Set<string>
}

export interface BuildOptions {
  externals?: boolean
}

/** どこにあっても読まないディレクトリ */
const IGNORE_DIRS = new Set(['node_modules', '.git', '.nuxt', '.output', '.vite', '.vercel', '.wrangler', '.turbo', '__tests__'])
/** プロジェクト直下にあるときだけ読まないディレクトリ（src/views/test/ などはアプリの一部なので読む） */
const ROOT_IGNORE_DIRS = new Set(['dist', 'build', 'out', 'coverage', 'test', 'tests', 'e2e', 'cypress', 'playwright'])
const SOURCE_RE = /\.(vue|[cm]?[jt]sx?)$/
const SKIP_FILE_RE = /\.d\.ts$|\.(test|spec|stories|story)\.[^.]+$|(^|[\\/])[\w.-]+\.config\.[^.]+$|^(histoire|vitest|jest)\.setup\./

/** markdownDirs の下の .md も読む（VitePress のサイト全体、Nuxt Content の content/） */
export function scanFiles(root: string, { markdownDirs = [] as string[] } = {}): string[] {
  const out: string[] = []
  const inMarkdownDir = (p: string) => markdownDirs.some((d) => p === d || p.startsWith(d + sep))
  const visit = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) {
        // VitePress のテーマ（.vitepress/theme）は読む。キャッシュとビルド結果は除く
        const vitepress = ent.name === '.vitepress'
        const vitepressOutput = basename(dir) === '.vitepress' && (ent.name === 'cache' || ent.name === 'dist')
        const ignored = IGNORE_DIRS.has(ent.name) || (dir === root && ROOT_IGNORE_DIRS.has(ent.name))
        if (!ignored && (!ent.name.startsWith('.') || vitepress) && !vitepressOutput) visit(p)
      } else if (SKIP_FILE_RE.test(ent.name)) {
        continue
      } else if (SOURCE_RE.test(ent.name) || STYLE_RE.test(ent.name) || (ent.name.endsWith('.md') && inMarkdownDir(p))) {
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
  const relCache = new Map<string, string>()
  const rel = (f: string) => {
    let r = relCache.get(f)
    if (r === undefined) relCache.set(f, (r = relative(root, f).split(sep).join('/')))
    return r
  }

  const vitepress = isVitepress(root)
  const srcDir = srcDirOf(root)
  const nuxt = nuxtProjectOf(root, srcDir)
  for (const layer of nuxt?.remoteLayers ?? []) warnings.push(t('remoteLayer', layer))
  const contentDirs = nuxt?.content ? nuxt.roots.map((r) => join(r, 'content')).filter(isDir) : []
  const markdownDirs = [...(vitepress ? [root] : []), ...contentDirs]
  for (const file of scanFiles(root, { markdownDirs })) {
    const info = parseFile(file)
    // Markdown はコンポーネントを使っているページだけを残す
    if (file.endsWith('.md') && !info.imports.length && !info.tags.length) continue
    infos.set(file, info)
    for (const e of info.errors) warnings.push(`${rel(file)}: ${e.split('\n')[0]}`)
  }

  const barrel = createBarrelResolver(infos, resolveImport)

  const auto = loadAutoImports(root, (spec, dts) => warnings.push(t('staleAutoImport', rel(dts), spec)))
  // .nuxt/ は nuxt dev / nuxt prepare で生成されるので、clone 直後や CI には無い
  if (nuxt && !existsSync(join(root, '.nuxt/components.d.ts'))) {
    for (const [key, t] of nuxtComponents(nuxt)) if (!auto.has(key)) auto.set(key, t)
  }
  // unplugin-vue-components を使っているのに components.d.ts が無い（.gitignore されていることが多い）なら、
  // 既定の規則（src/components 以下のファイル名）で名前を推定する
  const usesUnpluginComponents =
    !nuxt && dependsOn(root, 'unplugin-vue-components') && !hasAutoImportDts(root)
  if (usesUnpluginComponents) {
    for (const [key, file] of componentsByFileName(join(srcDir, 'components'))) if (!auto.has(key)) auto.set(key, { file, async: false })
  }
  const layoutsByName = nuxt ? nuxtLayouts(nuxt) : null
  const layoutFileOf = (name: string) => layoutsByName?.get(name.split(/[-_/]/).flatMap(splitByCase).map((x) => x.toLowerCase()).join('-'))
  /** nuxt-og-image のコンポーネント（components/OgImage/Name.vue、Name.takumi.vue など） */
  const ogImageFiles = (name: string) => {
    // 'Docs'、'Docs.takumi'、'OgImageDocs' → components/OgImage/Docs(.takumi).vue か OgImageDocs.vue
    const want = name.split('.')[0].replace(/^OgImage/, '')
    return [...infos.keys()].filter((f) => /[\\/]OgImage[\\/]/.test(f) && basename(f).split('.')[0].replace(/^OgImage/, '') === want)
  }
  const libraries = uiLibraries(root)
  const packages = dependencies(root)
  const projectDirNames = new Set([...infos.keys()].flatMap((f) => relative(root, dirname(f)).split(sep)))

  /** import のソースと名前から .vue ファイル（または外部パッケージ名）を求める */
  const targetOf = (source: string, imported: string, importer: string, async: boolean): Target | null => {
    if (source.includes('?')) return null // ?raw / ?url などはコンポーネントとしての依存ではない
    if (source === '#components') {
      // Nuxt の仮想モジュール。自動 import と同じ名前で引ける
      const t = auto.get(toPascal(imported))
      return t ? { ...t, async: async || t.async } : null
    }
    const file = resolveImport(source, importer)
    if (!file) {
      // 依存関係にあるパッケージだけを外部とみなす。それ以外（読めていない alias など）は解決できない import
      const pkg = packageName(source)
      return pkg && !looksLocal(source) ? { external: pkg, async } : null
    }
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
      // app.component(Foo.name, Foo) は、Foo が defineOptions({ name }) などで宣言した名前
      const name = g.nameFromComponent ? (t?.file && infos.get(t.file)?.declaredName) : g.name
      if (!name) continue
      if (t?.file) globals.set(toPascal(name), t)
      // .vue に解決できなくても、その名前でグローバル登録されていること自体は覚えておく
      else if (!globals.has(toPascal(name))) globals.set(toPascal(name), { external: t?.external ?? 'app.component', async: false })
    }
  }

  /** import.meta.glob や変数入りの import() のパターンに一致するファイル */
  const allFiles = [...infos.keys()]
  const matchGlobs = (patterns: string[], importer: string): string[] => {
    if (!patterns.length) return []
    const toRegex = (pattern: string) => {
      const abs = pattern.startsWith('/') ? join(root, pattern)
        : /^[.]/.test(pattern) ? resolve(dirname(importer), pattern)
        : resolveImport.candidate(pattern, importer) ?? resolve(dirname(importer), pattern)
      return globToRegExp(abs.split(sep).join('/'))
    }
    const include = patterns.filter((g) => !g.startsWith('!')).map(toRegex)
    const exclude = patterns.filter((g) => g.startsWith('!')).map((g) => toRegex(g.slice(1)))
    return allFiles.filter((f) => {
      const p = f.split(sep).join('/')
      return include.some((re) => re.test(p)) && !exclude.some((re) => re.test(p))
    })
  }
  const globFiles = (info: FileInfo) => matchGlobs(info.globs, info.file)

  /** path の部品の定数を、同じファイルか import 元の定数で埋める。埋まらなければ undefined */
  const constantPath = (info: FileInfo, parts: NonNullable<RawRoute['pathParts']>): string | undefined => {
    let out = ''
    for (const part of parts) {
      if ('str' in part) {
        out += part.str
        continue
      }
      if (part.ident in info.constants) {
        out += info.constants[part.ident]
        continue
      }
      const imp = info.imports.find((i) => i.local === part.ident)
      const file = imp && resolveImport(imp.source, info.file)
      const value = file ? infos.get(file)?.constants[imp!.imported] : undefined
      if (value === undefined) return undefined
      out += value
    }
    return out
  }

  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()
  // ページをファイルで決める構成では、pages/ のコンポーネントをパスで呼ぶ（index や [id] だらけになるため）
  const nuxtProject = !!nuxt
  const pagesDir = join(srcDir, 'pages')
  const fileRouting = nuxtProject || ([...infos.values()].every((i) => !i.routes.length) && existsSync(pagesDir))
  // Nuxt のレイヤーは、それぞれの srcDir からの相対パスで名前と pages/・layouts/ を判定する
  const srcDirs = nuxt?.srcDirs ?? [srcDir]
  // アプリの srcDir がプロジェクト直下だとレイヤーも含んでしまうので、いちばん深いものを選ぶ
  const baseOf = (file: string) =>
    srcDirs.filter((d) => file.startsWith(d + sep)).sort((a, b) => b.length - a.length)[0] ?? srcDir
  const nameOf = (file: string) => componentName(relative(baseOf(file), file), fileRouting)
  const entryOf = (file: string) => isFrameworkEntry(relative(baseOf(file), file), { fileRouting, nuxt: nuxtProject })

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
      // Foo/index.vue がコンポーネント名を宣言していれば、それを使う（drawer-pro/index.vue → DrawerPro）
      name: info.declaredName && /(^|[\\/])index\.vue$/.test(info.file) ? info.declaredName : nameOf(info.file),
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
  // グローバル登録の名前でも引けるように
  for (const [key, t] of globals) {
    const n = t.file ? nodes.get(rel(t.file)) : undefined
    if (n && toPascal(n.name) !== key) n.registeredAs = [...(n.registeredAs ?? []), key]
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
        if (info.file.endsWith('.md')) {
          // MDC の ::div は HTML 要素。::tip などは UI ライブラリの Prose コンポーネントのことがある
          const prose = auto.get(`Prose${key}`)
          if (prose?.file) return addEdge(from, rel(prose.file), 'template', false)
          if (HTML_TAGS.has(name.toLowerCase())) return
          if (libraries.some(([pkg]) => pkg.startsWith('@nuxt/ui'))) return void externals.add(`${key} (@nuxt/ui)`)
        }
        // UI ライブラリの接頭辞（QBtn、UButton など）と RouterView は、そのライブラリの部品として扱う
        if (!dynamic) externals.add(libraryOf(key, libraries) ? `${key} (${libraryOf(key, libraries)})` : key)
      }
      for (const tag of info.tags) use(tag, false)
      for (const name of info.dynamicIs) use(name, true)
      // <NuxtLayout name="x"> で明示したレイアウト
      for (const name of info.layoutRefs) {
        const file = layoutsByName && layoutFileOf(name)
        if (file) addEdge(from, rel(file), 'template', false)
      }
      // nuxt-og-image の defineOgImage('Name') → components/OgImage/Name(.renderer).vue
      for (const name of info.ogImages) for (const file of ogImageFiles(name)) addEdge(from, rel(file), 'script', true)

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

  // Nuxt Content：ContentRenderer などで Markdown を描くページ → 各 Markdown（どのページに出るかを辿れるように）
  // （ナビゲーションのためにクエリするだけの app.vue などは、Markdown を描画しないので含めない）
  const contentComponents = [...infos.values()].filter((i) => i.kind === 'component' && !i.file.endsWith('.md'))
  const contentRenderers = contentComponents
    .filter((i) => i.tags.some((tag) => CONTENT_RENDERER_TAGS.has(toPascal(tag))))
    .map((i) => rel(i.file))
  /** Content のデータ（yml / json も）が変わると影響するもの：描画するものと、クエリするもの */
  const contentQueriers = contentComponents.filter((i) => i.calls.some((c) => CONTENT_QUERIES.has(c))).map((i) => rel(i.file))
  if (contentDirs.length) {
    for (const n of nodes.values()) {
      if (!n.id.endsWith('.md')) continue
      for (const r of contentRenderers) addEdge(r, n.id, 'template', true)
    }
  }
  for (const name of nuxt?.configComponents ?? []) for (const file of ogImageFiles(name)) {
    const n = nodes.get(rel(file))
    if (n) n.entry = true
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
  /** component が関数呼び出しで、画面が分からないルート */
  const unknownViewRoutes: string[] = []
  /** 画面ごとの使用回数：default のビューで子を包む親として / 子を持つ親として / 子のない単独のルートとして */
  const parentUses = new Map<string, number>()
  const parentAnyUses = new Map<string, number>()
  const leafUses = new Map<string, number>()
  const count = (m: Map<string, number>, key: string) => m.set(key, (m.get(key) ?? 0) + 1)
  /** default のビューがないルート → そのルートのコンポーネント */
  const namedOnly = new Map<number, string[]>()
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
        // import(`@/pages/${name}.vue`) は一致するファイルすべて（モバイル版とデスクトップ版など）をそのルートの画面にする
        if (ref.glob) {
          const files = matchGlobs([ref.glob], info.file).filter((f) => f.endsWith('.vue'))
          // `${mobile('Lead')}` のように文字列が入っていれば、それを名前に含むファイルに絞る（Lead.vue と MobileLead.vue）
          const hinted = ref.hints?.length ? files.filter((f) => ref.hints!.some((h) => basename(f).includes(h))) : []
          for (const f of hinted.length ? hinted : files) own.push({ id: rel(f), view: ref.view })
          continue
        }
        const t = ref.source
          ? targetOf(ref.source, 'default', info.file, true)
          : bindingTarget(info, ref.local!, targetOf)
        if (t?.file) own.push({ id: rel(t.file), view: ref.view })
      }
      // メニュー用の外部リンク（path: 'https://...'）はページではない
      if (isUrl(r.path)) return
      if (r.unknownView && !own.length) unknownViewRoutes.push(r.path)
      // `${BASE}/x` のように定数でできた path は、定数を埋めて普通の path にする
      const known = r.pathParts && constantPath(info, r.pathParts)
      const own_path = known ?? r.path
      const ownDynamic = known === undefined || known === null ? r.dynamic : false
      const path = ownDynamic ? (parentPath ? `${parentPath}/${own_path}` : own_path) : joinRoutePath(parentPath, own_path)
      const dynamic = parentDynamic || ownDynamic
      const view = (own.find((o) => o.view === 'default') ?? own[0])?.id
      // 子ルートの親として渡すのはメインの画面だけ（名前付きビューは子に引き継がない）
      const layouts = view ? [...parentChain, view] : parentChain
      const children = r.children.filter((c) => !isUrl(c.path))
      // 子が default のビューを埋める親（管理画面の Layout など）。子が名前付きビューだけなら、親自体が画面
      const wraps = children.some((c) => c.refs.some((ref) => ref.view === 'default'))
      if (view && wraps) count(parentUses, view)
      if (view && children.length) count(parentAnyUses, view)
      if (view && !children.length && !r.children.length) count(leafUses, view)
      // ページにしない親：redirect がある、空パスの子がそのページを描く、子が外部リンクだけ
      const notPage = r.redirect || children.some((c) => c.path === '') || (r.children.length > 0 && !children.length)
      if (view && !notPage) {
        // レイアウトだけを描画している可能性があるもの（判定は全ルートを見てから）
        wrappers.push({ index: routes.length, view, leaf: !children.length })
        // default のビューがないルート（header / content / sidebar だけ）の画面は、全ルートを見てから選ぶ
        if (!own.some((o) => o.view === 'default') && own.length > 1) namedOnly.set(routes.length, own.map((o) => o.id))
        routes.push({
          path,
          dynamic,
          view,
          layouts: parentChain,
          chain: [...parentChain, ...own.map((o) => o.id)],
          source: rel(info.file),
          ...(r.aliases.length ? { aliases: r.aliases.map((a) => joinRoutePath(parentPath, a)) } : {}),
        })
      }
      for (const c of children) add(c, layouts, path, dynamic)
    }
    for (const r of info.routes) add(r, [], '', false)
  }
  // レイアウトの画面：default のビューで複数のルートを包むもの（管理画面の Layout）か、
  // 複数のルートの親になり、単独のページとしては一度も使われないもの（名前付きビューだけを並べる設定画面のレイアウトなど）。
  // その親ルート自体と、子のないルートでレイアウトを指定したもの（メニュー項目など）はページに数えない。
  // 1 か所でしか包まない親（一覧の /users に詳細の :id がぶら下がる形）や、単独のページにもなる画面（directus の Collection）は残す
  const uses = (m: Map<string, number>, v: string) => m.get(v) ?? 0
  const isLayout = (v: string) => uses(parentUses, v) > 1 || (uses(parentAnyUses, v) > 1 && !uses(leafUses, v))
  const layoutOnly = new Set(
    wrappers.filter((w) => isLayout(w.view)).map((w) => w.index),
  )
  // 名前付きビューだけのルートは、兄弟と共有していない画面（content など）をメインの画面にする
  const viewCount = new Map<string, number>()
  for (const ids of namedOnly.values()) for (const id of ids) count(viewCount, id)
  for (const [i, ids] of namedOnly) routes[i].view = [...ids].sort((a, b) => uses(viewCount, a) - uses(viewCount, b))[0]
  if (layoutOnly.size) {
    const kept = routes.filter((_, i) => !layoutOnly.has(i))
    routes.length = 0
    routes.push(...kept)
  }
  if (unknownViewRoutes.length) warnings.push(t('unknownViewRoutes', unknownViewRoutes.length, unknownViewRoutes.slice(0, 5)))
  if (nuxt) {
    const pages = nuxtRoutes(nuxt, infos, rel)
    for (const name of pages.missingLayouts) warnings.push(t('missingLayout', name))
    for (const dir of nuxt.customComponentDirs) warnings.push(t('customComponentDir', dir))
    routes.push(...pages.routes)
    for (const id of pages.shell) shellRoots.add(id)
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
  // 全ページ共通は、いちばん大きいアプリ（createApp(App)）の配下だけ。
  // 開発用パネルなど、別の createApp で載せるものは別のアプリとして扱う（どこからも使われていない扱いにはしない）
  const appTrees = [...shellRoots].map((id) => reachFrom([id]))
  const mainApp = appTrees.sort((a, b) => b.size - a.size)[0]
  for (const id of mainApp ?? []) nodes.get(id)!.shell = true
  routes.forEach((r, i) => {
    for (const id of reachFrom(r.chain)) nodes.get(id)!.routes.push(i)
  })

  // 影響分析用：ファイル単位の参照（?raw、CSS、画像なども含む）
  const deps: FileDeps = {
    static: new Map(),
    lazy: new Map(),
    hubs: new Set(),
    sinks: new Set(),
    missing: new Map(),
    contentDirs: contentDirs.map(rel),
    contentUsers: new Set([...contentRenderers, ...contentQueriers]),
  }
  // 自動 import される関数（Nuxt の composables/・utils/・stores/、unplugin-auto-import）→ 定義しているファイル
  const autoFunctions = autoImportedFunctions(root, nuxt, infos, resolveImport)
  const unresolvedImports: Graph['unresolvedImports'] = []
  const unresolvedSeen = new Set<string>()
  for (const info of infos.values()) {
    const statics = new Set<string>()
    const lazies = new Set<string>()
    const add = (set: Set<string>, file: string | null) => file && set.add(rel(file))
    // 解決できなかったプロジェクト内の import は、警告と削除の影響分析のために覚えておく
    const code = (source: string) => {
      const file = resolveImport(source, info.file)
      if (!file) {
        const target = localTarget(source, info.file)
        if (target) {
          const seenKey = `${info.file}\0${source}`
          if (!unresolvedSeen.has(seenKey)) {
            unresolvedSeen.add(seenKey)
            unresolvedImports.push({ from: rel(info.file), spec: source })
          }
          const key = rel(target).replace(/\.(vue|[cm]?[jt]sx?)$/, '')
          if (!deps.missing.has(key)) deps.missing.set(key, new Set())
          deps.missing.get(key)!.add(rel(info.file))
        }
      }
      return file
    }
    for (const i of info.imports) add(i.async ? lazies : statics, code(i.source))
    for (const b of info.bareImports) add(b.async ? lazies : statics, code(b.source))
    for (const r of info.reExports) if (r.source) add(statics, code(r.source))
    for (const a of info.assets) add(statics, resolveAsset(a, info.file))
    for (const f of globFiles(info)) add(lazies, f)
    // import 文なしで呼んでいる自動 import の関数
    const declared = new Set([...info.locals, ...info.imports.map((i) => i.local)])
    for (const name of new Set(info.calls)) {
      const file = !declared.has(name) && autoFunctions.get(name)
      if (file && file !== info.file) add(statics, file)
    }
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
    warnings: [...new Set(warnings)],
    unresolvedImports,
  }
  const workspace = workspacePackages(root, [...infos.keys()])
  if (workspace) graph.workspacePackages = workspace
  // プロジェクト内の .vue と同じ名前なのに解決できなかったタグ（自動 import の components.d.ts が無いなど）
  const localNames = componentsByFileName(srcDir)
  const unresolvedLocal = [
    ...new Set(graph.nodes.flatMap((n) => n.externals.filter((x) => !x.endsWith(')') && localNames.has(x)))),
  ]
  if (unresolvedLocal.length) graph.warnings.push(t('unresolvedLocalTags', unresolvedLocal.length, unresolvedLocal.slice(0, 5)))
  if (vitepress) graph.vitepress = true
  else if (!routes.length && fileRouting && !nuxtProject) graph.unsupportedPagesDir = rel(pagesDir)
  return { graph, deps }

  /**
   * プロジェクト内を指すはずの import が指すパス（ファイルが無くても求める）。
   * 依存関係にないパッケージ名で始まる import（読めていない alias の可能性）は root の下の同名パスとみなす
   */
  function localTarget(source: string, importer: string): string | null {
    const spec = source.split('?')[0]
    const candidate = resolveImport.candidate(spec, importer)
    if (candidate) return candidate
    return looksLocal(spec) ? join(root, spec) : null
  }

  /**
   * パッケージ名の形をしているが、プロジェクト内のファイルを指していそうな import（読めていない alias）。
   * 拡張子付きか、先頭がプロジェクト内のディレクトリ名で、依存関係にも node_modules にもないもの
   */
  function looksLocal(spec: string): boolean {
    const pkg = packageName(spec)
    if (!pkg || packages.has(pkg) || KNOWN_PACKAGES.test(pkg) || BUILTIN_MODULES.has(pkg.replace(/^node:/, ''))) return false
    if (/^(virtual:|#|~)/.test(spec) || existsSync(join(root, 'node_modules', pkg))) return false
    return /\.(vue|[cm]?[jt]sx?)$/.test(spec) || projectDirNames.has(pkg)
  }

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
    // Sass: @use 'tooltip' → ./_tooltip.scss、@use '@/styles/mixins' → mixins/_index.scss
    const base = /^[.@~]/.test(spec) ? spec : `./${spec}`
    const dir = dirname(base)
    const name = basename(base)
    const candidates = [name, `_${name}`].flatMap((n) =>
      ['', '.scss', '.sass', '.less', '.styl', '.css'].map((ext) => `${dir}/${n}${ext}`),
    )
    candidates.push(...['_index', 'index'].flatMap((n) => ['.scss', '.sass'].map((ext) => `${base}/${n}${ext}`)))
    for (const candidate of candidates) {
      const p = resolveImport(candidate, importer)
      if (p && isFile(p)) return p
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

/**
 * モノレポのルート（pnpm-workspace.yaml、package.json の workspaces、lerna.json）なら、
 * .vue を含むパッケージのディレクトリを返す
 */
function workspacePackages(root: string, files: string[]): string[] | null {
  const pkg = (() => {
    try {
      return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    } catch {
      return {}
    }
  })()
  const isWorkspace = existsSync(join(root, 'pnpm-workspace.yaml')) || existsSync(join(root, 'lerna.json')) || !!pkg.workspaces
  // workspaces の設定が無くても、ルート自体が Vue に依存せず .vue が下の package.json の中だけにあれば同じこと
  const deps = { ...pkg.dependencies, ...pkg.devDependencies }
  if (!isWorkspace && ('vue' in deps || 'nuxt' in deps || 'vitepress' in deps)) return null
  const packages = new Set<string>()
  for (const file of files) {
    if (!file.endsWith('.vue')) continue
    let owner = root
    for (let d = dirname(file); d !== root && d.startsWith(root); d = dirname(d)) {
      if (existsSync(join(d, 'package.json'))) {
        owner = d
        break
      }
    }
    // ルート自体がアプリ（elk や nuxt.com のように docs/ だけが別パッケージ）なら、モノレポのルートとは扱わない
    if (owner === root) return null
    packages.add(relative(root, owner).split(sep).join('/'))
  }
  return packages.size ? [...packages].sort() : null
}

/** `@scope/name/x` → `@scope/name`、`lodash/merge` → `lodash`。相対パスなどは null */
function packageName(spec: string): string | null {
  if (/^[./]/.test(spec)) return null
  const m = spec.match(/^(@[^/]+\/[^/]+|[^/@][^/]*)/)
  return m ? m[1] : null
}

const BUILTIN_MODULES = new Set(builtinModules)
/** package.json に書かれないことが多いパッケージ（Nuxt が持ち込む vue / vue-router など） */
const KNOWN_PACKAGES = /^(vue|vue-router|pinia|nuxt|vite|vitest|@vue\/.*|@nuxt\/.*|@vueuse\/.*|@unhead\/.*|#.*)$/

/** package.json の依存関係（dependencies / devDependencies / peerDependencies）の名前 */
function dependencies(root: string): Set<string> {
  try {
    const json = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    return new Set([json.dependencies, json.devDependencies, json.peerDependencies, json.optionalDependencies].flatMap((d) => Object.keys(d ?? {})))
  } catch {
    return new Set()
  }
}

/** VitePress のサイト（.vitepress がルートか docs/・src/ にある） */
function isVitepress(root: string): boolean {
  return ['', 'docs', 'src'].some((d) => existsSync(join(root, d, '.vitepress')))
}

const isUrl = (path: string) => /^[a-z][\w+.-]*:\/\//i.test(path)

function joinRoutePath(parent: string, child: string): string {
  if (child.startsWith('/')) return child
  if (!child) return parent || '/'
  return `${parent.replace(/\/$/, '')}/${child}`
}

interface NuxtProject {
  /** アプリと、リポジトリ内のレイヤーの srcDir（アプリが先。同じものはアプリが優先） */
  srcDirs: string[]
  /** アプリとレイヤーのルート（content/ や nuxt.config がある場所） */
  roots: string[]
  /** components の pathPrefix: false を設定した場所：srcDir → components/ からの相対パス（'' は components 全体） */
  noPathPrefix: Map<string, Set<string>>
  /** nuxt.config の ogImage.defaults.component など、設定から使われるコンポーネント名 */
  configComponents: string[]
  /** components の設定で、ディレクトリを足している（その部品の名前は推定できない） */
  customComponentDirs: string[]
  /** Nuxt Content を使っている（components/content がグローバルになり、content/ の Markdown から使う） */
  content: boolean
  /** extends に書かれた、リポジトリの外のレイヤー（npm パッケージや github:） */
  remoteLayers: string[]
}

function nuxtProjectOf(root: string, srcDir: string): NuxtProject | null {
  const config = ['ts', 'js', 'mjs', 'mts'].map((ext) => join(root, `nuxt.config.${ext}`)).find((p) => existsSync(p))
  if (!config) return null
  const text = readFileSync(config, 'utf8')
  const layerRoots: string[] = []
  const remoteLayers: string[] = []
  const ext = text.match(/extends\s*:\s*(\[[^\]]*\]|['"`][^'"`]+['"`])/)
  for (const m of ext?.[1].matchAll(/['"`]([^'"`]+)['"`]/g) ?? []) {
    if (/^[./~]/.test(m[1])) layerRoots.push(resolve(root, m[1].replace(/^~~?\//, './')))
    else remoteLayers.push(m[1])
  }
  // Nuxt 3.12 以降は layers/ の下を自動でレイヤーにする
  const autoLayers = join(root, 'layers')
  if (isDir(autoLayers)) {
    for (const ent of readdirSync(autoLayers, { withFileTypes: true })) if (ent.isDirectory()) layerRoots.push(join(autoLayers, ent.name))
  }
  const roots = [...new Set([root, ...layerRoots.filter(isDir)])]
  const srcDirs = [...new Set([srcDir, ...roots.slice(1).map(srcDirOf)])]
  const configText = (r: string) => {
    const file = ['ts', 'js', 'mjs', 'mts'].map((ext) => join(r, `nuxt.config.${ext}`)).find((p) => existsSync(p))
    return file ? readFileSync(file, 'utf8') : ''
  }
  const noPathPrefix = new Map<string, Set<string>>()
  const configComponents: string[] = []
  const customComponentDirs: string[] = []
  roots.forEach((r, i) => {
    const t = configText(r)
    const block = t.match(/\bcomponents\s*:\s*(\[[\s\S]*?\]\s*[,}\n]|\{[\s\S]*?\})/)?.[1] ?? ''
    // { path: '~/components/content', pathPrefix: false } は、そのディレクトリだけ。'~/components' なら全体
    for (const m of block.matchAll(/\{[^{}]*?path\s*:\s*['"`]([^'"`]+)['"`][^{}]*?\}/g)) {
      const sub = m[1].match(/^(?:(?:~|@|~~|@@)\/|\.\/)?(?:app\/)?components\/?(.*)$/)
      if (!sub) {
        customComponentDirs.push(m[1])
        continue
      }
      if (/pathPrefix\s*:\s*false/.test(m[0])) {
        const key = srcDirs[i] ?? srcDirOf(r)
        noPathPrefix.set(key, new Set([...(noPathPrefix.get(key) ?? []), sub[1].replace(/\/$/, '')]))
      }
    }
    for (const m of t.matchAll(/ogImage[\s\S]{0,400}?component\s*:\s*['"`]([\w-]+)['"`]/g)) configComponents.push(m[1])
  })
  const content = /@nuxt\/content/.test(text) || dependsOn(root, '@nuxt/content')
  return { srcDirs, roots, content, remoteLayers, noPathPrefix, configComponents, customComponentDirs }
}

/**
 * Nuxt のレイアウト名とファイル。名前はファイルのパスを kebab-case にしてハイフンでつないだもの
 * （layouts/AuthPage.vue → auth-page、layouts/desktop/default.vue → desktop-default、layouts/foo/index.vue → foo）
 */
function nuxtLayouts(nuxt: NuxtProject): Map<string, string> {
  const map = new Map<string, string>()
  for (const srcDir of nuxt.srcDirs) {
    const dir = join(srcDir, 'layouts')
    if (!isDir(dir)) continue
    const visit = (d: string) => {
      for (const ent of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, ent.name)
        if (ent.isDirectory()) visit(p)
        else if (ent.name.endsWith('.vue')) {
          const segs = relative(dir, p).replace(/\.vue$/, '').split(sep)
          if (segs[segs.length - 1] === 'index' && segs.length > 1) segs.pop()
          const name = segs.flatMap(splitByCase).map((x) => x.toLowerCase()).join('-')
          if (!map.has(name)) map.set(name, p)
        }
      }
    }
    visit(dir)
  }
  return map
}

/** Nuxt のファイルベースルーティング（各レイヤーの pages/）と、definePageMeta で決まるレイアウト */
function nuxtRoutes(nuxt: NuxtProject, infos: Map<string, FileInfo>, rel: (f: string) => string) {
  const firstExisting = (paths: string[]) => paths.find((p) => existsSync(p))
  const app = firstExisting(nuxt.srcDirs.map((d) => join(d, 'app.vue')))
  const shell = app ? [rel(app)] : []
  const layoutsByName = nuxtLayouts(nuxt)
  const missingLayouts = new Set<string>()
  const layoutFile = (name: string) => {
    const key = name.split(/[-_/]/).flatMap(splitByCase).map((x) => x.toLowerCase()).join('-')
    const file = layoutsByName.get(key)
    if (!file && name !== 'default') missingLayouts.add(name)
    return file
  }

  const routes: RouteInfo[] = []
  const seenPaths = new Set<string>()
  for (const srcDir of nuxt.srcDirs) {
    const pagesDir = join(srcDir, 'pages')
    if (!isDir(pagesDir)) continue
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
      const meta = infos.get(file)
      // definePageMeta({ path }) で URL を上書きできる
      const path = meta?.pagePath ?? '/' + parts.join('/')
      // 同じ URL はアプリ（先に見るレイヤー）が優先
      if (seenPaths.has(path)) continue
      seenPaths.add(path)
      // pages/users.vue があれば pages/users/[id].vue の親ルートになる
      const parents: string[] = []
      for (let i = 1; i < segs.length; i++) {
        const parent = join(pagesDir, ...segs.slice(0, i)) + '.vue'
        if (existsSync(parent)) parents.push(parent)
      }
      // レイアウトは、いちばん内側で definePageMeta({ layout }) を書いたページで決まる（無ければ default）
      let layout: string | false = 'default'
      for (const f of [file, ...[...parents].reverse()]) {
        const meta = infos.get(f)?.pageLayout
        if (meta !== undefined) {
          layout = meta
          break
        }
      }
      const layoutPath = layout === false ? undefined : layoutFile(layout)
      const layouts = [...(layoutPath ? [rel(layoutPath)] : []), ...parents.map(rel)]
      const view = rel(file)
      const aliases = meta?.pageAliases.length ? { aliases: meta.pageAliases } : {}
      routes.push({ path, dynamic: false, view, layouts, chain: [...layouts, view], source: rel(pagesDir), ...aliases })
    }
  }
  return { routes, shell, missingLayouts: [...missingLayouts], layoutFile }
}

/** Nuxt Content を描画するタグと、取得する関数 */
const CONTENT_RENDERER_TAGS = new Set(['ContentRenderer', 'ContentDoc', 'ContentList', 'ContentQuery', 'MDC', 'MDCRenderer'])
const CONTENT_QUERIES = new Set(['queryCollection', 'queryContent', 'queryCollectionNavigation', 'fetchContentNavigation', 'useContent'])

const NUXT_BUILTINS = [
  'NuxtLink', 'NuxtPage', 'NuxtLayout', 'NuxtErrorBoundary', 'NuxtLoadingIndicator', 'NuxtRouteAnnouncer',
  'NuxtAnnouncer', 'NuxtClientFallback', 'NuxtIsland', 'NuxtTime', 'NuxtWelcome', 'NuxtImg', 'NuxtPicture',
  'ClientOnly', 'DevOnly', 'ServerPlaceholder',
]
const CONTENT_BUILTINS = ['ContentRenderer', 'ContentDoc', 'ContentList', 'ContentQuery', 'ContentSlot', 'ContentNavigation', 'MDC', 'MDCRenderer', 'MDCSlot']

/**
 * .nuxt/components.d.ts が無いときに、各レイヤーの components/ から Nuxt と同じ規則で名前を組み立てる。
 * components/user/Card.vue → UserCard、components/base/BaseButton.vue → BaseButton（重複は省く）。
 * components/global/ は別のディレクトリとして数え（global/Badge.vue → Badge）、
 * Nuxt Content の components/content/ はディレクトリを名前に含めない（content/prose/ProseA.vue → ProseA）
 */
function nuxtComponents(nuxt: NuxtProject): Map<string, Target> {
  const map = new Map<string, Target>([
    ...NUXT_BUILTINS.map((name): [string, Target] => [name, { external: 'nuxt', async: false }]),
    ...CONTENT_BUILTINS.map((name): [string, Target] => [name, { external: '@nuxt/content', async: false }]),
  ])
  const add = (file: string, name: string) => {
    if (!name || map.has(name)) return
    map.set(name, { file, async: false })
    map.set(`Lazy${name}`, { file, async: true })
  }
  const visit = (dir: string, base: string, pathPrefix: boolean, skip: Set<string>) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name)
      if (ent.isDirectory()) {
        if (!(dir === base && skip.has(ent.name))) visit(p, base, pathPrefix, skip)
      } else if (ent.name.endsWith('.vue')) {
        let fileName = basename(ent.name, '.vue').replace(/(\.(server|client))?(\.global)?$/, '')
        if (fileName.toLowerCase() === 'index') fileName = pathPrefix ? '' : basename(dir)
        const prefix = pathPrefix ? splitByCase(relative(base, dir)) : []
        add(p, nuxtComponentName(splitByCase(fileName), prefix))
      }
    }
  }
  for (const srcDir of nuxt.srcDirs) {
    const base = join(srcDir, 'components')
    if (!isDir(base)) continue
    const custom = nuxt.noPathPrefix.get(srcDir) ?? new Set<string>()
    const prefix = !custom.has('')
    // global/ と content/ と、設定で pathPrefix: false にしたディレクトリは、それぞれを起点に名前を付ける
    const special = new Map<string, boolean>([['global', prefix]])
    if (nuxt.content) special.set('content', false)
    for (const sub of custom) if (sub) special.set(sub, false)
    for (const [dir, pathPrefix] of special) if (isDir(join(base, dir))) visit(join(base, dir), join(base, dir), pathPrefix, new Set())
    visit(base, base, prefix, new Set([...special.keys()].map((d) => d.split('/')[0])))
  }
  return map
}

/**
 * import 文なしで使える関数と、その定義ファイル。
 * Nuxt：各レイヤーの composables/・utils/ の直下（と index）、@pinia/nuxt があれば stores/。.nuxt/imports.d.ts があればそれも。
 * unplugin-auto-import：auto-imports.d.ts の `const useFoo: typeof import('./src/composables/foo')['useFoo']`
 */
function autoImportedFunctions(
  root: string,
  nuxt: NuxtProject | null,
  infos: Map<string, FileInfo>,
  resolveImport: Resolver,
): Map<string, string> {
  const map = new Map<string, string>()
  const exportsOf = (file: string) => {
    const info = infos.get(file)
    if (!info) return []
    const names = info.reExports.map((r) => r.exported).filter((n) => n !== 'default' && n !== '*')
    // export default function () {} は、ファイル名（camelCase）で呼べる
    if (info.reExports.some((r) => r.exported === 'default') || /export\s+default/.test(readFileSync(file, 'utf8'))) {
      names.push(basename(file).replace(/\.[^.]+$/, '').replace(/[-_](\w)/g, (_, c: string) => c.toUpperCase()))
    }
    return names
  }
  if (nuxt) {
    const dirs = ['composables', 'utils', ...(dependsOn(root, '@pinia/nuxt') ? ['stores'] : [])]
    for (const srcDir of nuxt.srcDirs) {
      for (const d of dirs) {
        const dir = join(srcDir, d)
        if (!isDir(dir)) continue
        for (const ent of readdirSync(dir, { withFileTypes: true })) {
          const file = ent.isDirectory() ? [...infos.keys()].find((f) => dirname(f) === join(dir, ent.name) && /^index\./.test(basename(f))) : join(dir, ent.name)
          if (file && infos.has(file)) for (const name of exportsOf(file)) if (!map.has(name)) map.set(name, file)
        }
      }
    }
  }
  const dtsFiles = ['auto-imports.d.ts', 'src/auto-imports.d.ts', 'types/auto-imports.d.ts', '.nuxt/imports.d.ts'].map((p) => join(root, p))
  for (const dts of dtsFiles) {
    if (!existsSync(dts)) continue
    const text = readFileSync(dts, 'utf8')
    const add = (name: string, spec: string) => {
      if (!spec.startsWith('.') || map.has(name)) return
      const file = resolveImport(spec, dts)
      if (file && infos.has(file)) map.set(name, file)
    }
    for (const m of text.matchAll(/const\s+(\w+)\s*:\s*typeof import\(\s*['"]([^'"]+)['"]\s*\)/g)) add(m[1], m[2])
    for (const m of text.matchAll(/export\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()!.trim()
        if (name) add(name, m[2])
      }
    }
  }
  return map
}

/** components.d.ts（unplugin-vue-components / Nuxt）があるか */
function hasAutoImportDts(root: string): boolean {
  return ['components.d.ts', 'src/components.d.ts', 'types/components.d.ts', 'src/types/components.d.ts'].some((p) => existsSync(join(root, p)))
}

/** unplugin-vue-components の既定：dir 以下の .vue をファイル名（パスカルケース）で呼ぶ。名前が重なるものは除く */
function componentsByFileName(dir: string): Map<string, string> {
  const found = new Map<string, string[]>()
  if (!isDir(dir)) return new Map()
  const visit = (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, ent.name)
      if (ent.isDirectory()) visit(p)
      else if (ent.name.endsWith('.vue')) {
        const key = toPascal(basename(ent.name, '.vue') === 'index' ? basename(d) : basename(ent.name, '.vue'))
        found.set(key, [...(found.get(key) ?? []), p])
      }
    }
  }
  visit(dir)
  return new Map([...found].filter(([, files]) => files.length === 1).map(([k, files]) => [k, files[0]]))
}

/** UI ライブラリと、その部品の接頭辞（プラグインでまとめて登録されるので import 文がない） */
const UI_LIBRARIES: [string, RegExp][] = [
  ['quasar', /^Q[A-Z]/],
  ['@nuxt/ui', /^U[A-Z]/],
  ['@nuxt/ui-pro', /^U[A-Z]/],
  ['vuetify', /^V[A-Z]/],
  ['element-plus', /^El[A-Z]/],
  ['element-ui', /^El[A-Z]/],
  ['naive-ui', /^N[A-Z]/],
  ['ant-design-vue', /^A[A-Z]/],
  ['@arco-design/web-vue', /^A[A-Z]/],
  ['@ionic/vue', /^Ion[A-Z]/],
  ['vant', /^Van[A-Z]/],
  ['vue-i18n', /^I18n[TDN]$/],
  ['@nuxtjs/i18n', /^(I18n[TDN]|NuxtLinkLocale|SwitchLocalePathLink)$/],
]

function uiLibraries(root: string): [string, RegExp][] {
  return UI_LIBRARIES.filter(([pkg]) => dependsOn(root, pkg))
}

function libraryOf(name: string, libraries: [string, RegExp][]): string | null {
  const bare = name.replace(/^Lazy(?=[A-Z])/, '')
  if (bare === 'RouterView' || bare === 'RouterLink') return 'vue-router'
  return libraries.find(([, re]) => re.test(bare))?.[0] ?? null
}

function dependsOn(root: string, pkg: string): boolean {
  try {
    const json = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    return [json.dependencies, json.devDependencies, json.peerDependencies].some((deps) => deps && pkg in deps)
  } catch {
    return false
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
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
function isFrameworkEntry(pathFromSrc: string, { fileRouting, nuxt }: { fileRouting: boolean; nuxt: boolean }): boolean {
  const p = pathFromSrc.split(sep).join('/')
  if (/^(app|App)\.vue$/.test(p)) return true
  // 解析対象にした Markdown（VitePress・Nuxt Content のページ）
  if (p.endsWith('.md')) return true
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
  // 絶対パス・./ 付き・拡張子なしのパスも受け付ける
  let q = query.replace(/\\/g, '/')
  const root = graph.root.split(sep).join('/')
  if (q.startsWith(root + '/')) q = q.slice(root.length + 1)
  q = q.replace(/^\.\//, '')
  const exact = graph.nodes.filter((n) => n.id === q || n.id === `${q}.vue` || n.id === `${q}/index.vue`)
  if (exact.length) return exact
  // Nuxt の <LazyFoo> と書いたままの名前
  if (/^Lazy[A-Z]/.test(q)) {
    const lazy = findNodes(graph, q.slice(4))
    if (lazy.length) return lazy
  }
  // 大文字小文字は区別しない（tableaction でも TableAction）
  const key = (s: string) => toPascal(s).toLowerCase()
  const byName = graph.nodes.filter((n) => key(n.name) === key(q) || n.registeredAs?.some((r) => key(r) === key(q)))
  if (byName.length) return byName
  const byLabel = graph.nodes.filter((n) => n.label === q)
  if (byLabel.length) return byLabel
  return graph.nodes.filter(
    (n) => n.id.endsWith('/' + q) || n.id.endsWith('/' + q + '.vue') || n.id.endsWith('/' + q + '/index.vue'),
  )
}
