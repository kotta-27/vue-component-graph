# vue-component-graph

[English](README.md) | **日本語**

Vue プロジェクトを静的解析して、**コンポーネントの依存関係**と、**それぞれがどのページに表示されるか**をインタラクティブな HTML で見せる CLI。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/graph-dark.png">
  <img alt="PriceTag を選択して、使っている側と表示されるページを確認しているところ" src="docs/graph-light.png">
</picture>

答えられる問い：

- この部品は、どのコンポーネントから使われていて、どの URL に表示されるか
- この PR の変更で、どのページを確認すればいいか（`--since`）
- 使われていないコンポーネントや、循環参照はあるか

## クイックスタート

Node.js 20 以上が必要。Vue プロジェクトのルート（package.json のあるディレクトリ）で、インストールせずに実行できる。

```sh
cd your-vue-app
npx vue-component-graph
```

チームで使うなら devDependencies に入れておく。

```sh
npm install -D vue-component-graph
```

解析結果の HTML がブラウザで開く。ターミナルにも要約が出る。

```
22 components, 30 edges, 6 routes

未使用 (1)
  src/components/LegacyBanner.vue
```

特定のコンポーネントについて知りたいときは名前を渡す。結果がターミナルに出て、ビューアもそのコンポーネントに絞った状態で開く。

```sh
npx vue-component-graph --who-uses PriceTag   # 使っている側、ルートからの経路、表示されるページ
npx vue-component-graph --focus ProductCard   # 親・子・表示されるページ
```

HTML の出力先は `node_modules/.cache/vue-component-graph/graph.html`。`node_modules` が無いときは OS の一時ディレクトリに書く。プロジェクトに未追跡ファイルは増えない。

## 変更の影響を調べる（`--since`）

```sh
npx vue-component-graph --since main
```

`main` との merge-base から今の作業ツリーまでの差分（未コミット・未追跡のファイルを含む）を起点に、import と template での使用を逆に辿る。影響を受けるコンポーネントと、確認すべきページを出す。

```
変更の影響（main との差分）
  変更ファイル (1)
    src/composables/usePrice.ts
  影響するコンポーネント (7)
    CartItem, PriceTag, ProductCard, CartView, HomeView, ProductView, OrdersView
  確認するページ (4)
    /                HomeView
    /products/:id    ProductView
    /cart            CartView
    /account/orders  OrdersView
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/impact-dark.png">
  <img alt="usePrice.ts の変更が影響するコンポーネントとページを強調表示しているところ" src="docs/impact-light.png">
</picture>

- `.vue` 以外の変更も辿る（composable、ユーティリティ、`?raw` で読み込むファイル、`@import` や Sass の `@use` で読み込む CSS（`_tooltip.scss` のような部分ファイルを含む）、template で参照する画像（`<img src="@/assets/logo.svg">`）など）
- `createApp(App)` の配下にある部品（ヘッダーなど）や、エントリが読み込むもの（グローバル CSS、プラグイン）が変わったときは「全ページに影響」と判定する
- 部品の変更を、ルーターやストアを経由して広げない。ルート定義・`createRouter`・`createApp`・グローバル登録は部品を集めるだけで、ページはルート定義から求める
- 削除したファイルは「（削除）」付きで出し、まだそれを import しているファイルを影響ありとする
- どのコンポーネントにもページにもつながらなかった変更は、黙って捨てずに別に列挙する（解析で追えなかったものが「確認するページ 0」に隠れないように）
- `--since` のときは影響だけを出す（未使用の一覧は出さない）

## AI エージェントから使う（MCP）

MCP サーバーとして起動でき、Claude Code などのエージェントがツールとして呼び出せる。grep では見つからない依存（自動 import、グローバル登録、kebab-case のタグ）や「どの URL に出るか」を、エージェントが正確に調べられる。

Claude Code の場合：

```sh
claude mcp add -s user vue-component-graph -- npx -y vue-component-graph mcp
```

ほかのクライアントでは、設定ファイルに次を書く。

```json
{
  "mcpServers": {
    "vue-component-graph": { "command": "npx", "args": ["-y", "vue-component-graph", "mcp"] }
  }
}
```

| ツール | 入力 | 返すもの |
|---|---|---|
| `component_info` | `component` | 使っている側、使っているもの、表示されるページ、外部コンポーネント |
| `who_uses` | `component` | 直接の親、祖先、エントリからの経路、表示されるページ |
| `impact` | `files` または `since` | 影響を受けるコンポーネントと、確認すべきページ |
| `routes` | なし | ルートごとの画面、親ルート、名前付きビュー、全ページ共通の部品 |
| `find_issues` | なし | 未使用、循環、再帰、解析の警告 |

- どのツールも `root`（package.json のあるディレクトリ）を受け取る。省略するとサーバーの起動ディレクトリを使う
- `impact` に `files` を渡すと「これらを変えたら」の見積もりになる。エージェントが変更する前に影響の広さを確かめられる
- すべて読み取り専用で、ファイルを書き換えない

出力の例（`who_uses`、`examples/shop` に対して）：

```
PriceTag (src/components/product/PriceTag.vue)
直接の親 (4):
  - CartItem (src/components/cart/CartItem.vue)
  - ProductCard (src/components/product/ProductCard.vue)
  - ProductView (src/views/ProductView.vue)
  - OrdersView (src/views/account/OrdersView.vue)
