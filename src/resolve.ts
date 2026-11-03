import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

// Vite・webpack と同じくスクリプトを先に試す（Foo/ に index.ts と index.vue があれば index.ts）
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.vue']

interface PathAlias {
  prefix: string
  suffix: string
  wildcard: boolean
  targets: string[]
}

export type Resolver = (spec: string, importer: string) => string | null

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

  return (spec, importer) => {
    spec = spec.split('?')[0]
    const key = spec.startsWith('.') ? `${dirname(importer)}\0${spec}` : spec
    if (cache.has(key)) return cache.get(key)!
    const result = resolveUncached(spec, importer, aliases)
    cache.set(key, result)
    return result
  }
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
