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

/**
 * ルートを「パス  画面」の 2 列にそろえる（長いパスに合わせて全行を空けないよう、幅には上限を設ける）。
 * 同じパスが複数あるときは定義元を添える（モジュールごとに / を定義している構成など）
 */
export function routeLines(graph: Graph, indices: number[]): string[] {
  const routes = indices.map((i) => graph.routes[i])
  const width = Math.min(32, Math.max(0, ...routes.map((r) => displayWidth(routeLabel(r)))))
  const count = new Map<string, number>()
  for (const r of graph.routes) count.set(r.path, (count.get(r.path) ?? 0) + 1)
  return routes.map((r) => {
    const label = routeLabel(r)
    const pad = ' '.repeat(Math.max(0, width - displayWidth(label)))
    const where = count.get(r.path)! > 1 ? `  (${t('definedIn', r.source)})` : ''
    return `${label}${pad}  ${nameOf(graph, r.view)}${where}`
  })
}

export function impactLines(graph: Graph, impact: Impact, label: string): string[] {
  const out = [t('impactTitle', label)]
  // 追えなかった変更・全体に効く変更があれば、「関係する変更なし」とは言い切らない
  const notes = impact.unlinked.length ? [`  ${t('unlinked', impact.unlinked)}`] : []
  if (!impact.changed.length && !impact.projectWide.length) return [...out, ...(notes.length ? notes : [`  ${t('impactNone')}`])]
  out.push(`  ${t('changedFiles', impact.changed.length + impact.projectWide.length)}`)
  const deleted = new Set(impact.deleted)
  for (const id of impact.changed) out.push(`    ${id}${deleted.has(id) ? t('deletedMark') : ''}`)
  for (const id of impact.projectWide) out.push(`    ${id}${t('projectWideMark')}`)
  // 変更したファイル自体は上に出ているので、影響を受ける側だけを数える（ビューアと同じ）
  const changed = new Set(impact.changed)
  const affected = impact.affected.filter((id) => !changed.has(id))
  out.push(`  ${t('affectedComponents', affected.length)}`)
  // 数百件になることがあるので、名前は先頭 40 件まで（件数は全体）
  const names = affected.slice(0, 40).map((id) => nameOf(graph, id)).join(', ')
  if (affected.length) out.push(`    ${names}${affected.length > 40 ? `, ${t('andMore', affected.length - 40)}` : ''}`)
  out.push(`  ${t('pagesToCheck', impact.routes.length)}${impact.everywhere ? t('everywhere') : ''}`)
  for (const line of routeLines(graph, impact.routes)) out.push(`    ${line}`)
  return [...out, ...notes]
}
