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
}

export interface FileInfo {
  file: string
  kind: 'component' | 'module'
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
    lines: source.split('\n').length,
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
    errors: [],
  }

  if (info.kind === 'component') {
    const { descriptor, errors } = parseSfc(source, { filename: file })
    for (const e of errors) info.errors.push(e.message)
    for (const block of [descriptor.script, descriptor.scriptSetup]) {
      if (block) parseScript(block.content, block.lang ?? 'js', info)
    }
    if (descriptor.template?.ast) walkTemplate(descriptor.template.ast, info)
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
      for (const d of decl.declarations) if (d.id.type === 'Identifier') info.locals.push(d.id.name)
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
    } else if (stmt.type === 'ExportAllDeclaration' && stmt.exportKind !== 'type') {
      info.reExports.push({ exported: '*', imported: '*', source: stmt.source.value })
    }
  }

  const bound = new Set<any>()
  walk(ast.program, (node) => {
    // const Foo = defineAsyncComponent(() => import('./Foo.vue'))
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init) {
      const found = collectDynamicImports(node.init)
      if (found.length === 1) {
        bound.add(found[0].node)
        info.imports.push({ local: node.id.name, source: found[0].source, imported: 'default', async: true })
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
        if (p.value.type === 'Identifier') {
          info.registered.push({ name, local: p.value.name })
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
      node.arguments[0].type === 'StringLiteral'
    ) {
      const name = node.arguments[0].value
      const arg = node.arguments[1]
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
    // createApp(App)
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      /^create(SSR)?App$/.test(node.callee.name) &&
      node.arguments[0]?.type === 'Identifier'
    ) {
      info.appRoots.push(node.arguments[0].name)
    }
    const dyn = dynamicImportSource(node)
    if (dyn && !bound.has(node)) info.bareImports.push({ source: dyn, async: true })
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
  if (!props.has('path') || !['component', 'components', 'children'].some((k) => props.has(k))) return null

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
  const pushRef = (v: any, view: string) => {
    if (v.type === 'Identifier') return refs.push({ local: v.name, view })
    const found = collectDynamicImports(v)
    if (found.length === 1) refs.push({ source: found[0].source, view })
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
  return { path, dynamic, refs, children, redirect: props.has('redirect') }
}

function propKey(p: any): string | null {
  if (p.type !== 'ObjectProperty' && p.type !== 'Property') return null
  if (p.key.type === 'Identifier' && !p.computed) return p.key.name
  if (p.key.type === 'StringLiteral') return p.key.value
  return null
}

function dynamicImportSource(node: any): string | null {
  let arg
  if (node.type === 'CallExpression' && node.callee.type === 'Import') arg = node.arguments[0]
  else if (node.type === 'ImportExpression') arg = node.source
  else return null
  if (arg?.type === 'StringLiteral') return arg.value
  if (arg?.type === 'TemplateLiteral' && arg.expressions.length === 0) return arg.quasis[0].value.cooked
  return null
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
        const exp: string = p.exp.content
        for (const m of exp.matchAll(/(['"`])([\w-]+)\1|[A-Za-z_$][\w$]*/g)) info.dynamicIs.push(m[2] ?? m[0])
        isTarget = true
      }
    }
    const builtin = BUILTIN_TAGS.has(node.tag.replace(/-/g, '').toLowerCase())
    if (!isTarget && !builtin && node.tagType === TAG_COMPONENT) info.tags.push(node.tag)
  }
  for (const c of node.children ?? []) walkTemplate(c, info)
}
