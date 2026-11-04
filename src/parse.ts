import { readFileSync } from 'node:fs'
import { babelParse, parse as parseSfc } from '@vue/compiler-sfc'

type ParserPlugins = NonNullable<NonNullable<Parameters<typeof babelParse>[1]>['plugins']>

export interface ImportBinding {
  local: string
  source: string
  /** 'default' | '*' | 名前付きエクスポート名 */
  imported: string
  async: boolean
}

export interface Registration {
  name: string
  /** `app.component(Foo.name, Foo)`：名前はコンポーネントが宣言した name（graph で埋める） */
  nameFromComponent?: boolean
  /** ローカル変数経由で登録された場合 */
  local?: string
  /** `defineAsyncComponent(() => import('...'))` を直接登録した場合 */
  source?: string
}

export interface ReExport {
  exported: string
  imported: string
  source?: string
  local?: string
}

export interface RouteRef {
  local?: string
  source?: string
  /** `() => import(\`./pages/${name}.vue\`)` のような、変数入りの import のパターン */
  glob?: string
  /** 式の中の文字列（`${mobile('Lead')}` の 'Lead'）。一致するファイルに絞る手がかり */
  hints?: string[]
  /** 名前付きビューの名前。`component:` は 'default' */
  view: string
}

export interface RawRoute {
  path: string
  /** path が文字列リテラルでない（`c.path` など） */
  dynamic: boolean
  refs: RouteRef[]
  children: RawRoute[]
  /** `redirect` があり、それ自体は描画しない */
  redirect: boolean
  /** `alias: '/x'` / `alias: ['/x', '/y']` */
  aliases: string[]
  /** component が関数呼び出し（`createListView('top')` など）で、画面を特定できない */
  unknownView?: boolean
  /** path が式のとき、文字列と定数名の連結として読めたもの（`${BASE}/x` など。graph で定数を埋める） */
  pathParts?: ({ str: string } | { ident: string })[]
}

export interface FileInfo {
  file: string
  /** style は CSS などで、影響分析の依存（@import）だけを持つ */
  kind: 'component' | 'module' | 'style'
  lines: number
  imports: ImportBinding[]
  /** 変数に束縛されない import（`import './x'`、ルート定義の `() => import()` など） */
  bareImports: { source: string; async: boolean }[]
  /** Options API の `components: { ... }` */
  registered: Registration[]
  /** `app.component('Name', Comp)` */
  globals: Registration[]
  reExports: ReExport[]
  /** ルート定義（`{ path, component, children }`） */
  routes: RawRoute[]
  /** `createApp(App)` に渡されたローカル変数 */
  appRoots: string[]
  /** トップレベルで宣言された変数・関数名（SFC 内で定義したコンポーネントの判定用） */
  locals: string[]
  /** template で使われたコンポーネントのタグ名 */
  tags: string[]
  /** `<component :is="...">` に現れた識別子と文字列 */
  dynamicIs: string[]
  /** `import.meta.glob()` のパターン */
  globs: string[]
  /** `createRouter()` / `new VueRouter()` を呼んでいる */
  createsRouter: boolean
  /** トップレベルの別名（`const Perms = withInstall(perms)` → Perms: perms） */
  aliases: Record<string, string>
  /** Nuxt のページの `definePageMeta({ layout })`。false はレイアウトなし */
  pageLayout?: string | false
  /** `definePageMeta({ path, alias })` で上書きした URL */
  pagePath?: string
  pageAliases: string[]
  /** `<NuxtLayout name="x">` のレイアウト名 */
  layoutRefs: string[]
  /** nuxt-og-image の `defineOgImage('Name')` / `defineOgImageComponent('Name')` */
  ogImages: string[]
  /** トップレベルの文字列定数（ルートの path を埋めるため） */
  constants: Record<string, string>
  /** script で呼んでいる関数名（自動 import の composable を辿るため） */
  calls: string[]
  /** `defineOptions({ name })` や `export default { name }` で宣言した名前 */
  declaredName?: string
  /** template の src / href、CSS の @import / url() など、コード以外の参照（影響分析用） */
  assets: string[]
  errors: string[]
}