祖先 (6): CartView, CartItem, HomeView, ProductCard, ProductView, OrdersView
読み込むモジュール (1): src/router.ts
経路:
  src/router.ts → CartView → CartItem → PriceTag
  src/router.ts → HomeView → ProductCard → PriceTag
  src/router.ts → ProductView → PriceTag
  src/router.ts → OrdersView → PriceTag
表示されるページ (4):
  /                HomeView
  /products/:id    ProductView
  /cart            CartView
  /account/orders  OrdersView
```

## 検出できるもの

### コンポーネント間の依存

| 書き方 | 例 |
|---|---|
| 相対パス・エイリアスの import | `import Foo from './Foo.vue'`、tsconfig の `paths`、`@/` `~/`、プロジェクトのディレクトリ名で始まる webpack 風のパス（`src/components/Foo`） |
| template のタグ | `<FooBar>`、`<foo-bar>`、`<component :is="cond ? A : B">` |
| Options API | `components: { Foo }` |
| 遅延読み込み | `defineAsyncComponent(() => import('./Foo.vue'))`、`const Foo = () => import('./Foo.vue')`、webpack の `require()` / `require.ensure` |
| グローバル登録 | `app.component('Foo', Foo)`。Vue と同じく、自分自身のファイル名より先に解決する |
| 自動 import | unplugin-vue-components / Nuxt の `components.d.ts` |
| Nuxt の components/ | `.nuxt/` が無くても Nuxt の命名規則で解決（`user/Card.vue` → `<UserCard>`、`global/Badge.vue` → `<Badge>`、`Lazy` 付き、`#components` からの import）。リポジトリ内のレイヤー（`extends: ['./layers/x']`、`layers/*`）も含む |
| Nuxt Content | `content/**/*.md` で MDC の記法（`::read-more`、`:kbd[Ctrl]`）で使うコンポーネント。`components/content/` はディレクトリ名を付けずに呼ぶ |
| バレル | `export { default as Foo } from './Foo.vue'`、`export const Foo = withInstall(foo)`、`export const Layout = () => import('./Layout.vue')`。Vite と同じく `Foo/index.ts` を `Foo/index.vue` より優先する |
| `import.meta.glob` | `import.meta.glob('/src/views/**/*.vue')` や webpack の `require.context()` に一致するファイルは使用中として扱う（表示されるページは実行時に決まる） |
| VitePress | Markdown のページで import・使用しているコンポーネントと、`.vitepress/theme` のテーマ |
| 再帰 | 自分自身をファイル名で描画するコンポーネント |

UI ライブラリの接頭辞を持つタグ（Quasar の `QBtn`、Nuxt UI の `UButton`、Vuetify の `VBtn`、`ElButton`、`NButton` など）は、そのライブラリが依存関係にあればライブラリの部品として扱う。JSX / TSX で書いたコンポーネントは解析しないが、ファイル付きで示す（`Badge (src/components/Badge/badge.tsx)`）。どこにも解決できないタグ（プラグインでの登録か、import 漏れ）は、ライブラリの部品と分けて出す。

template で描画せず import だけしている依存（ルート定義、`h()`、変数経由など）は「import のみ」として区別して表示する。`.vue` からの名前付き import（エクスポートした型など）はコンポーネントの依存として数えない（`--since` では辿る）。`.vue` を import している `main.ts` や `router.ts` もノードとして出る。

コンポーネント名は Vue と同じ規則で決める。`SvgIcon/index.vue` は `SvgIcon`、Nuxt の `components/user/Card.vue` は `UserCard`。名前が重なるときは、区別できるまでディレクトリを付けて表示する（`a/Item`、`b/Item`）。ファイルベースルーティングのページはパスで表示する（`pages/users/[id]`）。

### ページ（ルート）

