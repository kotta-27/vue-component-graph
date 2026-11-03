#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { cac } from 'cac'
import { analyze, subgraph, type Direction, type Graph } from './graph'
import { impactLines } from './format'
import { detectLang, explicitLang, isLang, langFlag, setLang, t } from './i18n'
import { renderHtml } from './html'
import { analyzeImpact, gitChangedFiles, type Impact } from './impact'
import { startMcpServer } from './mcp'
import { defaultOutPath } from './output'
import { componentInfo, noRoutesReason, pick, QueryError, summaryLine, whoUses } from './report'
import { checkProjectRoot } from './root'

// ヘルプの文言も切り替えるので、コマンドを定義する前に決める
setLang(detectLang())
const flag = langFlag()
if (flag !== undefined && !isLang(flag)) fail(t('langInvalid', flag))

const cli = cac('vue-component-graph')

cli.option('--lang <lang>', t('optLang'))

cli
  .command('[dir]', t('cmdGraph'))
  .option('-o, --out <file>', t('optOut'))
  .option('--focus <name>', t('optFocus'))
  .option('--who-uses <name>', t('optWhoUses'))
  .option('--since <ref>', t('optSince'))
  .option('--externals', t('optExternals'))
  .option('--json', t('optJson'))
  .option('--no-open', t('optNoOpen'))
  .example('vue-component-graph')
  .example('vue-component-graph ./my-app --focus AppHeader')
  .example('vue-component-graph --who-uses BaseButton')
  .example('vue-component-graph --since main')
  .example('vue-component-graph --json > graph.json')
  .action((dir: string | undefined, opts) => {
    const root = resolve(dir ?? '.')
    const problem = checkProjectRoot(root)
    if (problem) fail(problem)
    const { graph: full, deps } = analyze(root, { externals: opts.externals })
    const components = full.nodes.filter((n) => n.kind === 'component')
    if (!components.length) fail(t('noVueFiles', root))

    let graph = full
    let initialFocus: { id: string; dir: Direction } | undefined
    if (opts.focus && opts.whoUses) fail(t('focusAndWhoUses'))
    const query: string | undefined = opts.focus ?? opts.whoUses
    let report: string[] | undefined
    if (query) {
      const id = orFail(() => pick(full, query).id)
      initialFocus = { id, dir: opts.focus ? 'down' : 'up' }
      graph = subgraph(full, id, initialFocus.dir)
      report = opts.focus ? componentInfo(full, id) : whoUses(full, id)
    }

    let impact: Impact | undefined
    if (opts.since) {
      let changed: string[]
      try {
        changed = gitChangedFiles(root, String(opts.since))
      } catch (e) {
        const detail = String((e as { stderr?: string }).stderr || (e as Error).message).trim().split('\n')[0]
        fail(t('gitDiffFailed', detail))
      }
      impact = analyzeImpact(full, deps, changed, String(opts.since))
    }

    if (opts.json) {
      process.stdout.write(JSON.stringify(impact ? { ...graph, impact } : graph, null, 2) + '\n')
      return
    }

    // HTML には全体を埋め込み、ビューア側で絞り込む（解除できるように）
    const out = opts.out ? resolve(opts.out) : defaultOutPath(root)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, renderHtml(full, { initialFocus, impact, lang: explicitLang() }))
    // 絞り込んだときは、件数の要約ではなくそのコンポーネントの結果を出す
    console.log((report ?? summaryLines(graph)).join('\n'))
    if (impact) console.log('\n' + impactLines(full, impact, t('diffFrom', impact.since)).join('\n'))
    console.log(`\n→ ${out}`)
    if (opts.open) openInBrowser(out)
  })

cli
  .command('mcp', t('cmdMcp'))
  .option('--root <dir>', t('optRoot'))
  .example('claude mcp add vue-component-graph -- npx -y vue-component-graph mcp')
  .action(async (opts) => {
    await startMcpServer(resolve(opts.root ?? '.'))
  })

// --no-open に付く "(default: true)" は「開かない」が既定に読めるので消す
cli.help((sections) => sections.map((sec) => ({ ...sec, body: sec.body.replace(/ \(default: true\)/g, '') })))
cli.version('0.1.0')

try {
  cli.parse()
} catch (e) {
  fail((e as Error).message)
}

function orFail<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (e instanceof QueryError) fail(e.message)
    throw e
  }
}

function summaryLines(graph: Graph): string[] {
  const lines = [summaryLine(graph)]
  if (!graph.routes.length) lines.push(noRoutesReason(graph))
  if (graph.orphans.length) lines.push('', `${t('unused')} (${graph.orphans.length})`, ...graph.orphans.map((id) => `  ${id}`))
  if (graph.cycles.length) {
    lines.push('', `${t('cycles')} (${graph.cycles.length})`, ...graph.cycles.map((c) => `  ${[...c, c[0]].join(' → ')}`))
  }
  if (graph.warnings.length) {
    lines.push('', `${t('warnings')} (${graph.warnings.length})`, ...graph.warnings.slice(0, 10).map((w) => `  ${w}`))
    if (graph.warnings.length > 10) lines.push(`  ${t('moreWarnings', graph.warnings.length - 10)}`)
  }
  return lines
}

function openInBrowser(file: string) {
  const [cmd, args] =
    process.platform === 'darwin' ? ['open', [file]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', file]]
    : ['xdg-open', [file]]
  spawn(cmd, args as string[], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
}

function fail(message: string): never {
  console.error(`vue-component-graph: ${message}`)
  process.exit(1)
}