const BUILTIN_TAGS = new Set([
  'component', 'slot', 'template',
  'keepalive', 'transition', 'transitiongroup', 'teleport', 'suspense',
])

export function parseFile(file: string): FileInfo {
  const source = readFileSync(file, 'utf8')
  const info: FileInfo = {
    file,
    kind: file.endsWith('.vue') ? 'component' : 'module',
    lines: source.split('\n').length - (source.endsWith('\n') ? 1 : 0),
    imports: [],
    bareImports: [],
    registered: [],
    globals: [],
    reExports: [],
    locals: [],
    routes: [],
    appRoots: [],
    tags: [],
    dynamicIs: [],
    globs: [],
    createsRouter: false,
    aliases: {},
    pageAliases: [],
    layoutRefs: [],
    ogImages: [],
    constants: {},
    calls: [],
    assets: [],
    errors: [],
  }

  if (STYLE_RE.test(file)) {
    info.kind = 'style'
    info.assets.push(...styleRefs(source))
  } else if (file.endsWith('.md')) {
    parseMarkdown(source, info)
  } else if (info.kind === 'component') {
    const { descriptor, errors } = parseSfc(source, { filename: file })
    for (const e of errors) info.errors.push(e.message)
    for (const block of [descriptor.script, descriptor.scriptSetup]) {
      if (block) parseScript(block.content, block.lang ?? 'js', info)
    }
    if (descriptor.template?.ast) walkTemplate(descriptor.template.ast, info)
    for (const style of descriptor.styles) {
      if (style.src) info.assets.push(style.src)
      info.assets.push(...styleRefs(style.content))
    }
  } else {
    const lang = file.match(/\.(\w+)$/)?.[1] ?? 'js'
    parseScript(source, lang, info)
  }
  return info
}

