import { relative, resolve, sep } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { impactLines } from './format'
import { analyze, type FileDeps, type Graph } from './graph'
import { t } from './i18n'
import { analyzeImpact, gitChangedFiles } from './impact'
import { componentInfo, issuesReport, QueryError, routesReport, whoUses } from './report'
import { checkProjectRoot } from './root'

const VERSION = '0.1.0'

/** ツールの失敗はメッセージとしてエージェントに返す */
class ToolError extends Error {}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const ok = (lines: string[]): ToolResult => ({ content: [{ type: 'text', text: lines.join('\n') }] })

function run(fn: () => string[]): ToolResult {
  try {
    return ok(fn())
  } catch (e) {
    if (!(e instanceof ToolError || e instanceof QueryError)) throw e
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
    const problem = checkProjectRoot(dir)
    if (problem) throw new ToolError(problem)
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
      run(() => routesReport(load(root).graph)),
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
      run(() => issuesReport(load(root).graph)),
  )

  return server
}

export async function startMcpServer(root: string) {
  await createServer(root).connect(new StdioServerTransport())
}

function relativeId(graph: Graph, file: string): string {
  return relative(graph.root, resolve(graph.root, file)).split(sep).join('/')
}