- **vue-router**：`children` のネスト、名前付きビュー（`components: { default, side }`）、`.map()` などで作る動的ルート、別モジュールから import したルートのコンポーネント。空パスの子ルートは親の URL のページとして扱う。共通レイアウトを描画するだけのルート（`redirect` のある親、default のビューで複数のルートを包む Layout の親、レイアウトを指すだけのメニュー項目）と外部リンク（`path: 'https://...'`）はページとして数えない。子が名前付きビューだけを埋める親（ダイアログのルートを持つ一覧画面など）はページとして残す
- **Nuxt**：`pages/` のファイルベースルーティング（`[id]`、`[[id]]`、`[...slug]`、`(group)`）。レイヤーのページも含む。`settings.vue` と `settings/index.vue` は 1 つのページ `/settings` として扱う。各ページのレイアウトは `definePageMeta({ layout })` で決まる（無ければ `default`、`layout: false` ならなし）
- 同じパスが複数定義されている場合（モジュールごとに `/` を定義する構成など）は、定義元のファイルを併記する
- **全ページ共通**：`createApp(App)` の配下と、Nuxt の `app.vue`

### 構造の問題

- 未使用のコンポーネント（どこからも使われていないもの）
- 循環参照
- 外部コンポーネント（ライブラリ由来で、解析対象外のもの）の使用箇所

## ビューアの操作

| 操作 | 内容 |
|---|---|
| ホバー / クリック | そのコンポーネントの祖先と子孫を強調表示する。大きなプロジェクトでは、クリックした部品の周辺に切り替える |
| 詳細パネル | 使っている側、使っているもの、表示されるページ、外部コンポーネント |
| 「配下だけ表示」「使っている側を表示」「周辺だけ表示」 | グラフをその範囲に絞る（周辺は上下 1〜4 段で、− / + で変えられる）。概要の数字も絞った範囲で数え直す |
| ページタブ | ページを選ぶと、そのページに出る部品だけを表示する |
| 「よく使う部品を隠す」 | 多くの部品から使われる部品（ボタンなど）を描かず、使う側に `+N` と数だけ出す |
| 「ディレクトリでまとめる」 | ディレクトリごとに 1 つの箱にまとめ、箱をまたぐ依存の数を線の太さで示す。箱をクリックすると開く |
| 「VS Code で開く」 | ファイルをエディタで開く |
| タブ | 概要（未使用・循環など）／一覧（親・子・行数でソート）／ページ（ルートごとの画面と部品数） |
| `/` | 検索 |
| `F` | 全体を表示 |
| ドラッグ / ピンチ・Ctrl+ホイール | パン / ズーム |
| `Esc` | 選択・絞り込みを解除 |

コンポーネントが 150 個を超えるプロジェクトは、全部を一度に描くと読めないので、ディレクトリ単位・よく使う部品を隠した状態・ページタブを開いた状態で始まる。色はディレクトリ（atoms / molecules / organisms など）ごと。凡例はノードに重ならないよう畳んだ状態で始まる。

右上の「English」/「日本語」ボタンで表示言語を切り替えられる（初期値はブラウザの言語、選んだ言語は記憶する）。ライト / ダークモードは OS の設定に従う。

## オプション

```
vue-component-graph [dir] [options]
```

| オプション | 説明 |
|---|---|
| `-o, --out <file>` | HTML の出力先 |
| `--focus <name>` | 指定コンポーネントの配下だけを表示（詳細もターミナルに出す） |
| `--who-uses <name>` | 指定コンポーネントを使っている側だけを表示（結果もターミナルに出す） |
| `--since <ref>` | git の `ref` からの変更が影響するコンポーネントとページを出す |
| `--externals` | ライブラリ等の外部コンポーネントもノードとして表示 |
| `--json` | HTML の代わりに JSON を標準出力へ |
| `--no-open` | 生成後にブラウザで開かない |
| `--lang <ja\|en>` | 出力の言語（既定: `VUE_COMPONENT_GRAPH_LANG`、なければ `LANG`） |

`vue-component-graph mcp [--root <dir>] [--lang <ja|en>]` で MCP サーバー（stdio）として起動する。

ターミナルと MCP の出力は日本語と英語に対応している。`--lang`、環境変数 `VUE_COMPONENT_GRAPH_LANG`、ロケール（`LANG` など）の順に決まる。OS の言語が英語の環境で日本語にしたいときは `--lang ja` を付けるか、`VUE_COMPONENT_GRAPH_LANG=ja` を設定する。

`<name>` はコンポーネント名（`AppHeader`、`app-header`）かパスの末尾（`nav/NavLink`）。複数に一致した場合は候補を表示して終了する。一致しない場合は似た名前を提案する。

結果は標準出力、エラーは標準エラー出力に出す。`npx vue-component-graph --since main > impact.txt` でファイルに保存できる。

## JSON 出力

`--json` は次の形を出力する（`-o` があればそのファイルに書く）。CI やほかのツールと組み合わせるときに使う。