function parseScript(code: string, lang: string, info: FileInfo) {
  const plugins: ParserPlugins = []
  if (/^m?tsx?$/.test(lang)) plugins.push('typescript')
  if (/x$/.test(lang) || /^m?js$/.test(lang)) plugins.push('jsx')
  let ast
  try {
    ast = babelParse(code, { sourceType: 'module', plugins, errorRecovery: true })
  } catch (e) {
    info.errors.push((e as Error).message)
    return
  }

  for (const stmt of ast.program.body) {
    const decl = stmt.type === 'ExportNamedDeclaration' && stmt.declaration ? stmt.declaration : stmt
    if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id.type !== 'Identifier') continue
        info.locals.push(d.id.name)
        const target = d.init && wrappedLocal(d.init)
        if (target && target !== d.id.name) info.aliases[d.id.name] = target
        const str = d.init && stringValue(d.init, info.constants)
        if (str !== null && str !== undefined) info.constants[d.id.name] = str
      }
    } else if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id) {
      info.locals.push(decl.id.name)
    }
    if (stmt.type === 'ImportDeclaration') {
      if (stmt.importKind === 'type') continue
      const source = stmt.source.value
      const specs = stmt.specifiers.filter((s) => s.type !== 'ImportSpecifier' || s.importKind !== 'type')
      if (!stmt.specifiers.length) info.bareImports.push({ source, async: false })
      for (const s of specs) {
        const imported =
          s.type === 'ImportDefaultSpecifier' ? 'default'
          : s.type === 'ImportNamespaceSpecifier' ? '*'
          : s.imported.type === 'Identifier' ? s.imported.name : s.imported.value
        info.imports.push({ local: s.local.name, source, imported, async: false })
      }
    } else if (stmt.type === 'ExportNamedDeclaration' && stmt.exportKind !== 'type') {
      for (const s of stmt.specifiers) {
        if (s.type !== 'ExportSpecifier') continue
        const exported = s.exported.type === 'Identifier' ? s.exported.name : s.exported.value
        if (stmt.source) info.reExports.push({ exported, imported: s.local.name, source: stmt.source.value })
        else info.reExports.push({ exported, imported: s.local.name, local: s.local.name })
      }
      // export function useFoo() {}
      if (stmt.declaration?.type === 'FunctionDeclaration' && stmt.declaration.id) {
        const name = stmt.declaration.id.name
        info.reExports.push({ exported: name, imported: name, local: name })
      }
      // export const Foo = () => import('./Foo.vue') / withInstall(foo) / Bar
      if (stmt.declaration?.type === 'VariableDeclaration') {
        for (const d of stmt.declaration.declarations) {
          if (d.id.type !== 'Identifier' || !d.init) continue
          info.reExports.push({ exported: d.id.name, imported: d.id.name, local: wrappedLocal(d.init) ?? d.id.name })
        }
      }
    } else if (stmt.type === 'ExportDefaultDeclaration') {
      // export default Foo / withInstall(Foo)
      const local = wrappedLocal(stmt.declaration)
      if (local) info.reExports.push({ exported: 'default', imported: local, local })
    } else if (stmt.type === 'ExportAllDeclaration' && stmt.exportKind !== 'type') {
      info.reExports.push({ exported: '*', imported: '*', source: stmt.source.value })
    }
  }

  const bound = new Set<any>()
  walk(ast.program, (node) => {
    // const Foo = defineAsyncComponent(() => import('./Foo.vue')) / () => import('./Foo.vue')
    // （createRouter({ routes }) のように、中に import() があるだけの値はコンポーネントではない）
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
      const found = lazyComponent(node.init)
      if (found) {
        bound.add(found.node)
        info.imports.push({ local: node.id.name, source: found.source, imported: 'default', async: true })
      }
    }
    // components: { Foo, Bar: defineAsyncComponent(...) }
    if (
      info.kind === 'component' &&
      (node.type === 'ObjectProperty' || node.type === 'Property') &&
      propKey(node) === 'components' &&
      node.value.type === 'ObjectExpression'
    ) {
      for (const p of node.value.properties) {
        const name = propKey(p)
        if (!name) continue
        const value = unwrapTs(p.value)
        if (value.type === 'Identifier') {
          info.registered.push({ name, local: value.name })
        } else {
          const found = collectDynamicImports(p.value)
          if (found.length === 1) {
            bound.add(found[0].node)
            info.registered.push({ name, source: found[0].source })
          }
        }
      }
    }
    // app.component('Foo', Foo)
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      node.callee.property.type === 'Identifier' &&
      node.callee.property.name === 'component' &&
      node.arguments.length >= 2 &&
      (node.arguments[0].type === 'StringLiteral' ||
        (unwrapTs(node.arguments[0]).type === 'MemberExpression' && unwrapTs(node.arguments[0]).property.name === 'name'))
    ) {
      // app.component(Foo.name, Foo) は、Foo が宣言した name で登録される
      if (node.arguments[0].type !== 'StringLiteral') {
        const arg = unwrapTs(node.arguments[1])
        if (arg.type === 'Identifier') info.globals.push({ name: '', local: arg.name, nameFromComponent: true })
        return
      }
      const name = node.arguments[0].value
      const arg = unwrapTs(node.arguments[1])
      if (arg.type === 'Identifier') {
        info.globals.push({ name, local: arg.name })
      } else {
        const found = collectDynamicImports(arg)
        if (found.length === 1) {
          bound.add(found[0].node)
          info.globals.push({ name, source: found[0].source })
        }
      }
    }
    if (
      (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'createRouter') ||
      (node.type === 'NewExpression' && node.callee.type === 'Identifier' && /^(Vue)?Router$/.test(node.callee.name))
    ) {
      info.createsRouter = true
    }
    // createApp(App) / createApp({ render: () => h(App) }) / new Vue({ render: h => h(App) })
    const appCall =
      (node.type === 'CallExpression' && node.callee.type === 'Identifier' && /^create(SSR)?App$/.test(node.callee.name)) ||
      (node.type === 'NewExpression' && node.callee.type === 'Identifier' && node.callee.name === 'Vue')
    if (appCall) {
      const arg = unwrapTs(node.arguments[0])
      if (arg?.type === 'Identifier') info.appRoots.push(arg.name)
      else if (arg?.type === 'ObjectExpression') {
        const render = arg.properties.find((p: any) => propKey(p) === 'render' || p.key?.name === 'render')
        const body = render && (render.value ?? render)
        walk(body, (n) => {
          if (n.type === 'CallExpression' && n.arguments[0]?.type === 'Identifier' && /^(h|createElement)$/.test(n.callee.name ?? '')) {
            info.appRoots.push(n.arguments[0].name)
          }
        })
      }
    }
    // defineOptions({ name: 'Foo' }) / defineComponent({ name: 'Foo' }) / export default { name: 'Foo' }
    if (
      (node.type === 'CallExpression' && /^(defineOptions|defineComponent)$/.test(node.callee.name ?? '')) ||
      (node.type === 'ExportDefaultDeclaration' && node.declaration.type === 'ObjectExpression')
    ) {
      const obj = node.type === 'CallExpression' ? node.arguments[0] : node.declaration
      const name = obj?.type === 'ObjectExpression' ? obj.properties.find((p: any) => propKey(p) === 'name')?.value : null
      if (name?.type === 'StringLiteral' && info.kind === 'component') info.declaredName ??= name.value
    }
    // new URL('./img.png', import.meta.url) で参照する画像
    if (
      node.type === 'NewExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'URL' &&
      node.arguments[0]?.type === 'StringLiteral' &&
      node.arguments[1]?.type === 'MemberExpression' &&
      node.arguments[1].object.type === 'MetaProperty'
    ) {
      info.assets.push(node.arguments[0].value)
    }
    // resolveComponent('Foo') はテンプレートでの使用と同じ
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'resolveComponent' &&
      node.arguments[0]?.type === 'StringLiteral'
    ) {
      info.tags.push(node.arguments[0].value)
    }
    // nuxt-og-image
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      /^defineOgImage(Component)?$/.test(node.callee.name)
    ) {
      const arg = node.arguments[0]
      if (arg?.type === 'StringLiteral') info.ogImages.push(arg.value)
      else if (arg?.type === 'ObjectExpression') {
        const c = arg.properties.find((p: any) => propKey(p) === 'component')
        if (c?.value.type === 'StringLiteral') info.ogImages.push(c.value.value)
      }
    }
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier') info.calls.push(node.callee.name)
    // 変数入りの import('./pages/${name}.vue') は glob として扱う
    const pattern = dynamicImportPattern(node)
    if (pattern && !bound.has(node)) info.globs.push(pattern)
    const dyn = dynamicImportSource(node)
    if (dyn && !bound.has(node)) info.bareImports.push({ source: dyn, async: true })
    // webpack の require.context('./components', true, /\.vue$/)
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      node.callee.object.type === 'Identifier' &&
      node.callee.object.name === 'require' &&
      node.callee.property.type === 'Identifier' &&
      node.callee.property.name === 'context' &&
      node.arguments[0]?.type === 'StringLiteral'
    ) {
      const dir = node.arguments[0].value.replace(/\/$/, '')
      const deep = node.arguments[1]?.type === 'BooleanLiteral' ? node.arguments[1].value : true
      const re = node.arguments[2]?.type === 'RegExpLiteral' ? node.arguments[2].pattern : ''
      info.globs.push(`${dir.startsWith('.') ? dir : `./${dir}`}/${deep ? '**/' : ''}*${/vue/.test(re) ? '.vue' : ''}`)
    }
    // Nuxt の definePageMeta({ layout: 'admin' }) / { layout: false }
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'definePageMeta') {
      const arg = node.arguments[0]
      const prop = (o: any, key: string) => (o?.type === 'ObjectExpression' ? o.properties.find((p: any) => propKey(p) === key)?.value : null)
      let layout = prop(arg, 'layout')
      // { layout: { name: 'side', props } }
      if (layout?.type === 'ObjectExpression') layout = prop(layout, 'name')
      if (layout?.type === 'StringLiteral') info.pageLayout = layout.value
      else if (layout?.type === 'BooleanLiteral' && !layout.value) info.pageLayout = false
      const path = prop(arg, 'path')
      if (path?.type === 'StringLiteral') info.pagePath = path.value
      const alias = prop(arg, 'alias')
      for (const a of alias?.type === 'ArrayExpression' ? alias.elements : [alias]) if (a?.type === 'StringLiteral') info.pageAliases.push(a.value)
    }
    // import.meta.glob('./views/**/*.vue') / glob(['a', '!b'])
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'MemberExpression' &&
      node.callee.property.type === 'Identifier' &&
      /^glob(Eager)?$/.test(node.callee.property.name) &&
      node.callee.object.type === 'MetaProperty'
    ) {
      const arg = node.arguments[0]
      const items = arg?.type === 'ArrayExpression' ? arg.elements : [arg]
      for (const el of items) if (el?.type === 'StringLiteral') info.globs.push(el.value)
    }
  })

  findRoutes(ast.program, code, info.routes)
}

