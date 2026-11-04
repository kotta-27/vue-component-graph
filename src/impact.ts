import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { FileDeps, Graph } from './graph'
import { t } from './i18n'

export interface Impact {
  since: string
  /** 変更されたファイルのうち、解析対象に関係するもの（削除したファイルを含む） */
  changed: string[]
  /** changed のうち削除されたファイル */
  deleted: string[]
  /** 変更したのに、どのコンポーネント・ページにもつながらなかったファイル（解析で追えていない可能性がある） */
  unlinked: string[]
  /** 依存関係・ビルド設定・index.html など、プロジェクト全体に効く変更（everywhere になる） */
  projectWide: string[]
  /** 変更の影響を受けるコンポーネント（変更されたものを含む） */
  affected: string[]
  /** 確認すべきルート（Graph.routes の添字） */
  routes: number[]
  /** 全ページに影響する（App の配下や、エントリが読むモジュール・CSS の変更） */
  everywhere: boolean
}

/** `since` との merge-base からの変更（未コミット・未追跡・削除を含む）を絶対パスで返す */
export function gitChangedFiles(root: string, since: string): string[] {
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const top = git('rev-parse', '--show-toplevel')
  let base: string
  try {
    base = git('merge-base', since, 'HEAD')
  } catch (e) {
    // ref が無いなら、ありそうな候補（origin のデフォルトブランチなど）を添える
    const exists = (ref: string) => {
      try {
        git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)
        return true
      } catch {
        return false
      }
    }
    if (exists(since)) throw e
    const remoteHead = (() => {
      try {
        return git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD')
      } catch {
        return ''
      }
    })()
    const hints = [remoteHead, `origin/${since}`, 'main', 'master', 'develop', 'origin/main', 'origin/master']
      .filter((r, i, all) => r && r !== since && all.indexOf(r) === i && exists(r))
      .slice(0, 3)
    throw new Error(t('refNotFound', since, hints.join(', ')))
  }
  const lines = [
    // --no-renames：リネームの旧パスも「削除」として出す（旧パスを import している側を拾うため）
    ...git('diff', '--name-only', '--no-renames', base).split('\n'),
    ...git('-C', top, 'ls-files', '--others', '--exclude-standard').split('\n'),
  ]
  return [...new Set(lines.filter(Boolean).map((f) => resolve(top, f)))]
}

const ANALYZED_RE = /\.(vue|[cm]?[jt]sx?)$/
/** 全ページに効くファイル：依存関係、ロックファイル、プロジェクト直下のビルド・スタイル設定、HTML のテンプレート、環境変数 */
const PROJECT_WIDE_RE =
  /^(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|index\.html|app\.html|\.env(\..*)?|[\w.-]+\.config\.[cm]?[jt]s|tsconfig(\.[\w-]+)?\.json|app\.config\.[cm]?[jt]s)$/
/** 解析の対象外にしているもの（テスト、Storybook など）。つながらなくても列挙しない */
const IGNORED_RE = /(^|\/)(test|tests|__tests__|e2e|cypress|playwright|coverage|dist|build)\/|\.(test|spec|stories|story)\.[^.]+$/

/**
 * 変更から、影響を受けるコンポーネントと確認すべきページを求める。
 * - コンポーネントの変更は、それを描画・import するコンポーネントと通常のモジュール（h() で使う composable など）に伝わる。
 *   ルート定義・createApp・バレルなどのハブには伝えない（ページは routes から求めるので、ハブを使う側は無関係）
 * - モジュール・CSS・画像の変更は、参照しているもの全部に伝わる。エントリに届けば全ページ、ルート定義に届けばそのルート。
 *   ルート定義・ルーター・エントリ・グローバル登録・glob は行き止まりで、その先（ストア経由の利用者など）には伝えない
 * - 遅延 import（ルートの () => import() など）は、使う側がコンポーネントのときだけ伝わる
 */
