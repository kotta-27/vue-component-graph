import { nameOf, routeLines } from './format'
import { findNodes, toPascal, type Graph, type GraphNode } from './graph'
import { t } from './i18n'

/** 指定されたコンポーネントが見つからない・曖昧なとき。CLI ではエラー終了、MCP ではツールのエラーにする */
export class QueryError extends Error {}

export function pick(graph: Graph, query: string): GraphNode {
  const hits = findNodes(graph, query).filter((n) => n.kind !== 'external')
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) {
    throw new QueryError(`${t('multipleMatches', query)}\n${hits.map((n) => `  ${n.id}`).join('\n')}`)
  }
  const similar = similarNames(graph, query)
  throw new QueryError(t('noMatch', query) + (similar.length ? t('candidates', similar) : ''))
}

/** 名前の一部が一致するコンポーネント（打ち間違いの候補） */
function similarNames(graph: Graph, query: string): string[] {
  const q = toPascal(query.split('/').pop()!).toLowerCase()
  const head = q.slice(0, Math.max(3, q.length - 2))
  return graph.nodes
    .filter((n) => n.kind === 'component' && n.name.toLowerCase().includes(head))
    .map((n) => n.label)
    .slice(0, 10)
}

/** ルートが 0 件のときの理由 */
export function noRoutesReason(graph: Graph): string {
  return graph.unsupportedPagesDir ? t('unsupportedPages', graph.unsupportedPagesDir) : t('noRouteDefs')
}

function label(n: GraphNode): string {
  return n.kind === 'component' ? `${n.label} (${n.id})` : n.id
}

function pagesLine(graph: Graph, n: GraphNode): string[] {
  if (n.shell) return [t('pagesShell')]
  if (!n.routes.length) return [t('pagesNone', graph.routes.length ? t('unreachable') : noRoutesReason(graph))]
  return [t('pagesOf', n.routes.length), ...routeLines(graph, n.routes).map((l) => `  ${l}`)]
}

export function componentInfo(graph: Graph, query: string): string[] {
  const n = pick(graph, query)
  const byId = new Map(graph.nodes.map((x) => [x.id, x]))
  const tags = (e: { type: string; async: boolean }) =>
    [e.type === 'script' ? t('importOnly') : '', e.async ? t('lazy') : ''].filter(Boolean).join(', ')
  const edgeLine = (id: string, e: { type: string; async: boolean }) => {
    const tag = tags(e)
    return `  - ${label(byId.get(id)!)}${tag ? ` [${tag}]` : ''}`
  }
  const parents = graph.edges.filter((e) => e.to === n.id && e.from !== n.id)
  const children = graph.edges.filter((e) => e.from === n.id && e.to !== n.id)

  const lines = [`${n.label} (${n.id}${n.lines ? `, ${t('lines', n.lines)}` : ''})`]
  const status: string[] = []
  if (graph.orphans.includes(n.id)) status.push(t('unused'))
  const cycle = graph.cycles.find((c) => c.includes(n.id))
  if (cycle) status.push(t('cycleStatus', [...cycle, cycle[0]].map((id) => nameOf(graph, id)).join(' → ')))
  if (graph.recursive.includes(n.id)) status.push(t('recursiveStatus'))
  if (status.length) lines.push(t('status', status))
  if (n.kind === 'component') lines.push(...pagesLine(graph, n))
  lines.push(t('usedBy', parents.length), ...(parents.length ? parents.map((e) => edgeLine(e.from, e)) : [`  ${t('none')}`]))
  lines.push(t('uses', children.length), ...(children.length ? children.map((e) => edgeLine(e.to, e)) : [`  ${t('none')}`]))
  if (n.externals.length) lines.push(t('externals', n.externals))
  return lines
}