```ts
{
  root: string
  nodes: {
    id: string            // ルートからの相対パス
    name: string          // コンポーネント名（Foo/index.vue → Foo）。モジュールはパス
    label: string         // 表示名。名前が重なるときはディレクトリを付ける
    kind: 'component' | 'module' | 'external'
    group: string         // src/ 直下のディレクトリ名
    entry: boolean        // フレームワークが直接描画する（App.vue、ファイルベースルーティングの pages/・layouts/、VitePress のページ）
    lines: number
    externals: string[]   // ライブラリと JSX/TSX は "名前 (パッケージかファイル)"、解決できないものは "名前" だけ
    routes: number[]      // 表示されるページ（routes の添字）
    shell: boolean        // 全ページ共通
  }[]
  edges: { from: string; to: string; type: 'template' | 'script'; async: boolean }[]
  routes: {
    path: string
    dynamic: boolean      // path が式で、実際の URL は実行時に決まる
    view: string          // メインの画面
    layouts: string[]     // 親ルートの画面
    chain: string[]       // このルートで描画されるルートコンポーネントすべて
    source: string        // ルートを定義しているファイル
  }[]
  orphans: string[]
  cycles: string[][]
  recursive: string[]
  entries: string[]       // createApp() を呼んでいるモジュール
  warnings: string[]
  unsupportedPagesDir?: string  // 読み取れないファイルベースルーティングのディレクトリ
  vitepress?: boolean           // VitePress のサイト（ページは Markdown で、ルートは列挙しない）
  unresolvedImports: { from: string; spec: string }[]  // 解決できなかったプロジェクト内の import
  workspacePackages?: string[]  // モノレポのルートで実行したとき、.vue を含むパッケージ
  impact?: {
    since: string; changed: string[]; deleted: string[]; unlinked: string[]
    affected: string[]; routes: number[]; everywhere: boolean
  }
}
```

## 制限

静的解析なので、実行時にしか決まらないものは分からない。

- **動的なルート**：`path` が式のルート（例：`` `/x/${id}` ``）は 1 件として扱う。実際に何本の URL になるかは分からない
- **描画関数**：`h()` や JSX / TSX で描画するコンポーネントは、template の依存として検出できない（import されていれば「import のみ」として出る）。JSX / TSX のファイル自体も解析しない
- **Vite のファイルベースルーティング**：vue-router の Vite プラグイン（旧 unplugin-vue-router）や vite-plugin-pages の `src/pages/` からはルートを作らない。その旨を出力し、ページとレイアウトのコンポーネント自体は解析して、未使用とは判定しない
- **サーバーから受け取るルート**：実行時に作るルートのために `import.meta.glob` で読む画面は使用中として扱うが、どのページに出るかは分からない
- **VitePress**：ルートは列挙しない。Markdown から使われるコンポーネントは解析する
- **モノレポ**：パッケージごとに実行する。ほかのパッケージからの import は見えないので、別パッケージだけが使う部品は未使用と出る。モノレポのルートで実行すると、その旨とパッケージの一覧を出す
- **バンドラー設定の alias**：`vite.config` や webpack の alias は読まない（tsconfig の `paths` は読む）。解決できなかった import は、使用中の部品が未使用に見える原因になるので一覧で出す
- **読まないディレクトリ**：`node_modules`、`.nuxt`、`__tests__` などはどこにあっても、`dist`、`build`、`test`、`tests`、`e2e`、`coverage` などはプロジェクト直下にあるときだけ読まない
- **リポジトリの外の Nuxt レイヤー**（npm パッケージや `github:`）は解析しない。どのレイヤーかを警告で出す
- **Vue 2**：Vue 3 の SFC コンパイラで解析する。結果は使えるが、Vue 3 で廃止された構文（`<template functional>` など）は解析の警告として出る
- **生成されない `components.d.ts`**：unplugin-vue-components の自動 import は、開発サーバーが生成する `components.d.ts` を読む。リポジトリに含めていないと解決できない。存在しないファイルを指す登録は警告として出す。Nuxt は `.nuxt/` が無くても `components/` から推定するが、`nuxt.config` で追加したディレクトリやレイヤーは `nuxi prepare` 後でないと解決できない
- **プラグイン登録**：プラグインがグローバル登録するコンポーネント（`RouterView` など）は外部コンポーネントとして扱う
- **template 言語**：pug などの template は解析しない
- **composable**：composable 自体はグラフのノードにならない（影響分析では辿る）

## 開発

```sh
npm install        # prepare で dist/ もビルドされる
npm test           # vitest
npm run typecheck
npm run demo       # examples/shop を解析して開く
npm link           # vue-component-graph コマンドとして使う
```

`examples/shop`（リポジトリにあり、npm パッケージには含まない）は README のスクリーンショットに使っている架空のショップアプリ。

## ライセンス

[MIT](LICENSE)