function findRoutes(node: any, code: string, out: RawRoute[]) {
  if (!node || typeof node.type !== 'string') return
  if (node.type === 'ObjectExpression') {
    const route = toRoute(node, code)
    if (route) {
      out.push(route)
      return
    }
  }
  for (const key in node) {
    if (SKIP_KEYS.has(key)) continue
    const child = node[key]
    if (Array.isArray(child)) for (const c of child) findRoutes(c, code, out)
    else if (child && typeof child === 'object') findRoutes(child, code, out)
  }
}

function toRoute(obj: any, code: string): RawRoute | null {
  const props = new Map<string, any>()
  for (const p of obj.properties) {
    const k = propKey(p)
    if (k) props.set(k, p.value)
  }
  if (!props.has('path')) return null
  // 外部リンクのメニュー項目（{ path: 'https://...' }）は、ページから外すために拾っておく
  const link = props.get('path').type === 'StringLiteral' && /^[a-z][\w+.-]*:\/\//i.test(props.get('path').value)
  if (!link && !['component', 'components', 'children'].some((k) => props.has(k))) return null

  const pathNode = props.get('path')
  let path: string
  let dynamic = false
  if (pathNode.type === 'StringLiteral') path = pathNode.value
  else if (pathNode.type === 'TemplateLiteral' && pathNode.expressions.length === 0) path = pathNode.quasis[0].value.cooked
  else {
    path = code.slice(pathNode.start, pathNode.end)
    dynamic = true
  }

  const refs: RouteRef[] = []
  let unknownViews = 0
  const pushRef = (v: any, view: string) => {
    if (v.type === 'Identifier') return refs.push({ local: v.name, view })
    const found = collectDynamicImports(v)
    if (found.length === 1) return refs.push({ source: found[0].source, view })
    // () => import(`@/pages/${name}.vue`)
    let glob: string | null = null
    const hints: string[] = []
    walk(v, (n) => {
      const found = dynamicImportPattern(n)
      if (found && !glob) {
        glob = found
        const arg = n.type === 'ImportExpression' ? n.source : n.arguments[0]
        for (const e of arg.expressions) walk(e, (x) => x.type === 'StringLiteral' && hints.push(x.value))
      }
    })
    if (glob) return refs.push({ glob, view, ...(hints.length ? { hints } : {}) })
    // component: createListView('top') のような関数呼び出しは、どの画面か分からない
    if (v.type === 'CallExpression') unknownViews++
  }
  if (props.has('component')) pushRef(props.get('component'), 'default')
  const named = props.get('components')
  if (named?.type === 'ObjectExpression') {
    for (const p of named.properties) {
      const view = propKey(p)
      if (view && p.value) pushRef(p.value, view)
    }
  }

  const children: RawRoute[] = []
  if (props.has('children')) findRoutes(props.get('children'), code, children)
  const aliasNode = props.get('alias')
  const aliases = (aliasNode?.type === 'ArrayExpression' ? aliasNode.elements : [aliasNode])
    .filter((a: any) => a?.type === 'StringLiteral')
    .map((a: any) => a.value)
  const pathParts = dynamic ? concatParts(pathNode) : undefined
  return {
    path,
    dynamic,
    refs,
    children,
    redirect: props.has('redirect'),
    aliases,
    ...(pathParts ? { pathParts } : {}),
    ...(unknownViews ? { unknownView: true } : {}),
  }
}

