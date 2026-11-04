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
  // ライブラリやグローバル登録の部品なら、どこで使われているかを返す
  const key = toPascal(query.replace(/^Lazy(?=[A-Z])/, '')).toLowerCase()
  const users = graph.nodes.filter((n) => n.externals.some((x) => toPascal(x.split(' ')[0]).toLowerCase() === key))
  if (users.length) {
    const entry = users[0].externals.find((x) => toPascal(x.split(' ')[0]).toLowerCase() === key)!
    throw new QueryError(
      `${t('externalUsedBy', entry, users.length)}\n${users.slice(0, 50).map((n) => `  ${label(n)}`).join('\n')}` +
        (users.length > 50 ? `\n  ${t('andMore', users.length - 50)}` : ''),
    )
  }
  const similar = similarNames(graph, query)
  throw new QueryError(t('noMatch', query) + (similar.length ? t('candidates', similar) : ''))
}

/**
 * 解析が不完全なときに、答えの先頭に付ける注意。
 * 「未使用」や「ページなし」「確認するページ 0」を、このまま信じてよいかの判断材料
 */
export function caveats(graph: Graph): string[] {
  const out: string[] = []
  if (graph.workspacePackages) out.push(`! ${t('monorepoRoot', graph.workspacePackages)}`)
  if (graph.unresolvedImports.length) out.push(`! ${t('incompleteImports', graph.unresolvedImports.length)}`)
  return out
}

/** 打ち間違いの候補。前方の一部が含まれるか、編集距離が近いもの（近い順） */
function similarNames(graph: Graph, query: string): string[] {
  const q = toPascal(query.split('/').pop()!).toLowerCase()
  const head = q.slice(0, Math.max(3, q.length - 2))
  const limit = Math.max(2, Math.floor(q.length / 4))
  return graph.nodes
    .filter((n) => n.kind === 'component')
    .map((n) => {
      const name = toPascal(n.name.split('/').pop()!).toLowerCase()
      const d = editDistance(q, name)
      return { n, score: name.includes(head) ? Math.min(d, limit) : d }
    })
    .filter((x) => x.score <= limit)
    .sort((a, b) => a.score - b.score || a.n.label.localeCompare(b.n.label))
    .map((x) => x.n.label)
    .slice(0, 10)
}

/** 隣り合う文字の入れ替えを 1 と数える編集距離（Damerau–Levenshtein の簡易版） */
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
  for (let j = 1; j <= b.length; j++) d[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
    }
  }
  return d[a.length][b.length]
}

/** ルートが 0 件のときの理由 */
export function noRoutesReason(graph: Graph): string {
  if (graph.vitepress) return t('vitepressPages')
  return graph.unsupportedPagesDir ? t('unsupportedPages', graph.unsupportedPagesDir) : t('noRouteDefs')
}

/** ライブラリ由来（パッケージ名付き）と、解決できなかったタグに分ける */
export function splitExternals(externals: string[]): { libraries: string[]; unresolved: string[] } {
  return {
    libraries: externals.filter((x) => x.endsWith(')')),
    unresolved: externals.filter((x) => !x.endsWith(')')),
  }
}

function label(n: GraphNode): string {
  return n.kind === 'component' && n.label !== n.id ? `${n.label} (${n.id})` : n.id
}

/** id からテンプレートの辺だけで辿れるもの（import だけの辺は、描画するとは限らない） */
function templateReach(graph: Graph, starts: string[]): Set<string> {
  const children = new Map<string, string[]>()
  for (const e of graph.edges) if (e.type === 'template' && e.from !== e.to) children.set(e.from, [...(children.get(e.from) ?? []), e.to])
  const seen = new Set(starts)
  const queue = [...starts]
  while (queue.length) for (const c of children.get(queue.shift()!) ?? []) if (!seen.has(c)) (seen.add(c), queue.push(c))
  return seen
}

