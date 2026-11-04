import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { babelParse } from '@vue/compiler-sfc'

// Vite・webpack と同じくスクリプトを先に試す（Foo/ に index.ts と index.vue があれば index.ts）
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.vue']

interface PathAlias {
  prefix: string
  suffix: string
  wildcard: boolean
  targets: string[]
}

export interface Resolver {
  (spec: string, importer: string): string | null
  /** ファイルが無くても、相対パスやエイリアスが指すはずのパス（削除したファイルを import している側を探すため） */
  candidate(spec: string, importer: string): string | null
}

export function srcDirOf(root: string): string {
  for (const d of ['src', 'app']) {
    const p = join(root, d)
    if (isDir(p)) return p
  }
  return root
}

export function createResolver(root: string): Resolver {
  const aliases = loadAliases(root)
  const cache = new Map<string, string | null>()

  const resolver = ((spec: string, importer: string) => {
    spec = spec.split('?')[0]
    const key = spec.startsWith('.') ? `${dirname(importer)}\0${spec}` : spec
    if (cache.has(key)) return cache.get(key)!
    const result = resolveUncached(spec, importer, aliases) ?? resolveFromProjectDirs(spec, root)
    cache.set(key, result)
    return result
  }) as Resolver
  resolver.candidate = (spec, importer) => {
    spec = spec.split('?')[0]
    if (spec.startsWith('.')) return resolve(dirname(importer), spec)
    for (const a of aliases) {
      if (!spec.startsWith(a.prefix) || !spec.endsWith(a.suffix)) continue
      if (!a.wildcard && spec !== a.prefix) continue
      const star = a.wildcard ? spec.slice(a.prefix.length, spec.length - a.suffix.length) : ''
      if (a.targets[0]) return a.targets[0].replace('*', star)
    }
    return null
  }
  return resolver
}

/**
 * webpack の alias / resolve.modules でよくある、プロジェクト直下か src/ のディレクトリ名で始まる import
 * （`src/components/Foo`、`components/Foo`）。設定は読まないので、実在するファイルに解決できるときだけ使う
 */
function resolveFromProjectDirs(spec: string, root: string): string | null {
  const first = spec.split('/')[0]
  if (!/^[\w-]+$/.test(first) || first === 'node_modules' || !spec.includes('/')) return null
  for (const base of [root, srcDirOf(root)]) {
    if (isDir(join(base, first))) {
      const hit = resolveFile(join(base, spec))
      if (hit) return hit
    }
  }
  return null
}

function resolveUncached(spec: string, importer: string, aliases: PathAlias[]): string | null {
  if (spec.startsWith('.') || spec.startsWith('/')) {
    return resolveFile(resolve(dirname(importer), spec))
  }
  for (const a of aliases) {
    if (!spec.startsWith(a.prefix) || !spec.endsWith(a.suffix)) continue
    if (!a.wildcard && spec !== a.prefix) continue
    const star = a.wildcard ? spec.slice(a.prefix.length, spec.length - a.suffix.length) : ''
    for (const t of a.targets) {
      const hit = resolveFile(t.replace('*', star))
      if (hit) return hit
    }
  }
  return null
}

function resolveFile(base: string): string | null {
  if (isFile(base)) return base
  for (const ext of EXTS) if (isFile(base + ext)) return base + ext
  if (/\.m?js$/.test(base)) {
    const ts = base.replace(/\.(m?)js$/, '.$1ts')
    if (isFile(ts)) return ts
  }
  for (const ext of EXTS) {
    const p = join(base, 'index' + ext)
    if (isFile(p)) return p
  }
  return null
}

function loadAliases(root: string): PathAlias[] {
  const aliases: PathAlias[] = []
  const seen = new Set<string>()
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    collectTsconfigPaths(join(root, name), aliases, seen)
  }
  // vite.config / vue.config / webpack の resolve.alias（tsconfig に無いものだけ足す）
  for (const [key, target] of bundlerAliases(root)) {
    const prefix = key.endsWith('/') ? key : `${key}/`
    if (aliases.some((a) => a.prefix === prefix || a.prefix === key)) continue
    aliases.push({ prefix, suffix: '', wildcard: true, targets: [join(target, '*')] })
    aliases.push({ prefix: key.replace(/\/$/, ''), suffix: '', wildcard: false, targets: [target] })
  }
  // Vite / Nuxt の慣習的エイリアス（tsconfig に無ければ補う）
  const src = srcDirOf(root)
  const fallback: [string, string][] = [
    ['@/', src],
    ['~/', src],
    ['@@/', root],
    ['~~/', root],
  ]
  for (const [prefix, dir] of fallback) {
    if (aliases.some((a) => a.prefix === prefix)) continue
    aliases.push({ prefix, suffix: '', wildcard: true, targets: [join(dir, '*')] })
  }
  return aliases
}

const BUNDLER_CONFIG_RE = /^(vite|vue|webpack|quasar|rsbuild|rspack)([\w.-]*)\.(c|m)?[jt]s$/

/**
 * バンドラーの設定ファイルから、静的に読める alias を取り出す。
 * `alias: { '@': path.resolve(__dirname, 'src') }`、`{ find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) }`、
 * webpack-chain の `.alias.set('@', resolve('src'))` に対応する（関数呼び出しで組み立てたものは読まない）
 */