export function analyzeImpact(
  graph: Graph,
  deps: FileDeps,
  changedFiles: string[],
  since: string,
  /** 「これらを変えたら」と仮定したファイル（まだ無くてもよいので、削除扱いにしない） */
  hypothetical: string[] = [],
): Impact {
  // graph.root はシンボリックリンクを解決済みなので、変更ファイルも揃える（macOS の /var → /private/var など）
  const real = (f: string) => {
    try {
      return realpathSync(f)
    } catch {
      try {
        return join(realpathSync(dirname(f)), basename(f)) // 削除済みのファイル
      } catch {
        return f
      }
    }
  }
  changedFiles = changedFiles.map(real)
  hypothetical = hypothetical.map(real)
  const rel = (f: string) => relative(graph.root, f).split(sep).join('/')
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]))
  const isComponent = (id: string) => nodeById.get(id)?.kind === 'component'

  const reverse = (forward: Map<string, Set<string>>) => {
    const users = new Map<string, Set<string>>()
    for (const [from, targets] of forward) {
      for (const to of targets) {
        if (from === to) continue
        if (!users.has(to)) users.set(to, new Set())
        users.get(to)!.add(from)
      }
    }
    return users
  }
  const staticUsers = reverse(deps.static)
  const lazyUsers = reverse(deps.lazy)
  // グローバル登録・自動 import は import 文がないので、コンポーネント間の辺も使う
  const componentUsers = new Map<string, Set<string>>()
  for (const e of graph.edges) {
    if (e.from === e.to || !isComponent(e.from)) continue
    if (!componentUsers.has(e.to)) componentUsers.set(e.to, new Set())
    componentUsers.get(e.to)!.add(e.from)
  }

  // 削除したファイルを、まだ import しているファイル（import は解決できなくなっている）
  const importersOfDeleted = (id: string): string[] => {
    const base = id.replace(/\.(vue|[cm]?[jt]sx?)$/, '')
    const keys = [base, ...(/\/index$/.test(base) ? [base.replace(/\/index$/, '')] : [])]
    return keys.flatMap((k) => [...(deps.missing.get(k) ?? [])])
  }
  const inContent = (id: string) => deps.contentDirs.some((d) => id === d || id.startsWith(d + '/'))
  const known = (id: string) =>
    deps.static.has(id) || staticUsers.has(id) || lazyUsers.has(id) || nodeById.has(id) || inContent(id) || importersOfDeleted(id).length > 0
  const assumed = new Set(hypothetical)
  // 「これを消したら」と仮定したファイルも、まだ import している側があれば削除として扱う
  const deleted = changedFiles
    .filter((f) => !existsSync(f) && (!assumed.has(f) || importersOfDeleted(rel(f)).length > 0))
    .map(rel)
    .filter((id) => !id.startsWith('..') && (ANALYZED_RE.test(id) || (graph.vitepress && id.endsWith('.md'))))
  const changed = [...new Set([...changedFiles.map(rel).filter(known), ...deleted])]
  // 依存関係・ビルド設定・HTML のテンプレートなど、全ページに効くもの
  const projectWide = changedFiles.map(rel).filter((id) => PROJECT_WIDE_RE.test(id)).sort()

  const usersOf = (id: string): string[] => {
    const out = new Set(componentUsers.get(id))
    for (const u of importersOfDeleted(id)) out.add(u)
    for (const u of staticUsers.get(id) ?? []) {
      if (isComponent(id) && deps.hubs.has(u)) continue
      out.add(u)
    }
    // 遅延 import：コンポーネントからなら描画される。モジュールからでも、読まれるのが部品でなければ（i18n の辞書など）伝える
    for (const u of lazyUsers.get(id) ?? []) if (isComponent(u) || !isComponent(id)) out.add(u)
    // Nuxt Content のファイルは、Content を描画・取得するコンポーネントに効く
    if (inContent(id)) for (const u of deps.contentUsers) out.add(u)
    return [...out]
  }

  const seen = new Set(changed)
  const queue = [...changed]
  while (queue.length) {
    const id = queue.shift()!
    // ルート定義・ルーター・エントリなどは行き止まり（影響はルートと「全ページ」で表す）
    if (deps.sinks.has(id)) continue
    for (const user of usersOf(id)) {
      if (!seen.has(user)) {
        seen.add(user)
        queue.push(user)
      }
    }
  }

  const affected = [...seen].filter(isComponent).sort()
  const routes = new Set<number>()
  let everywhere = graph.entries.some((id) => seen.has(id)) || projectWide.length > 0
  for (const id of affected) {
    const n = nodeById.get(id)!
    if (n.shell) everywhere = true
    for (const r of n.routes) routes.add(r)
  }
  // ルート定義のファイル自体（またはそれが使うモジュール）が変わったら、そこで定義したルート
  graph.routes.forEach((r, i) => {
    if (seen.has(r.source)) routes.add(i)
  })
  if (everywhere) graph.routes.forEach((_, i) => routes.add(i))

  // 変更したのに何にもつながらなかったファイル。黙って「影響なし」にしない
  const reachedFrom = (id: string) => {
    const users = usersOf(id)
    return isComponent(id) || users.length > 0 || graph.entries.includes(id) || graph.routes.some((r) => r.source === id)
  }
  const sourceLike = /\.(vue|[cm]?[jt]sx?|css|scss|sass|less|styl|pcss|svg|png|jpe?g|gif|webp|avif|woff2?|json|ya?ml|md|html)$/
  const unlinked = changedFiles
    .map(rel)
    .filter((id) => !id.startsWith('..') && sourceLike.test(id) && !deleted.includes(id) && existsSync(resolve(graph.root, id)))
    .filter((id) => !projectWide.includes(id) && !IGNORED_RE.test(id))
    .filter((id) => !known(id) || !reachedFrom(id))
    .sort()

  return {
    since,
    changed: changed.sort(),
    deleted: deleted.sort(),
    unlinked,
    projectWide,
    affected,
    routes: [...routes].sort((a, b) => a - b),
    everywhere,
  }
}
