import type { Graph, GraphNode, RouteInfo } from './graph'
import { t } from './i18n'
import type { Impact } from './impact'

const nodeIndex = new WeakMap<Graph, Map<string, GraphNode>>()

/** コンポーネントは登録名（自動 import ならディレクトリ名付き）、モジュールはパスで表す */
export function nameOf(graph: Graph, id: string): string {
  let byId = nodeIndex.get(graph)
  if (!byId) nodeIndex.set(graph, (byId = new Map(graph.nodes.map((n) => [n.id, n]))))
  const n = byId.get(id)
  if (n?.kind === 'component') return n.label
  return n ? id : id.split('/').pop()!.replace(/\.vue$/, '')
}

export function routeLabel(r: RouteInfo): string {
  return r.dynamic ? t('dynamicRoute', r.path) : r.path
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
  const out = [t('impactTitle', label)]
  if (!impact.changed.length) return [...out, `  ${t('impactNone')}`]
  out.push(`  ${t('changedFiles', impact.changed.length)}`)
  const deleted = new Set(impact.deleted)
  for (const id of impact.changed) out.push(`    ${id}${deleted.has(id) ? t('deletedMark') : ''}`)
  // 変更したファイル自体は上に出ているので、影響を受ける側だけを数える（ビューアと同じ）
  const changed = new Set(impact.changed)
  const affected = impact.affected.filter((id) => !changed.has(id))
  out.push(`  ${t('affectedComponents', affected.length)}`)
  if (affected.length) out.push(`    ${affected.map((id) => nameOf(graph, id)).join(', ')}`)
  out.push(`  ${t('pagesToCheck', impact.routes.length)}${impact.everywhere ? t('everywhere') : ''}`)
  for (const line of routeLines(graph, impact.routes)) out.push(`    ${line}`)
  return out
}
