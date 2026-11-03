#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { cac } from 'cac'
import { analyze, findNodes, subgraph, type Direction, type Graph } from './graph'
import { impactLines } from './format'
import { detectLang, setLang, t } from './i18n'
import { renderHtml } from './html'
import { analyzeImpact, gitChangedFiles, type Impact } from './impact'
import { startMcpServer } from './mcp'
import { defaultOutPath } from './output'

// ヘルプの文言も切り替えるので、コマンドを定義する前に決める
setLang(detectLang())

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
    const { graph: full, deps } = analyze(root, { externals: opts.externals })
    const components = full.nodes.filter((n) => n.kind === 'component')
    if (!components.length) fail(t('noVueFiles', root))

    let graph = full
    let initialFocus: { id: string; dir: Direction } | undefined
    if (opts.focus && opts.whoUses) fail(t('focusAndWhoUses'))
    const query: string | undefined = opts.focus ?? opts.whoUses
    if (query) {
      const id = pick(full, query)
      initialFocus = { id, dir: opts.focus ? 'down' : 'up' }
      graph = subgraph(full, id, initialFocus.dir)
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
    writeFileSync(out, renderHtml(full, { initialFocus, impact }))
    printSummary(graph)
    if (impact) printImpact(full, impact)
    console.error(`\n→ ${out}`)
    if (opts.open) openInBrowser(out)
  })

cli
  .command('mcp', t('cmdMcp'))
  .option('--root <dir>', t('optRoot'))
  .example('claude mcp add vue-component-graph -- npx -y vue-component-graph mcp')
  .action(async (opts) => {
    await startMcpServer(resolve(opts.root ?? '.'))
  })

cli.help()
cli.version('0.1.0')

try {
  cli.parse()
} catch (e) {
  fail((e as Error).message)
}

function pick(graph: Graph, query: string): string {
  const hits = findNodes(graph, query)
  if (!hits.length) fail(t('noMatch', query))
  if (hits.length > 1) {
    fail(`${t('multipleMatches', query)}\n${hits.map((n) => `  ${n.id}`).join('\n')}`)
  }
  return hits[0].id
}

function printSummary(graph: Graph) {
  const comps = graph.nodes.filter((n) => n.kind === 'component').length
  const edges = graph.edges.filter((e) => e.from !== e.to).length
  const log = (s = '') => console.error(s)
  log(`${comps} components, ${edges} edges, ${graph.routes.length} routes`)
  if (graph.orphans.length) {
    log(`\n${t('unused')} (${graph.orphans.length})`)
    for (const id of graph.orphans) log(`  ${id}`)
  }
  if (graph.cycles.length) {
    log(`\n${t('cycles')} (${graph.cycles.length})`)
    for (const c of graph.cycles) log(`  ${[...c, c[0]].join(' → ')}`)
  }
  if (graph.warnings.length) {
    log(`\n${t('warnings')} (${graph.warnings.length})`)
    for (const w of graph.warnings.slice(0, 10)) log(`  ${w}`)
    if (graph.warnings.length > 10) log(`  ${t('moreWarnings', graph.warnings.length - 10)}`)
  }
}

function printImpact(graph: Graph, impact: Impact) {
  console.error('\n' + impactLines(graph, impact, t('diffFrom', impact.since)).join('\n'))
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
