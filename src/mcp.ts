import { existsSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { impactLines, nameOf, routeLines } from './format'
import { analyze, findNodes, toPascal, type FileDeps, type Graph, type GraphNode } from './graph'
import { t } from './i18n'
import { analyzeImpact, gitChangedFiles } from './impact'

const VERSION = '0.1.0'

/** ツールの失敗はメッセージとしてエージェントに返す */
class ToolError extends Error {}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const ok = (lines: string[]): ToolResult => ({ content: [{ type: 'text', text: lines.join('\n') }] })

function run(fn: () => string[]): ToolResult {
  try {
    return ok(fn())
  } catch (e) {
    if (!(e instanceof ToolError)) throw e
    return { content: [{ type: 'text', text: e.message }], isError: true }
  }
}

export function createServer(defaultRoot: string): McpServer {
  const server = new McpServer({ name: 'vue-component-graph', version: VERSION })
  // 説明文は起動時の言語で作る
  const rootParam = z.string().optional().describe(t('rootParam'))
  const componentParam = z.string().describe(t('componentParam'))

  const load = (root?: string): { graph: Graph; deps: FileDeps } => {
    const dir = resolve(defaultRoot, root ?? '.')
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ToolError(t('noDir', dir))
    if (!existsSync(join(dir, 'package.json'))) {
      throw new ToolError(t('noPackageJson', dir))
    }
    const result = analyze(dir)
    if (!result.graph.nodes.some((n) => n.kind === 'component')) throw new ToolError(t('noVueFiles', dir))
    return result
  }

  const readOnly = { readOnlyHint: true, openWorldHint: false }

  server.registerTool(
    'component_info',
    {
      title: t('componentInfoTitle'),
      description: t('componentInfoDesc'),
      inputSchema: { component: componentParam, root: rootParam },
      annotations: readOnly,
    },
    ({ component, root }) => run(() => componentInfo(load(root).graph, component)),
  )

  server.registerTool(
    'who_uses',
    {
      title: t('whoUsesTitle'),
      description: t('whoUsesDesc'),
      inputSchema: { component: componentParam, root: rootParam },
      annotations: readOnly,
    },
    ({ component, root }) => run(() => whoUses(load(root).graph, component)),
  )

  server.registerTool(
    'impact',
    {
      title: t('impactToolTitle'),
      description: t('impactToolDesc'),
      inputSchema: {
        files: z.array(z.string()).optional().describe(t('filesParam')),
        since: z.string().optional().describe(t('sinceParam')),
        root: rootParam,
      },
      annotations: readOnly,
    },
    ({ files, since, root }) =>
      run(() => {
        if (!files?.length && !since) throw new ToolError(t('filesOrSince'))
        const { graph, deps } = load(root)
        let changed: string[] = files?.map((f) => resolve(graph.root, f)) ?? []
        let label = t('filesChanged', changed.length)
        if (since) {
          try {
            changed = [...new Set([...changed, ...gitChangedFiles(graph.root, since)])]
          } catch (e) {
            const detail = String((e as { stderr?: string }).stderr || (e as Error).message).trim().split('\n')[0]
            throw new ToolError(t('gitDiffFailed', detail))
          }
          label = files?.length ? t('diffFromPlusFiles', since) : t('diffFrom', since)
        }
        const impact = analyzeImpact(graph, deps, changed, since ?? '')
        const lines = impactLines(graph, impact, label)
        const unknown = (files ?? []).filter((f) => !impact.changed.includes(relativeId(graph, f)))
        if (unknown.length) lines.push('', t('ignoredFiles', unknown))
        return lines
      }),
  )

  server.registerTool(
    'routes',
    {
      title: t('routesTitle'),
      description: t('routesDesc'),
      inputSchema: { root: rootParam },
      annotations: readOnly,
    },
    ({ root }) =>
      run(() => {
        const { graph } = load(root)
        const shell = graph.nodes.filter((n) => n.shell).map((n) => n.name)
        const lines = [t('pages', graph.routes.length)]
        if (!graph.routes.length) lines.push(`  ${t('noRouteDefs')}`)
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
      }),
  )

  server.registerTool(
    'find_issues',
    {
      title: t('findIssuesTitle'),
      description: t('findIssuesDesc'),
      inputSchema: { root: rootParam },
      annotations: readOnly,
    },
    ({ root }) =>
      run(() => {
        const { graph } = load(root)
        const comps = graph.nodes.filter((n) => n.kind === 'component').length
        const lines = [`${comps} components, ${graph.edges.filter((e) => e.from !== e.to).length} edges, ${graph.routes.length} routes`]
        const section = (title: string, items: string[]) => {
          lines.push('', `${title} (${items.length})`)
          lines.push(...(items.length ? items.map((s) => `  ${s}`) : [`  ${t('none')}`]))
        }
        section(t('unused'), graph.orphans)
        section(t('cycles'), graph.cycles.map((c) => [...c, c[0]].map((id) => nameOf(graph, id)).join(' → ')))
        section(t('recursive'), graph.recursive)
        if (graph.warnings.length) section(t('warnings'), graph.warnings.slice(0, 30))
        return lines
      }),
  )

  return server
}

export async function startMcpServer(root: string) {
  await createServer(root).connect(new StdioServerTransport())
}

function relativeId(graph: Graph, file: string): string {
  return relative(graph.root, resolve(graph.root, file)).split(sep).join('/')
}

function pick(graph: Graph, query: string): GraphNode {
  const hits = findNodes(graph, query).filter((n) => n.kind !== 'external')
  if (hits.length === 1) return hits[0]
  if (hits.length > 1) {
    throw new ToolError(`${t('multipleMatches', query)}\n${hits.map((n) => `  ${n.id}`).join('\n')}`)
  }
  const q = toPascal(query).toLowerCase()
  const similar = graph.nodes
    .filter((n) => n.kind === 'component' && n.name.toLowerCase().includes(q.slice(0, Math.max(3, q.length - 2))))
    .slice(0, 10)
  throw new ToolError(
    t('noMatch', query) + (similar.length ? t('candidates', similar.map((n) => n.name)) : ''),
  )
}

function label(n: GraphNode): string {
  return n.kind === 'component' ? `${n.name} (${n.id})` : n.id
}

function pagesLine(graph: Graph, n: GraphNode): string[] {
  if (n.shell) return [t('pagesShell')]
  if (!n.routes.length) {
    return [t('pagesNone', graph.routes.length > 0)]
  }
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

  const lines = [`${n.name} (${n.id}${n.lines ? `, ${t('lines', n.lines)}` : ''})`]
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
  const lines = [`${n.name} (${n.id})`]
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
