import type { Graph, GraphNode, RouteInfo } from './graph'
import type { Impact } from './impact'

const nodeIndex = new WeakMap<Graph, Map<string, GraphNode>>()

/** コンポーネントは登録名（自動 import ならディレクトリ名付き）、モジュールはパスで表す */
export function nameOf(graph: Graph, id: string): string {
  let byId = nodeIndex.get(graph)
  if (!byId) nodeIndex.set(graph, (byId = new Map(graph.nodes.map((n) => [n.id, n]))))
  const n = byId.get(id)
  if (n?.kind === 'component') return n.name
  return n ? id : id.split('/').pop()!.replace(/\.vue$/, '')
}

export function routeLabel(r: RouteInfo): string {
  return r.dynamic ? `[動的] ${r.path}` : r.path
}

/** 全角文字を 2 桁として数えた表示幅 */
export function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += ch.codePointAt(0)! > 0xff ? 2 : 1
  return w
}

/** ルートを「パス  画面」の 2 列にそろえる */
export function routeLines(graph: Graph, indices: number[]): string[] {
  const routes = indices.map((i) => graph.routes[i])
  const width = Math.max(0, ...routes.map((r) => displayWidth(routeLabel(r))))
  return routes.map((r) => {
    const label = routeLabel(r)
    return `${label}${' '.repeat(width - displayWidth(label))}  ${nameOf(graph, r.view)}`
  })
}

export function impactLines(graph: Graph, impact: Impact, label: string): string[] {
  const out = [`変更の影響（${label}）`]
  if (!impact.changed.length) return [...out, '  解析対象に関係する変更はありません']
  out.push(`  変更ファイル (${impact.changed.length})`)
  for (const id of impact.changed) out.push(`    ${id}`)
  out.push(`  影響するコンポーネント (${impact.affected.length})`)
  if (impact.affected.length) out.push(`    ${impact.affected.map((id) => nameOf(graph, id)).join(', ')}`)
  out.push(`  確認するページ (${impact.routes.length})${impact.everywhere ? ' ← 全ページに影響' : ''}`)
  for (const line of routeLines(graph, impact.routes)) out.push(`    ${line}`)
  return out
}