export function whoUses(graph: Graph, query: string): string[] {
  const n = pick(graph, query)
  const parentsOf = new Map<string, string[]>()
  for (const e of graph.edges) {
    if (e.from === e.to) continue
    if (!parentsOf.has(e.to)) parentsOf.set(e.to, [])
    parentsOf.get(e.to)!.push(e.from)
  }
  const direct = parentsOf.get(n.id) ?? []

  // 起点（親のないノード）から対象までの経路。数が爆発しないよう上限を設ける
  const LIMIT = 15
  const paths: string[][] = []
  let truncated = false
  const walk = (id: string, trail: string[]) => {
    if (paths.length >= LIMIT) return void (truncated = true)
    const ups = (parentsOf.get(id) ?? []).filter((p) => !trail.includes(p))
    if (!ups.length) return void paths.push([...trail].reverse())
    for (const p of ups) walk(p, [...trail, p])
  }
  walk(n.id, [n.id])

  const byId = new Map(graph.nodes.map((x) => [x.id, x]))
  const ancestors = [...new Set(paths.flat())].filter((id) => id !== n.id)
  // router.ts などのモジュールはコンポーネントの祖先と分けて数える
  const ancestorComps = ancestors.filter((id) => byId.get(id)?.kind === 'component')
  const ancestorModules = ancestors.filter((id) => byId.get(id)?.kind !== 'component')
  const lines = [`${n.label} (${n.id})`]
  lines.push(t('directParents', direct.length), ...(direct.length ? direct.map((id) => `  - ${label(byId.get(id)!)}`) : [`  ${t('none')}`]))
  lines.push(`${t('ancestors', ancestorComps.length)} ${ancestorComps.map((id) => nameOf(graph, id)).join(', ') || t('none')}`)
  if (ancestorModules.length) lines.push(`${t('ancestorModules', ancestorModules.length)} ${ancestorModules.map((id) => nameOf(graph, id)).join(', ')}`)
  if (direct.length) {
    lines.push(t('paths', truncated ? LIMIT : undefined))
    for (const p of paths) lines.push(`  ${p.map((id) => nameOf(graph, id)).join(' → ')}`)
  }
  if (n.kind === 'component') lines.push(...pagesLine(graph, n))
  return lines
}

export function routesReport(graph: Graph): string[] {
  const shell = graph.nodes.filter((n) => n.shell).map((n) => n.label)
  const lines = [t('pages', graph.routes.length)]
  if (!graph.routes.length) lines.push(`  ${noRoutesReason(graph)}`)
  for (const [i, line] of routeLines(graph, graph.routes.map((_, i) => i)).entries()) {
    const r = graph.routes[i]
    const extra = r.chain.filter((id) => id !== r.view && !r.layouts.includes(id)).map((id) => nameOf(graph, id))
    const notes = [
      r.layouts.length ? t('parentRoutes', r.layouts.map((id) => nameOf(graph, id))) : '',
      extra.length ? t('namedViews', extra) : '',
    ].filter(Boolean)
    lines.push(`  ${line}${notes.length ? t('routeNotes', notes) : ''}`)
  }
  if (shell.length) lines.push('', t('sharedByAll', shell))
  return lines
}

export function issuesReport(graph: Graph): string[] {
  const lines = [summaryLine(graph)]
  const section = (title: string, items: string[]) => {
    lines.push('', `${title} (${items.length})`)
    lines.push(...(items.length ? items.map((s) => `  ${s}`) : [`  ${t('none')}`]))
  }
  section(t('unused'), graph.orphans)
  section(t('cycles'), graph.cycles.map((c) => [...c, c[0]].map((id) => nameOf(graph, id)).join(' → ')))
  section(t('recursive'), graph.recursive)
  if (graph.warnings.length) section(t('warnings'), graph.warnings.slice(0, 30))
  return lines
}

export function summaryLine(graph: Graph): string {
  const comps = graph.nodes.filter((n) => n.kind === 'component').length
  const edges = graph.edges.filter((e) => e.from !== e.to).length
  return `${comps} components, ${edges} edges, ${graph.routes.length} routes`
}
