import { execFileSync } from 'node:child_process'
import { relative, resolve, sep } from 'node:path'
import type { FileDeps, Graph } from './graph'

export interface Impact {
  since: string
  /** 変更されたファイルのうち、解析対象に関係するもの */
  changed: string[]
  /** 変更の影響を受けるコンポーネント（変更されたものを含む） */
  affected: string[]
  /** 確認すべきルート（Graph.routes の添字） */
  routes: number[]
  /** 全ページに影響する（App の配下や、エントリが読むグローバル CSS の変更） */
  everywhere: boolean
}

const SCRIPT_RE = /\.(vue|[cm]?[jt]sx?)$/

/** `since` との merge-base からの変更（未コミット・未追跡を含む）を絶対パスで返す */
export function gitChangedFiles(root: string, since: string): string[] {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const top = git('rev-parse', '--show-toplevel')
  const base = git('merge-base', since, 'HEAD')
  const lines = [
    ...git('diff', '--name-only', base).split('\n'),
    ...git('-C', top, 'ls-files', '--others', '--exclude-standard').split('\n'),
  ]
  return [...new Set(lines.filter(Boolean).map((f) => resolve(top, f)))]
}

export function analyzeImpact(graph: Graph, deps: FileDeps, changedFiles: string[], since: string): Impact {
  const rel = (f: string) => relative(graph.root, f).split(sep).join('/')
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))

  // 「誰に import / 使用されているか」の逆引き
  const users = new Map<string, Set<string>>()
  const link = (from: string, to: string) => {
    if (from === to) return
    if (!users.has(to)) users.set(to, new Set())
    users.get(to)!.add(from)
  }
  for (const [from, targets] of deps) for (const to of targets) link(from, to)
  for (const e of graph.edges) link(e.from, e.to) // グローバル登録・自動 import は import 文がない

  const changed = changedFiles.map(rel).filter((id) => deps.has(id) || users.has(id) || nodeById.has(id))
  const seen = new Set(changed)
  const queue = [...changed]
  while (queue.length) {
    for (const user of users.get(queue.shift()!) ?? []) {
      if (!seen.has(user)) {
        seen.add(user)
        queue.push(user)
      }
    }
  }

  const affected = [...seen].filter((id) => nodeById.get(id)?.kind === 'component').sort()
  const routes = new Set<number>()
  let everywhere = false
  for (const id of affected) {
    const n = nodeById.get(id)!
    if (n.shell) everywhere = true
    for (const r of n.routes) routes.add(r)
  }
  // main.ts などが直接読む CSS 等は全ページに効く
  for (const entry of graph.entries) {
    if (changed.some((id) => !SCRIPT_RE.test(id) && deps.get(entry)?.has(id))) everywhere = true
  }

  if (everywhere) graph.routes.forEach((_, i) => routes.add(i))

  return { since, changed: changed.sort(), affected, routes: [...routes].sort((a, b) => a - b), everywhere }
}
