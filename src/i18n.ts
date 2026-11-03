/** CLI と MCP の出力言語。ビューアはブラウザ側で別に切り替える */
export type Lang = 'ja' | 'en'

const ja = {
  // CLI のヘルプ
  cmdGraph: 'Vue コンポーネントの依存グラフを HTML で出力する',
  optOut: '出力する HTML のパス（既定: node_modules/.cache/vue-component-graph/graph.html）',
  optFocus: '指定コンポーネントの配下だけを表示',
  optWhoUses: '指定コンポーネントを使っている側だけを表示',
  optSince: '指定した git ref からの変更が影響するコンポーネントとページを表示',
  optExternals: 'ライブラリ等の外部コンポーネントもノードとして表示',
  optJson: 'HTML の代わりに JSON を標準出力へ',
  optNoOpen: '生成後にブラウザで開かない',
  optLang: '出力の言語（ja / en）。既定は VUE_COMPONENT_GRAPH_LANG、なければ LANG から決める',
  cmdMcp: 'MCP サーバーとして起動する（stdio）',
  optRoot: 'ツールで root を省略したときのプロジェクト（既定: 起動ディレクトリ）',

  // CLI・MCP 共通
  noVueFiles: (dir: string) => `${dir} に .vue ファイルが見つかりませんでした`,
  focusAndWhoUses: '--focus と --who-uses は同時に指定できません',
  gitDiffFailed: (detail: string) => `git の差分を取得できませんでした（${detail}）`,
  noMatch: (q: string) => `"${q}" に一致するコンポーネントがありません`,
  candidates: (names: string[]) => `。候補: ${names.join(', ')}`,
  multipleMatches: (q: string) => `"${q}" が複数に一致しました。パスで指定してください:`,
  unused: '未使用',
  cycles: '循環',
  recursive: '再帰',
  warnings: '解析の警告',
  moreWarnings: (n: number) => `...ほか ${n} 件`,
  none: 'なし',
  diffFrom: (since: string) => `${since} との差分`,

  // 影響分析・ルート
  dynamicRoute: (path: string) => `[動的] ${path}`,
  impactTitle: (label: string) => `変更の影響（${label}）`,
  impactNone: '解析対象に関係する変更はありません',
  changedFiles: (n: number) => `変更ファイル (${n})`,
  affectedComponents: (n: number) => `影響するコンポーネント (${n})`,
  pagesToCheck: (n: number) => `確認するページ (${n})`,
  everywhere: ' ← 全ページに影響',

  // MCP の入力とエラー
  rootParam: 'Vue プロジェクトのルート（package.json のあるディレクトリ）。省略時はサーバーの起動ディレクトリ',
  componentParam: 'コンポーネント名（PriceTag、price-tag）またはパスの末尾（product/PriceTag）',
  filesParam: '変更する（した）ファイル。root からの相対パスか絶対パス',
  sinceParam: '比較する git ref（main、HEAD など）',
  noDir: (dir: string) => `ディレクトリがありません: ${dir}`,
  noPackageJson: (dir: string) => `${dir} に package.json がありません。Vue プロジェクトのルートを root で指定してください`,
  filesOrSince: 'files か since のどちらかを指定してください',

  // MCP のツール説明
  componentInfoTitle: 'コンポーネントの詳細',
  componentInfoDesc:
    'Vue コンポーネント 1 つについて、使っている側（親）、使っているもの（子）、表示されるページ（URL）、外部コンポーネントを返す。' +
    'grep では見つからない自動 import・グローバル登録・kebab-case のタグも解決済み。',
  whoUsesTitle: '使っている側',
  whoUsesDesc:
    'コンポーネントを使っている側を、直接の親だけでなく祖先まで辿って返す。ページ（ルート）からの経路と、表示される URL も含む。' +
    'コンポーネントの props や見た目を変える前に、影響を受ける呼び出し元を確認するのに使う。',
  impactToolTitle: '変更の影響',
  impactToolDesc:
    '変更が影響するコンポーネントと、確認すべきページ（URL）を返す。' +
    'files を渡すと「これらのファイルを変えたら」の見積もりになる（変更前の検討に使う）。' +
    'since を渡すと、その git ref との merge-base から作業ツリーまでの実際の差分（未コミット・未追跡を含む）で調べる。' +
    '.vue 以外（composable、ユーティリティ、?raw で読むファイル、グローバル CSS）の変更も辿る。',
  routesTitle: 'ページ一覧',
  routesDesc:
    'ルート（URL）ごとに、描画される画面コンポーネントを返す。vue-router の定義と Nuxt の pages/ に対応。全ページ共通のコンポーネント（App の配下など）も示す。',
  findIssuesTitle: '構造の問題',
  findIssuesDesc: '未使用のコンポーネント、循環参照、再帰コンポーネント、解析できなかったファイルを返す。',

  // MCP の出力
  filesChanged: (n: number) => `${n} ファイルを変更した場合`,
  diffFromPlusFiles: (since: string) => `${since} との差分 ＋ 指定ファイル`,
  ignoredFiles: (files: string[]) => `解析対象外として無視したファイル: ${files.join(', ')}`,
  pages: (n: number) => `ページ (${n})`,
  noRouteDefs: 'ルート定義が見つかりません',
  parentRoutes: (names: string[]) => `親: ${names.join(' > ')}`,
  namedViews: (names: string[]) => `名前付きビュー: ${names.join(', ')}`,
  routeNotes: (notes: string[]) => `（${notes.join(' / ')}）`,
  sharedByAll: (names: string[]) => `全ページ共通: ${names.join(', ')}`,
  pagesShell: '表示されるページ: 全ページ（App や共通レイアウトの配下で常に表示）',
  pagesNone: (hasRoutes: boolean) =>
    `表示されるページ: なし（${hasRoutes ? 'どのルートからも辿れない' : 'ルート定義が見つからない'}）`,
  pagesOf: (n: number) => `表示されるページ (${n}):`,
  importOnly: 'import のみ',
  lazy: '遅延読み込み',
  lines: (n: number) => `${n} 行`,
  cycleStatus: (path: string) => `循環: ${path}`,
  recursiveStatus: '再帰（自分自身を描画）',
  status: (items: string[]) => `状態: ${items.join(' / ')}`,
  usedBy: (n: number) => `使っている側 (${n}):`,
  uses: (n: number) => `使っているもの (${n}):`,
  externals: (names: string[]) => `外部コンポーネント: ${names.join(', ')}`,
  directParents: (n: number) => `直接の親 (${n}):`,
  ancestors: (n: number) => `祖先 (${n}):`,
  ancestorModules: (n: number) => `読み込むモジュール (${n}):`,
  paths: (limit?: number) => `経路${limit ? `（先頭 ${limit} 件）` : ''}:`,
}

