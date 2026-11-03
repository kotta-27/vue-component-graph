import { describe, expect, it } from 'vitest'
import { detectLang } from '../src/i18n'

describe('detectLang', () => {
  it('prefers --lang, then VUE_COMPONENT_GRAPH_LANG, then the locale', () => {
    expect(detectLang(['node', 'cli', '--lang', 'ja'], { LANG: 'en_US.UTF-8' })).toBe('ja')
    expect(detectLang(['node', 'cli', '--lang=en'], { VUE_COMPONENT_GRAPH_LANG: 'ja' })).toBe('en')
    expect(detectLang(['node', 'cli'], { VUE_COMPONENT_GRAPH_LANG: 'ja', LANG: 'en_US.UTF-8' })).toBe('ja')
    expect(detectLang(['node', 'cli'], { LANG: 'ja_JP.UTF-8' })).toBe('ja')
    expect(detectLang(['node', 'cli'], { LC_ALL: 'en_US.UTF-8', LANG: 'ja_JP.UTF-8' })).toBe('en')
    expect(detectLang(['node', 'cli'], {})).toBe('en')
  })

  it('ignores unknown values', () => {
    expect(detectLang(['node', 'cli', '--lang', 'fr'], { LANG: 'ja_JP.UTF-8' })).toBe('ja')
  })
})