export function bundlerAliases(root: string): [string, string][] {
  const out: [string, string][] = []
  const files: string[] = []
  for (const dir of [root, join(root, 'config'), join(root, 'build')]) {
    if (!isDir(dir)) continue
    for (const name of readdirSync(dir)) if (BUNDLER_CONFIG_RE.test(name)) files.push(join(dir, name))
  }
  for (const file of files) {
    let ast: any
    try {
      ast = babelParse(readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['typescript'], errorRecovery: true })
    } catch {
      continue
    }
    const dir = dirname(file)
    const pathOf = (node: any): string | null => {
      if (!node) return null
      if (node.type === 'StringLiteral') return /^[./]/.test(node.value) ? resolve(dir, node.value) : null
      if (node.type === 'TemplateLiteral' && !node.expressions.length) return pathOf({ type: 'StringLiteral', value: node.quasis[0].value.cooked })
      if (node.type === 'CallExpression') {
        const callee = node.callee.type === 'MemberExpression' ? node.callee.property.name : node.callee.name
        // fileURLToPath(new URL('./src', import.meta.url))
        if (callee === 'fileURLToPath') return pathOf(node.arguments[0])
        if (callee === 'resolve' || callee === 'join') {
          const parts: string[] = []
          for (const a of node.arguments) {
            if (a.type === 'Identifier' && a.name === '__dirname') parts.push(dir)
            else if (a.type === 'StringLiteral') parts.push(a.value)
            else if (a.type === 'CallExpression' && a.callee.property?.name === 'cwd') parts.push(root)
            else return null
          }
          return parts.length ? resolve(callee === 'resolve' && !parts[0].startsWith('/') ? root : dir, ...parts) : null
        }
      }
      if (node.type === 'NewExpression' && node.callee.name === 'URL') return pathOf(node.arguments[0])
      if (node.type === 'MemberExpression' && node.property.name === 'pathname') return pathOf(node.object)
      return null
    }
    walkAst(ast.program, (node) => {
      const key = node.type === 'ObjectProperty' ? (node.key.name ?? node.key.value) : null
      // alias: { ... } と、別の変数に書いて渡す形（export const aliases = { ... } → alias: aliases）
      const aliasObject =
        (key === 'alias' && node.value.type === 'ObjectExpression' && node.value) ||
        (node.type === 'VariableDeclarator' && /alias/i.test(node.id?.name ?? '') && node.init?.type === 'ObjectExpression' && node.init)
      if (aliasObject) {
        for (const p of aliasObject.properties) {
          const k = p.key?.type === 'Identifier' ? p.key.name : p.key?.type === 'StringLiteral' ? p.key.value : null
          const target = pathOf(p.value)
          if (k && target) out.push([k, target])
        }
      }
      if (key === 'alias' && node.value.type === 'ArrayExpression') {
        for (const el of node.value.elements) {
          if (el?.type !== 'ObjectExpression') continue
          const find = el.properties.find((p: any) => (p.key?.name ?? p.key?.value) === 'find')?.value
          const replacement = el.properties.find((p: any) => (p.key?.name ?? p.key?.value) === 'replacement')?.value
          const target = pathOf(replacement)
          if (find?.type === 'StringLiteral' && target) out.push([find.value, target])
        }
      }
      // config.resolve.alias.set('@', resolve('src'))
      if (
        node.type === 'CallExpression' &&
        node.callee.type === 'MemberExpression' &&
        node.callee.property.name === 'set' &&
        node.arguments[0]?.type === 'StringLiteral' &&
        /alias/.test(JSON.stringify(node.callee.object, ['type', 'name', 'property', 'object']))
      ) {
        const target = pathOf(node.arguments[1])
        if (target) out.push([node.arguments[0].value, target])
      }
    })
  }
  return out
}

function walkAst(node: any, visit: (node: any) => void) {
  if (!node || typeof node.type !== 'string') return
  visit(node)
  for (const key in node) {
    if (key === 'loc' || key === 'start' || key === 'end' || key.endsWith('Comments')) continue
    const child = node[key]
    if (Array.isArray(child)) for (const c of child) walkAst(c, visit)
    else if (child && typeof child === 'object') walkAst(child, visit)
  }
}

function collectTsconfigPaths(file: string, out: PathAlias[], seen: Set<string>) {
  if (seen.has(file) || !isFile(file)) return
  seen.add(file)
  let config: any
  try {
    config = JSON.parse(stripJsonc(readFileSync(file, 'utf8')))
  } catch {
    return
  }
  const dir = dirname(file)
  const opts = config.compilerOptions ?? {}
  const base = opts.baseUrl ? resolve(dir, opts.baseUrl) : dir
  for (const [pattern, targets] of Object.entries<string[]>(opts.paths ?? {})) {
    if (out.some((a) => a.prefix + (a.wildcard ? '*' : '') + a.suffix === pattern)) continue
    const i = pattern.indexOf('*')
    out.push({
      prefix: i < 0 ? pattern : pattern.slice(0, i),
      suffix: i < 0 ? '' : pattern.slice(i + 1),
      wildcard: i >= 0,
      targets: targets.map((t) => resolve(base, t)),
    })
  }
  const extendsList = [config.extends ?? []].flat() as string[]
  for (const ext of extendsList) {
    if (ext.startsWith('.')) collectTsconfigPaths(resolve(dir, ext), out, seen)
  }
  for (const ref of config.references ?? []) {
    const p = resolve(dir, ref.path)
    collectTsconfigPaths(isDir(p) ? join(p, 'tsconfig.json') : p, out, seen)
  }
}

/** コメントと末尾カンマを除去する（文字列リテラル内は保持） */
export function stripJsonc(text: string): string {
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
      out += text.slice(i, j + 1)
      i = j
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2)
      if (i < 0) break
      i++
    } else {
      out += c
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

function isFile(p: string) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function isDir(p: string) {
  return existsSync(p) && statSync(p).isDirectory()
}
