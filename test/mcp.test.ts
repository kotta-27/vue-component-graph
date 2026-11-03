import { execFileSync } from 'node:child_process'
import { appendFileSync, cpSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeAll, describe, expect, it } from 'vitest'
import { createServer } from '../src/mcp'

// MCP のツールは package.json のあるディレクトリを要求するので、フィクスチャを複製して用意する
let root: string
let client: Client

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'vcg-mcp-'))
  cpSync(fileURLToPath(new URL('./fixtures/basic', import.meta.url)), root, { recursive: true })
  writeFileSync(join(root, 'package.json'), '{ "name": "fixture" }')
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root, stdio: 'pipe' })
  git('init', '-q')
  git('add', '-A')
  git('commit', '-qm', 'init')

  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await createServer(root).connect(serverSide)
  client = new Client({ name: 'test', version: '0' })
  await client.connect(clientSide)
})

async function call(name: string, args: Record<string, unknown> = {}) {
  const res = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean }
  return { text: res.content.map((c) => c.text).join('\n'), isError: !!res.isError }
}

describe('MCP server', () => {
  it('lists the five read-only tools', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual(['component_info', 'find_issues', 'impact', 'routes', 'who_uses'])
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true)
  })

  it('component_info: parents, children, pages', async () => {
    const { text, isError } = await call('component_info', { component: 'nav-link' })
    expect(isError).toBe(false)
    expect(text).toContain('NavLink (src/components/nav/NavLink.vue')
    expect(text).toContain('表示されるページ: 全ページ')
    expect(text).toContain('- AppHeader (src/components/AppHeader.vue)')
  })

  it('component_info: route list and edge tags', async () => {
    const { text } = await call('component_info', { component: 'Home' })
    expect(text).toMatch(/表示されるページ \(1\):\n {2}\/ +Home/)
    expect(text).toContain('- Unused (src/views/Unused.vue) [import のみ]')
  })

  it('who_uses: paths from entry points', async () => {
    const { text } = await call('who_uses', { component: 'SideNav' })
    expect(text).toContain('router.ts → SideNav')
    expect(text).toContain('/settings/profile')
  })

  it('impact with files (hypothetical change)', async () => {
    const { text } = await call('impact', { files: ['src/views/CardB.vue', 'README.md'] })
    expect(text).toContain('影響するコンポーネント (2)')
    expect(text).toMatch(/確認するページ \(1\)\n {4}\/ +Home/)
    expect(text).toContain('解析対象外として無視したファイル: README.md')
  })

  it('impact with since (git diff)', async () => {
    appendFileSync(join(root, 'src/views/About.vue'), '\n')
    const { text } = await call('impact', { since: 'HEAD' })
    expect(text).toContain('src/views/About.vue')
    expect(text).toMatch(/\/about +About/)
  })

  it('routes and find_issues', async () => {
    const routes = await call('routes')
    expect(routes.text).toContain('/settings/profile')
    expect(routes.text).toMatch(/\/settings\/profile +SettingsProfile（親: Settings \/ 名前付きビュー: SideNav）/)
    expect(routes.text).toContain('全ページ共通: App')
    const issues = await call('find_issues')
    expect(issues.text).toContain('src/components/Orphan.vue')
    expect(issues.text).toContain('CycleA → CycleB → CycleA')
  })

  it('returns errors as tool errors with suggestions', async () => {
    const missing = await call('component_info', { component: 'CycleZ' })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('候補: CycleA, CycleB')
    expect((await call('impact')).isError).toBe(true)
    expect((await call('routes', { root: '/nonexistent' })).isError).toBe(true)
  })
})
