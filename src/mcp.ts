import { existsSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { impactLines, nameOf, routeLines } from './format'
import { analyze, findNodes, toPascal, type FileDeps, type Graph, type GraphNode } from './graph'
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

const rootParam = z
  .string()
  .optional()
  .describe('Vue プロジェクトのルート（package.json のあるディレクトリ）。省略時はサーバーの起動ディレクトリ')

const componentParam = z
  .string()
  .describe('コンポーネント名（PriceTag、price-tag）またはパスの末尾（product/PriceTag）')

export function createServer(defaultRoot: string): McpServer {
  const server = new McpServer({ name: 'vue-component-graph', version: VERSION })

  const load = (root?: string): { graph: Graph; deps: FileDeps } => {
    const dir = resolve(defaultRoot, root ?? '.')
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ToolError(`ディレクトリがありません: ${dir}`)
    if (!existsSync(join(dir, 'package.json'))) {
      throw new ToolError(`${dir} に package.json がありません。Vue プロジェクトのルートを root で指定してください`)
    }
    const result = analyze(dir)
    if (!result.graph.nodes.some((n) => n.kind === 'component')) throw new ToolError(`${dir} に .vue ファイルがありません`)
    return result
  }

  const readOnly = { readOnlyHint: true, openWorldHint: false }

  server.registerTool(
    'component_info',
    {
      title: 'コンポーネントの詳細',
      description:
        'Vue コンポーネント 1 つについて、使っている側（親）、使っているもの（子）、表示されるページ（URL）、外部コンポーネントを返す。' +
        'grep では見つからない自動 import・グローバル登録・kebab-case のタグも解決済み。',
      inputSchema: { component: componentParam, root: rootParam },
      annotations: readOnly,
    },
    ({ component, root }) => run(() => componentInfo(load(root).graph, component)),
  )

  server.registerTool(
    'who_uses',
    {
      title: '使っている側',
      description:
        'コンポーネントを使っている側を、直接の親だけでなく祖先まで辿って返す。ページ（ルート）からの経路と、表示される URL も含む。' +
        'コンポーネントの props や見た目を変える前に、影響を受ける呼び出し元を確認するのに使う。',
      inputSchema: { component: componentParam, root: rootParam },
      annotations: readOnly,
    },
    ({ component, root }) => run(() => whoUses(load(root).graph, component)),
  )

  server.registerTool(
    'impact',
    {
      title: '変更の影響',
      description:
        '変更が影響するコンポーネントと、確認すべきページ（URL）を返す。' +
        'files を渡すと「これらのファイルを変えたら」の見積もりになる（変更前の検討に使う）。' +
        'since を渡すと、その git ref との merge-base から作業ツリーまでの実際の差分（未コミット・未追跡を含む）で調べる。' +
        '.vue 以外（composable、ユーティリティ、?raw で読むファイル、グローバル CSS）の変更も辿る。',
      inputSchema: {
        files: z.array(z.string()).optional().describe('変更する（した）ファイル。root からの相対パスか絶対パス'),
        since: z.string().optional().describe('比較する git ref（main、HEAD など）'),
        root: rootParam,
      },
      annotations: readOnly,
    },
    ({ files, since, root }) =>
      run(() => {
        if (!files?.length && !since) throw new ToolError('files か since のどちらかを指定してください')
        const { graph, deps } = load(root)
        let changed: string[] = files?.map((f) => resolve(graph.root, f)) ?? []
        let label = `${changed.length} ファイルを変更した場合`
        if (since) {
          try {
            changed = [...new Set([...changed, ...gitChangedFiles(graph.root, since)])]
          } catch (e) {
            const detail = String((e as { stderr?: string }).stderr || (e as Error).message).trim().split('\n')[0]
            throw new ToolError(`git の差分を取得できませんでした（${detail}）`)
          }
          label = files?.length ? `${since} との差分 ＋ 指定ファイル` : `${since} との差分`
        }
        const impact = analyzeImpact(graph, deps, changed, since ?? '')
        const lines = impactLines(graph, impact, label)
        const unknown = (files ?? []).filter((f) => !impact.changed.includes(relativeId(graph, f)))
        if (unknown.length) lines.push('', `解析対象外として無視したファイル: ${unknown.join(', ')}`)
        return lines
      }),
  )

  server.registerTool(
    'routes',
    {
      title: 'ページ一覧',
      description:
        'ルート（URL）ごとに、描画される画面コンポーネントを返す。vue-router の定義と Nuxt の pages/ に対応。全ページ共通のコンポーネント（App の配下など）も示す。',
      inputSchema: { root: rootParam },
      annotations: readOnly,
    },
    ({ root }) =>
      run(() => {
        const { graph } = load(root)
        const shell = graph.nodes.filter((n) => n.shell).map((n) => n.name)
        const lines = [`ページ (${graph.routes.length})`]
        if (!graph.routes.length) lines.push('  ルート定義が見つかりません')
        for (const [i, line] of routeLines(graph, graph.routes.map((_, i) => i)).entries()) {
          const r = graph.routes[i]
          const extra = r.chain.filter((id) => id !== r.view && !r.layouts.includes(id)).map((id) => nameOf(graph, id))
          const notes = [
            r.layouts.length ? `親: ${r.layouts.map((id) => nameOf(graph, id)).join(' > ')}` : '',
            extra.length ? `名前付きビュー: ${extra.join(', ')}` : '',
          ].filter(Boolean)
          lines.push(`  ${line}${notes.length ? `（${notes.join(' / ')}）` : ''}`)
        }
        if (shell.length) lines.push('', `全ページ共通: ${shell.join(', ')}`)
        return lines
      }),
  )

  server.registerTool(
    'find_issues',
    {
      title: '構造の問題',
      description: '未使用のコンポーネント、循環参照、再帰コンポーネント、解析できなかったファイルを返す。',
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
          lines.push(...(items.length ? items.map((s) => `  ${s}`) : ['  なし']))
        }
        section('未使用', graph.orphans)
        section('循環', graph.cycles.map((c) => [...c, c[0]].map((id) => nameOf(graph, id)).join(' → ')))
        section('再帰', graph.recursive)
        if (graph.warnings.length) section('解析の警告', graph.warnings.slice(0, 30))
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
    throw new ToolError(`"${query}" が複数に一致しました。パスで指定してください:\n${hits.map((n) => `  ${n.id}`).join('\n')}`)
  }
  const q = toPascal(query).toLowerCase()
  const similar = graph.nodes
    .filter((n) => n.kind === 'component' && n.name.toLowerCase().includes(q.slice(0, Math.max(3, q.length - 2))))
    .slice(0, 10)
  throw new ToolError(
    `"${query}" に一致するコンポーネントがありません` +
      (similar.length ? `。候補: ${similar.map((n) => n.name).join(', ')}` : ''),
  )
}

function label(n: GraphNode): string {
  return n.kind === 'component' ? `${n.name} (${n.id})` : n.id
}

function pagesLine(graph: Graph, n: GraphNode): string[] {
  if (n.shell) return ['表示されるページ: 全ページ（App や共通レイアウトの配下で常に表示）']
  if (!n.routes.length) {
    return [`表示されるページ: なし（${graph.routes.length ? 'どのルートからも辿れない' : 'ルート定義が見つからない'}）`]
  }
  return [`表示されるページ (${n.routes.length}):`, ...routeLines(graph, n.routes).map((l) => `  ${l}`)]
}

export function componentInfo(graph: Graph, query: string): string[] {
  const n = pick(graph, query)
  const byId = new Map(graph.nodes.map((x) => [x.id, x]))
  const tags = (e: { type: string; async: boolean }) =>
    [e.type === 'script' ? 'import のみ' : '', e.async ? '遅延読み込み' : ''].filter(Boolean).join(', ')
  const edgeLine = (id: string, e: { type: string; async: boolean }) => {
    const t = tags(e)
    return `  - ${label(byId.get(id)!)}${t ? ` [${t}]` : ''}`
  }
  const parents = graph.edges.filter((e) => e.to === n.id && e.from !== n.id)
  const children = graph.edges.filter((e) => e.from === n.id && e.to !== n.id)

  const lines = [`${n.name} (${n.id}${n.lines ? `, ${n.lines} 行` : ''})`]
  const status: string[] = []
  if (graph.orphans.includes(n.id)) status.push('未使用')
  const cycle = graph.cycles.find((c) => c.includes(n.id))
  if (cycle) status.push(`循環: ${[...cycle, cycle[0]].map((id) => nameOf(graph, id)).join(' → ')}`)
  if (graph.recursive.includes(n.id)) status.push('再帰（自分自身を描画）')
  if (status.length) lines.push(`状態: ${status.join(' / ')}`)
  if (n.kind === 'component') lines.push(...pagesLine(graph, n))
  lines.push(`使っている側 (${parents.length}):`, ...(parents.length ? parents.map((e) => edgeLine(e.from, e)) : ['  なし']))
  lines.push(`使っているもの (${children.length}):`, ...(children.length ? children.map((e) => edgeLine(e.to, e)) : ['  なし']))
  if (n.externals.length) lines.push(`外部コンポーネント: ${n.externals.join(', ')}`)
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
  lines.push(`直接の親 (${direct.length}):`, ...(direct.length ? direct.map((id) => `  - ${label(byId.get(id)!)}`) : ['  なし']))
  lines.push(`祖先 (${ancestorComps.length}): ${ancestorComps.map((id) => nameOf(graph, id)).join(', ') || 'なし'}`)
  if (ancestorModules.length) lines.push(`読み込むモジュール (${ancestorModules.length}): ${ancestorModules.map((id) => nameOf(graph, id)).join(', ')}`)
  if (direct.length) {
    lines.push(`経路${truncated ? `（先頭 ${LIMIT} 件）` : ''}:`)
    for (const p of paths) lines.push(`  ${p.map((id) => nameOf(graph, id)).join(' → ')}`)
  }
  if (n.kind === 'component') lines.push(...pagesLine(graph, n))
  return lines
}