export const STYLE_RE = /\.(css|scss|sass|less|styl|stylus|pcss|postcss)$/

/** CSS の @import / @use / @forward と url() のうち、ファイルを指すもの */
function styleRefs(css: string): string[] {
  const out: string[] = []
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '')
  for (const m of code.matchAll(/@(?:import|use|forward)\s+(?:url\()?\s*(['"])([^'"]+)\1/g)) out.push(m[2])
  for (const m of code.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)) out.push(m[2])
  return out.filter(isLocalRef)
}

/** http: や data: ではなく、プロジェクト内のファイルを指す参照 */
function isLocalRef(ref: string): boolean {
  return !/^(?:[a-z]+:|\/\/|#|\{\{|\$)/i.test(ref) && ref.trim() !== ''
}

/**
 * VitePress などの Markdown。<script setup> の import と、本文で使われているコンポーネントのタグを拾う
 * （コードブロックとインラインコードの中は除く）
 */
function parseMarkdown(source: string, info: FileInfo) {
  info.kind = 'component'
  // コードブロック内の <script> や <Foo /> はサンプルなので、先に取り除く
  const text = source.replace(/^([ \t]*)(```|~~~)[\s\S]*?^\1\2/gm, '').replace(/`[^`\n]*`/g, '')
  for (const m of text.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    const lang = m[1].match(/lang=["'](\w+)["']/)?.[1] ?? 'js'
    parseScript(m[2], lang, info)
  }
  const body = text.replace(/<script\b[\s\S]*?<\/script>/g, '').replace(/<style\b[\s\S]*?<\/style>/g, '')
  for (const m of body.matchAll(/<([A-Z][\w]*|[a-z][a-z0-9]*(?:-[a-z0-9]+)+)(?=[\s/>])/g)) info.tags.push(m[1])
  // Nuxt Content（MDC）の ::read-more（ブロック）と :badge[...] / :icon{...}（インライン）
  for (const m of body.matchAll(/^\s*::+([a-zA-Z][\w-]*)/gm)) info.tags.push(m[1])
  for (const m of body.matchAll(/(?:^|[\s(]):([a-zA-Z][\w-]*)(?=[[{])/gm)) info.tags.push(m[1])
}

/** `x as Component` / `x satisfies T` / `x!` の中身 */
function unwrapTs(node: any): any {
  while (node && (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression')) {
    node = node.expression
  }
  return node
}

/** 文字列リテラル、または同じファイルの文字列定数だけでできた式の値 */
function stringValue(node: any, constants: Record<string, string>): string | null {
  node = unwrapTs(node)
  if (node?.type === 'StringLiteral') return node.value
  if (node?.type === 'Identifier' && node.name in constants) return constants[node.name]
  if (node?.type === 'TemplateLiteral') {
    let out = node.quasis[0].value.cooked
    for (let i = 0; i < node.expressions.length; i++) {
      const v = stringValue(node.expressions[i], constants)
      if (v === null) return null
      out += v + node.quasis[i + 1].value.cooked
    }
    return out
  }
  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    const a = stringValue(node.left, constants)
    const b = stringValue(node.right, constants)
    return a === null || b === null ? null : a + b
  }
  return null
}

/** `${BASE}/x` や BASE + '/x' を、文字列と識別子の並びにする（識別子は別ファイルの定数でもよい） */
function concatParts(node: any): ({ str: string } | { ident: string })[] | undefined {
  node = unwrapTs(node)
  if (node.type === 'StringLiteral') return [{ str: node.value }]
  if (node.type === 'Identifier') return [{ ident: node.name }]
  if (node.type === 'TemplateLiteral') {
    const out: ({ str: string } | { ident: string })[] = [{ str: node.quasis[0].value.cooked }]
    for (let i = 0; i < node.expressions.length; i++) {
      const e = node.expressions[i]
      if (e.type !== 'Identifier') return undefined
      out.push({ ident: e.name }, { str: node.quasis[i + 1].value.cooked })
    }
    return out
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const a = concatParts(node.left)
    const b = concatParts(node.right)
    return a && b ? [...a, ...b] : undefined
  }
  return undefined
}

/** import(`./pages/${name}.vue`) → './pages/*.vue'。変数を含まない import は null */
function dynamicImportPattern(node: any): string | null {
  const arg = node.type === 'ImportExpression' ? node.source : node.type === 'CallExpression' && node.callee.type === 'Import' ? node.arguments[0] : null
  if (arg?.type !== 'TemplateLiteral' || !arg.expressions.length) return null
  const pattern = arg.quasis.map((q: any) => q.value.cooked).join('*')
  // 先頭が変数（`${dir}/x.vue`）だと範囲が決まらないので扱わない
  return /^[.@~/]/.test(pattern) ? pattern : null
}

/** `Foo` や `withInstall(Foo)` のように、そのまま（または包んで）公開している変数名 */
function wrappedLocal(node: any): string | null {
  if (node.type === 'Identifier') return node.name
  if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression') return wrappedLocal(node.expression)
  if (node.type === 'CallExpression' && node.arguments[0]?.type === 'Identifier') return node.arguments[0].name
  return null
}

function propKey(p: any): string | null {
  if (p.type !== 'ObjectProperty' && p.type !== 'Property') return null
  if (p.key.type === 'Identifier' && !p.computed) return p.key.name
  if (p.key.type === 'StringLiteral') return p.key.value
  return null
}

/** `import('./X.vue')`、および webpack の `require('./X')` / `require(['./X'], resolve)` */
function dynamicImportSource(node: any): string | null {
  let arg
  if (node.type === 'CallExpression' && node.callee.type === 'Import') arg = node.arguments[0]
  else if (node.type === 'ImportExpression') arg = node.source
  else if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require') {
    arg = node.arguments[0]?.type === 'ArrayExpression' && node.arguments[0].elements.length === 1
      ? node.arguments[0].elements[0]
      : node.arguments[0]
  } else return null
  if (arg?.type === 'StringLiteral') return arg.value
  if (arg?.type === 'TemplateLiteral' && arg.expressions.length === 0) return arg.quasis[0].value.cooked
  return null
}

/**
 * 値そのものが遅延読み込みのコンポーネントなら、その import()。
 * `import('./X.vue')`、`() => import(...)`、`import(...).then(m => m.default)`、`defineAsyncComponent(() => import(...))`、
 * `defineAsyncComponent({ loader: () => import(...) })` に対応する
 */
function lazyComponent(node: any): { node: any; source: string } | null {
  if (!node) return null
  const source = dynamicImportSource(node)
  if (source) return { node, source }
  switch (node.type) {
    case 'ArrowFunctionExpression':
    case 'FunctionExpression': {
      const body = node.body.type === 'BlockStatement' ? node.body.body.find((s: any) => s.type === 'ReturnStatement')?.argument : node.body
      const direct = lazyComponent(body)
      if (direct) return direct
      // webpack: r => require.ensure([], () => r(require('./X')), 'chunk') / resolve => require(['./X'], resolve)
      const found = collectDynamicImports(node.body)
      return found.length === 1 ? found[0] : null
    }
    case 'AwaitExpression':
    case 'TSAsExpression':
      return lazyComponent(node.argument ?? node.expression)
    case 'CallExpression': {
      // import('./X.vue').then(...)
      if (node.callee.type === 'MemberExpression') return lazyComponent(node.callee.object)
      if (node.callee.type === 'Identifier' && node.callee.name === 'defineAsyncComponent') {
        const arg = node.arguments[0]
        if (arg?.type === 'ObjectExpression') {
          const loader = arg.properties.find((p: any) => propKey(p) === 'loader')
          return loader ? lazyComponent(loader.value) : null
        }
        return lazyComponent(arg)
      }
      return null
    }
    default:
      return null
  }
}

function collectDynamicImports(root: any) {
  const found: { node: any; source: string }[] = []
  walk(root, (node) => {
    const source = dynamicImportSource(node)
    if (source) found.push({ node, source })
  })
  return found
}

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments'])

function walk(node: any, visit: (node: any) => void) {
  if (!node || typeof node.type !== 'string') return
  visit(node)
  for (const key in node) {
    if (SKIP_KEYS.has(key)) continue
    const child = node[key]
    if (Array.isArray(child)) for (const c of child) walk(c, visit)
    else if (child && typeof child === 'object') walk(child, visit)
  }
}

// compiler-core の NodeTypes / ElementTypes
const ELEMENT = 1
const ATTRIBUTE = 6
const DIRECTIVE = 7
const TAG_COMPONENT = 1

/**
 * `:is` の式が取りうるコンポーネント。`cond ? A : B`、`a || B`、`'name'` は候補にするが、
 * `useIcon(toRaw(x))` のような呼び出しやメンバー参照は実行時に決まるので拾わない
 */
function isCandidates(exp: string): string[] {
  let node: any
  try {
    node = (babelParse(`(${exp})`, { plugins: ['typescript'] }).program.body[0] as any).expression
  } catch {
    return []
  }
  const out: string[] = []
  const visit = (n: any) => {
    if (n.type === 'Identifier') out.push(n.name)
    else if (n.type === 'StringLiteral') out.push(n.value)
    else if (n.type === 'TemplateLiteral' && !n.expressions.length) out.push(n.quasis[0].value.cooked)
    else if (n.type === 'ConditionalExpression') (visit(n.consequent), visit(n.alternate))
    else if (n.type === 'LogicalExpression') (visit(n.left), visit(n.right))
    else if (n.type === 'TSAsExpression' || n.type === 'TSNonNullExpression') visit(n.expression)
  }
  visit(node)
  return out
}

/** MDC で ::div のように書ける HTML 要素。同名の部品が無ければコンポーネントではない */
export const HTML_TAGS = new Set(
  'a abbr address article aside audio b blockquote br button canvas caption code col details dd del dialog div dl dt em embed fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr i iframe img input ins kbd label legend li main mark nav object ol p picture pre q s section select small source span strong sub summary sup table tbody td textarea tfoot th thead time tr u ul video'.split(' '),
)

const ASSET_ATTRS = new Set(['src', 'href', 'poster', 'srcset', 'xlink:href'])

function walkTemplate(node: any, info: FileInfo) {
  if (node.type === ELEMENT) {
    let isTarget = false
    for (const p of node.props) {
      if (p.type === ATTRIBUTE && p.name === 'is' && p.value) {
        // ネイティブ要素の is は "vue:" 付きのときだけコンポーネント扱い
        const value: string = p.value.content
        if (node.tag === 'component' || value.startsWith('vue:')) {
          info.tags.push(value.replace(/^vue:/, ''))
          isTarget = true
        }
      } else if (p.type === DIRECTIVE && p.name === 'bind' && p.arg?.content === 'is' && p.exp) {
        info.dynamicIs.push(...isCandidates(p.exp.content))
        isTarget = true
      }
    }
    for (const p of node.props) {
      if (p.type === ATTRIBUTE && ASSET_ATTRS.has(p.name) && p.value && isLocalRef(p.value.content)) {
        info.assets.push(p.value.content)
      }
    }
    if (/^(NuxtLayout|nuxt-layout)$/.test(node.tag)) {
      const name = node.props.find((p: any) => p.type === ATTRIBUTE && p.name === 'name' && p.value)
      if (name) info.layoutRefs.push(name.value.content)
    }
    const builtin = BUILTIN_TAGS.has(node.tag.replace(/-/g, '').toLowerCase())
    if (!isTarget && !builtin && node.tagType === TAG_COMPONENT) info.tags.push(node.tag)
  }
  for (const c of node.children ?? []) walkTemplate(c, info)
}