function pagesLine(graph: Graph, n: GraphNode): string[] {
  if (n.shell) {
    // App から辿れる部品は、どのページにも出得る。ルートからも辿れるなら、そのページも示す
    const own = n.routes.length ? [t('pagesOf', n.routes.length), ...routeLines(graph, n.routes.slice(0, 30)).map((l) => `  ${l}`)] : []
    return [t('pagesShell'), ...own]
  }
  if (!n.routes.length) {
    // import.meta.glob や動的 import でだけ読まれる画面は「辿れない」と言い切らない
    const users = graph.edges.filter((e) => e.to === n.id && e.from !== n.id)
    const dynamicOnly = users.length > 0 && users.every((e) => e.async && e.type === 'script' && !e.from.endsWith('.vue'))
    if (dynamicOnly) return [t('pagesNone', t('loadedDynamically', users.map((e) => e.from)))]
    return [t('pagesNone', graph.routes.length ? t('unreachable') : noRoutesReason(graph))]
  }
  // import だけの辺でしか届かないページは、実際には描画しないことがある
  const importOnly = new Set(n.routes.filter((i) => !templateReach(graph, graph.routes[i].chain).has(n.id)))
  const lines = routeLines(graph, n.routes).map((l, k) => `  ${l}${importOnly.has(n.routes[k]) ? `  [${t('importOnly')}]` : ''}`)
  return [t('pagesOf', n.routes.length), ...lines, ...(importOnly.size ? [`  ${t('importOnlyPages')}`] : [])]
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

  const lines = [...caveats(graph), `${n.label} (${n.id}${n.lines ? `, ${t('lines', n.lines)}` : ''})`]
  const status: string[] = []
  if (graph.orphans.includes(n.id)) status.push(t('unused'))
  const cycle = graph.cycles.find((c) => c.includes(n.id))
  if (cycle) status.push(t('cycleStatus', [...cycle, cycle[0]].map((id) => nameOf(graph, id)).join(' → ')))
  if (graph.recursive.includes(n.id)) status.push(t('recursiveStatus'))
  if (status.length) lines.push(t('status', status))
  if (n.kind === 'component') lines.push(...pagesLine(graph, n))
  lines.push(t('usedBy', parents.length), ...(parents.length ? parents.map((e) => edgeLine(e.from, e)) : [`  ${t('none')}`]))
  lines.push(t('uses', children.length), ...(children.length ? children.map((e) => edgeLine(e.to, e)) : [`  ${t('none')}`]))
  const { libraries, unresolved } = splitExternals(n.externals)
  if (libraries.length) lines.push(t('externals', libraries))
  if (unresolved.length) lines.push(t('unresolved', unresolved))
  return lines
}

export function whoUses(graph: Graph, query: string): string[] {
  const n = pick(graph, query)
  const parentEdges = new Map<string, { from: string; type: string; async: boolean }[]>()
  for (const e of graph.edges) {
    if (e.from === e.to) continue
    parentEdges.set(e.to, [...(parentEdges.get(e.to) ?? []), e])
  }
  const parentsOf = (id: string) => (parentEdges.get(id) ?? []).map((e) => e.from)
  const direct = parentEdges.get(n.id) ?? []

  // 祖先はすべて数える（経路は数が爆発するので先頭だけ）
  const ancestors = new Set<string>()
  const queue = [n.id]
  while (queue.length) for (const p of parentsOf(queue.shift()!)) if (p !== n.id && !ancestors.has(p)) (ancestors.add(p), queue.push(p))

  const LIMIT = 15
  const paths: string[][] = []
  let truncated = false
  const walk = (id: string, trail: string[]) => {
    if (paths.length >= LIMIT) return void (truncated = true)
    const ups = parentsOf(id).filter((p) => !trail.includes(p))
    if (!ups.length) return void paths.push([...trail].reverse())
    for (const p of ups) walk(p, [...trail, p])
  }
  walk(n.id, [n.id])

  const byId = new Map(graph.nodes.map((x) => [x.id, x]))
  // router.ts などのモジュールはコンポーネントの祖先と分けて数える
  const ancestorComps = [...ancestors].filter((id) => byId.get(id)?.kind === 'component')
  const ancestorModules = [...ancestors].filter((id) => byId.get(id)?.kind !== 'component')
  const list = (ids: string[], max: number) =>
    ids.slice(0, max).map((id) => nameOf(graph, id)).join(', ') + (ids.length > max ? `, ${t('andMore', ids.length - max)}` : '')
  const lines = [...caveats(graph), `${n.label} (${n.id})`]
  const tag = (e: { type: string; async: boolean }) =>
    [e.type === 'script' ? t('importOnly') : '', e.async ? t('lazy') : ''].filter(Boolean).join(', ')
  lines.push(
    t('directParents', direct.length),
    ...(direct.length ? direct.map((e) => `  - ${label(byId.get(e.from)!)}${tag(e) ? ` [${tag(e)}]` : ''}`) : [`  ${t('none')}`]),
  )
  lines.push(`${t('ancestors', ancestorComps.length)} ${list(ancestorComps, 60) || t('none')}`)
  if (ancestorModules.length) lines.push(`${t('ancestorModules', ancestorModules.length)} ${list(ancestorModules, 30)}`)
  if (direct.length) {
    lines.push(t('paths', truncated ? LIMIT : undefined))
    for (const p of paths) lines.push(`  ${p.map((id) => nameOf(graph, id)).join(' → ')}`)
  }
  if (n.kind === 'component') lines.push(...pagesLine(graph, n))
  return lines
}