type Messages = typeof ja

const en: Messages = {
  cmdGraph: 'Write the Vue component dependency graph as HTML',
  optOut: 'Path of the HTML to write (default: node_modules/.cache/vue-component-graph/graph.html)',
  optFocus: 'Show only the given component and its descendants',
  optWhoUses: 'Show only the components that use the given component',
  optSince: 'Show components and pages affected by changes since the given git ref',
  optExternals: 'Also show external components (from libraries) as nodes',
  optJson: 'Print JSON to stdout instead of writing HTML',
  optNoOpen: "Don't open the browser after generating",
  optLang: 'Output language (ja / en). Defaults to VUE_COMPONENT_GRAPH_LANG, then LANG',
  cmdMcp: 'Start as an MCP server (stdio)',
  optRoot: 'Project used when a tool omits root (default: working directory)',

  noVueFiles: (dir) => `No .vue files found in ${dir}`,
  focusAndWhoUses: '--focus and --who-uses cannot be used together',
  gitDiffFailed: (detail) => `Could not get the git diff (${detail})`,
  noMatch: (q) => `No component matches "${q}"`,
  candidates: (names) => `. Did you mean: ${names.join(', ')}`,
  multipleMatches: (q) => `"${q}" matches more than one component. Specify it by path:`,
  unused: 'Unused',
  cycles: 'Cycles',
  recursive: 'Recursive',
  warnings: 'Analysis warnings',
  moreWarnings: (n) => `...and ${n} more`,
  none: 'none',
  diffFrom: (since) => `diff from ${since}`,

  dynamicRoute: (path) => `[dynamic] ${path}`,
  impactTitle: (label) => `Change impact (${label})`,
  impactNone: 'No changes relevant to the analysis',
  changedFiles: (n) => `Changed files (${n})`,
  affectedComponents: (n) => `Affected components (${n})`,
  pagesToCheck: (n) => `Pages to check (${n})`,
  everywhere: ' ← affects every page',

  rootParam: 'Root of the Vue project (the directory containing package.json). Defaults to the server working directory',
  componentParam: 'Component name (PriceTag, price-tag) or the end of its path (product/PriceTag)',
  filesParam: 'Files to change (or changed), relative to root or absolute',
  sinceParam: 'git ref to compare with (main, HEAD, …)',
  noDir: (dir) => `Directory not found: ${dir}`,
  noPackageJson: (dir) => `No package.json in ${dir}. Pass the Vue project root as root`,
  filesOrSince: 'Pass either files or since',

  componentInfoTitle: 'Component details',
  componentInfoDesc:
    'For one Vue component, returns the components that use it (parents), the components it uses (children), the pages (URLs) it appears on, and external components. ' +
    'Auto-imports, global registration and kebab-case tags that grep cannot find are already resolved.',
  whoUsesTitle: 'Who uses',
  whoUsesDesc:
    'Returns the components that use a component, following not just direct parents but all ancestors, with the paths from pages (routes) and the URLs it appears on. ' +
    "Use it to check affected callers before changing a component's props or appearance.",
  impactToolTitle: 'Change impact',
  impactToolDesc:
    'Returns the components affected by a change and the pages (URLs) to check. ' +
    'With files, it estimates "what if these files change" (use it before making a change). ' +
    'With since, it uses the actual diff from the merge-base with that git ref to the working tree (including uncommitted and untracked files). ' +
    'Changes outside .vue files (composables, utilities, files loaded with ?raw, global CSS) are followed too.',
  routesTitle: 'Pages',
  routesDesc:
    'Returns the screen component rendered for each route (URL). Supports vue-router definitions and Nuxt pages/. Also lists components shared by every page (under App, etc.).',
  findIssuesTitle: 'Structural issues',
  findIssuesDesc: 'Returns unused components, circular references, recursive components and files that could not be analyzed.',

  filesChanged: (n) => `if ${n} ${n === 1 ? 'file changes' : 'files change'}`,
  diffFromPlusFiles: (since) => `diff from ${since} + given files`,
  ignoredFiles: (files) => `Ignored (not part of the analysis): ${files.join(', ')}`,
  pages: (n) => `Pages (${n})`,
  noRouteDefs: 'No route definitions found',
  parentRoutes: (names) => `parent: ${names.join(' > ')}`,
  namedViews: (names) => `named views: ${names.join(', ')}`,
  routeNotes: (notes) => ` (${notes.join(' / ')})`,
  sharedByAll: (names) => `On every page: ${names.join(', ')}`,
  pagesShell: 'Pages: every page (always rendered under App or a shared layout)',
  pagesNone: (hasRoutes) => `Pages: none (${hasRoutes ? 'not reachable from any route' : 'no route definitions found'})`,
  pagesOf: (n) => `Pages (${n}):`,
  importOnly: 'import only',
  lazy: 'lazy',
  lines: (n) => `${n} ${n === 1 ? 'line' : 'lines'}`,
  cycleStatus: (path) => `cycle: ${path}`,
  recursiveStatus: 'recursive (renders itself)',
  status: (items) => `Status: ${items.join(' / ')}`,
  usedBy: (n) => `Used by (${n}):`,
  uses: (n) => `Uses (${n}):`,
  externals: (names) => `External components: ${names.join(', ')}`,
  directParents: (n) => `Direct parents (${n}):`,
  ancestors: (n) => `Ancestors (${n}):`,
  ancestorModules: (n) => `Loaded by modules (${n}):`,
  paths: (limit) => `Paths${limit ? ` (first ${limit})` : ''}:`,
}

const MESSAGES: Record<Lang, Messages> = { ja, en }

let current: Lang = 'en'

export function setLang(lang: Lang) {
  current = lang
}

export function getLang(): Lang {
  return current
}

/** --lang、VUE_COMPONENT_GRAPH_LANG、LC_ALL / LC_MESSAGES / LANG の順に見る */
export function detectLang(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): Lang {
  const i = argv.indexOf('--lang')
  const flag = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith('--lang='))?.slice('--lang='.length)
  for (const v of [flag, env.VUE_COMPONENT_GRAPH_LANG]) if (v === 'ja' || v === 'en') return v
  const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || ''
  return /^ja/i.test(locale) ? 'ja' : 'en'
}

type Args<K extends keyof Messages> = Messages[K] extends (...args: infer A) => string ? A : []

export function t<K extends keyof Messages>(key: K, ...args: Args<K>): string {
  const m = MESSAGES[current][key]
  return typeof m === 'function' ? (m as (...a: unknown[]) => string)(...args) : (m as string)
}
