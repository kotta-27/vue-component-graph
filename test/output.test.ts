import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultOutPath } from '../src/output'

describe('defaultOutPath', () => {
  it('uses node_modules/.cache when node_modules exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'vcg-'))
    mkdirSync(join(root, 'node_modules'))
    expect(defaultOutPath(root)).toBe(join(root, 'node_modules/.cache/vue-component-graph/graph.html'))
  })

  it('falls back to the OS temp dir, distinct per project path', () => {
    const a = mkdtempSync(join(tmpdir(), 'vcg-'))
    const b = mkdtempSync(join(tmpdir(), 'vcg-'))
    expect(defaultOutPath(a).startsWith(join(tmpdir(), 'vue-component-graph'))).toBe(true)
    expect(defaultOutPath(a)).not.toBe(defaultOutPath(b))
  })
})
