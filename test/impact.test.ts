import { execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { analyze } from '../src/graph'
import { analyzeImpact, gitChangedFiles } from '../src/impact'

let root: string
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'pipe' })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vcg-impact-'))
  cpSync(fileURLToPath(new URL('./fixtures/basic', import.meta.url)), root, { recursive: true })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'init')
})

function impactOf(...files: string[]) {
  for (const f of files) appendFileSync(join(root, f), '\n')
  const { graph, deps } = analyze(root)
  const impact = analyzeImpact(graph, deps, gitChangedFiles(root, 'HEAD'), 'HEAD')
  return { graph, impact, paths: impact.routes.map((i) => graph.routes[i].path) }
}

describe('impact analysis', () => {
  it('a page-level component affects only its own route', () => {
    const { impact, paths } = impactOf('src/views/CardB.vue')
    expect(impact.changed).toEqual(['src/views/CardB.vue'])
    expect(impact.affected).toEqual(['src/views/CardB.vue', 'src/views/Home.vue'])
    expect(paths).toEqual(['/'])
    expect(impact.everywhere).toBe(false)
  })

  it('a component under App affects every page', () => {
    const { impact, graph } = impactOf('src/components/nav/NavLink.vue')
    expect(impact.affected).toEqual(['src/App.vue', 'src/components/AppHeader.vue', 'src/components/nav/NavLink.vue'])
    expect(impact.everywhere).toBe(true)
    expect(impact.routes.length).toBe(graph.routes.length)
  })

  it('follows plain TS modules (barrels)', () => {
    expect(impactOf('src/components/nav/index.ts').impact.affected).toContain('src/components/AppHeader.vue')
  })

  it('follows auto-imported components (no import statement)', () => {
    expect(impactOf('src/components/AutoWidget.vue').paths).toEqual(['/'])
  })

  it('global CSS imported by the entry affects every page', () => {
    const { impact } = impactOf('src/style.css')
    expect(impact.affected).toEqual([])
    expect(impact.everywhere).toBe(true)
  })

  it('includes untracked files and ignores unrelated ones', () => {
    appendFileSync(join(root, 'NOTES.md'), 'memo')
    const { impact } = impactOf()
    expect(impact.changed).toEqual([])
  })
})
