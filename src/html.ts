import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Direction, Graph } from './graph'
import type { Impact } from './impact'

// dist/cli.js からも src/html.ts からも ../viewer を指す
const viewerDir = fileURLToPath(new URL('../viewer/', import.meta.url))

export interface ViewerOptions {
  initialFocus?: { id: string; dir: Direction }
  impact?: Impact
}

export function renderHtml(graph: Graph, { initialFocus, impact }: ViewerOptions = {}): string {
  const read = (name: string) => readFileSync(viewerDir + name, 'utf8')
  // </script> などで JSON が script 要素を抜けないようにする
  const data = JSON.stringify({ ...graph, initialFocus, impact }).replace(/</g, '\\u003c')
  const parts: Record<string, string> = {
    '__TITLE__': escapeHtml(basename(graph.root)),
    '/*__CSS__*/': read('viewer.css'),
    '__DATA__': data,
    '/*__JS__*/': read('viewer.js'),
  }
  return read('template.html').replace(/__TITLE__|\/\*__CSS__\*\/|__DATA__|\/\*__JS__\*\//g, (m) => parts[m])
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
}
