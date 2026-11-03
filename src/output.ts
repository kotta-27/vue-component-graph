import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

/**
 * 既定の出力先。プロジェクトに未追跡ファイルを増やさないよう、
 * node_modules/.cache（無ければ OS の一時ディレクトリ）に置く
 */
export function defaultOutPath(root: string): string {
  const nodeModules = join(root, 'node_modules')
  if (existsSync(nodeModules)) return join(nodeModules, '.cache', 'vue-component-graph', 'graph.html')
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 8)
  return join(tmpdir(), 'vue-component-graph', `${basename(root)}-${hash}.html`)
}