export function routesReport(graph: Graph): string[] {
  const shell = graph.nodes.filter((n) => n.shell).map((n) => n.label)
  const lines = [...caveats(graph), t('pages', graph.routes.length)]
  if (!graph.routes.length) lines.push(`  ${noRoutesReason(graph)}`)
  for (const [i, line] of routeLines(graph, graph.routes.map((_, i) => i)).entries()) {
    const r = graph.routes[i]
    const extra = r.chain.filter((id) => id !== r.view && !r.layouts.includes(id)).map((id) => nameOf(graph, id))
    const notes = [
      r.layouts.length ? t('parentRoutes', r.layouts.map((id) => nameOf(graph, id))) : '',
      extra.length ? t('namedViews', extra) : '',
      r.aliases?.length ? t('routeAliases', r.aliases) : '',
    ].filter(Boolean)
    lines.push(`  ${line}${notes.length ? t('routeNotes', notes) : ''}`)
  }
  if (shell.length) lines.push('', t('sharedByAll', shell))
  return lines
}

export function issuesReport(graph: Graph): string[] {
  const lines = [summaryLine(graph), ...caveats(graph)]
  // 大きなプロジェクトでもエージェントの文脈を食い潰さないよう、各一覧は 100 件まで
  const section = (title: string, items: string[]) => {
    lines.push('', `${title} (${items.length})`)
    lines.push(...(items.length ? items.slice(0, 100).map((s) => `  ${s}`) : [`  ${t('none')}`]))
    if (items.length > 100) lines.push(`  ${t('andMore', items.length - 100)}`)
  }
  section(t('unused'), graph.orphans)
  section(t('cycles'), graph.cycles.map((c) => [...c, c[0]].map((id) => nameOf(graph, id)).join(' → ')))
  section(t('recursive'), graph.recursive)
  if (graph.unresolvedImports.length) {
    section(t('unresolvedImports', graph.unresolvedImports.length).replace(/ \(\d+\)$/, ''), unresolvedLines(graph, 30))
    lines.push(`  ${t('unresolvedImportsHint')}`)
  }
  if (graph.warnings.length) section(t('warnings'), graph.warnings.slice(0, 30))
  return lines
}

export function unresolvedLines(graph: Graph, limit: number): string[] {
  const lines = graph.unresolvedImports.slice(0, limit).map((u) => `${u.from}: ${u.spec}`)
  if (graph.unresolvedImports.length > limit) lines.push(t('moreWarnings', graph.unresolvedImports.length - limit))
  return lines
}

export function summaryLine(graph: Graph): string {
  // Markdown のページ（VitePress・Nuxt Content）はコンポーネントと分けて数える
  const md = graph.nodes.filter((n) => n.kind === 'component' && n.id.endsWith('.md')).length
  const comps = graph.nodes.filter((n) => n.kind === 'component').length - md
  const edges = graph.edges.filter((e) => e.from !== e.to).length
  return t('summary', comps, edges, graph.routes.length) + (md ? t('summaryMarkdown', md) : '')
}
