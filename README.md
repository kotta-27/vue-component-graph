# vue-component-graph

**English** | [日本語](https://github.com/kotta-27/vue-component-graph/blob/main/README.ja.md)

A CLI that statically analyzes a Vue project and shows, as interactive HTML, **how components depend on each other** and **which pages each one appears on**.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/kotta-27/vue-component-graph/main/docs/graph-dark.png">
  <img alt="PriceTag selected, showing the components that use it and the pages it appears on" src="https://raw.githubusercontent.com/kotta-27/vue-component-graph/main/docs/graph-light.png">
</picture>

Questions it answers:

- Which components use this one, and on which URLs does it show up?
- Which pages should I check for the changes in this PR? (`--since`)
- Are there unused components or circular references?

Available in English and Japanese. The CLI and MCP server use `--lang`, then `VUE_COMPONENT_GRAPH_LANG`, then your locale (`LANG`, …). The viewer follows `--lang` if given, otherwise your browser's language, and has a switch button.

## Quick start

Requires Node.js 20 or later. Run it in the root of your Vue project (the directory with package.json); no install needed:

```sh
cd your-vue-app
npx vue-component-graph
```

To share it with your team, add it to devDependencies:

```sh
npm install -D vue-component-graph
```

The analysis opens in your browser as HTML, and a summary is printed to the terminal:

```
22 components, 30 edges, 6 routes

Unused (1)
  src/components/LegacyBanner.vue
```

To ask about one component, name it. The answer is printed and the viewer opens narrowed to it:

```sh
npx vue-component-graph --who-uses PriceTag   # what uses it, paths from the routes, pages it appears on
npx vue-component-graph --focus ProductCard   # its parents, children and pages
```

The HTML is written to `node_modules/.cache/vue-component-graph/graph.html`, or to the OS temp directory when there is no `node_modules`. No untracked files are added to your project.

## Change impact (`--since`)

```sh
npx vue-component-graph --since main
```

Starting from the diff between the merge-base with `main` and the current working tree (including uncommitted and untracked files), it walks imports and template usage backwards. It lists the affected components and the pages to check.

```
Change impact (diff from main)
  Changed files (1)
    src/composables/usePrice.ts
  Affected components (7)
    CartItem, PriceTag, ProductCard, CartView, HomeView, ProductView, OrdersView
  Pages to check (4)
    /                HomeView
    /products/:id    ProductView
    /cart            CartView
    /account/orders  OrdersView
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/kotta-27/vue-component-graph/main/docs/impact-dark.png">
  <img alt="Components and pages affected by a change to usePrice.ts, highlighted" src="https://raw.githubusercontent.com/kotta-27/vue-component-graph/main/docs/impact-light.png">
</picture>

- Changes outside `.vue` files are followed too: composables and utilities (including ones auto-imported by Nuxt or unplugin-auto-import), files loaded with `?raw`, CSS pulled in with `@import` / Sass `@use` (including partials such as `_tooltip.scss`), images referenced from templates or `new URL('./x.png', import.meta.url)`, lazily loaded locale files, and Nuxt Content data (`content/**`, affecting the pages that render or query it)
- Changes to dependencies and project-wide files (`package.json`, lockfiles, `vite.config.*` and other root configs, `index.html`, `.env*`) are reported as affecting every page
- A change to a component under `createApp(App)` (such as the header), or to anything the entry loads (global CSS, plugins), is reported as affecting every page
- A component change is not spread through the router or a store: route tables, `createRouter`, `createApp` and global registration only collect components, and pages are worked out from the routes instead
- Deleted and renamed files are listed with "(deleted)" (the old path of a rename), and files that still import them are reported as affected
- Changed files that don't reach any component or page are listed separately instead of being silently dropped, so "0 pages to check" never hides something the analysis couldn't follow
- With `--since`, only the impact is printed (no unused list)

## Using it from AI agents (MCP)

It can run as an MCP server, so agents such as Claude Code can call it as a tool. Agents get accurate answers about dependencies that grep cannot find (auto-imports, global registration, kebab-case tags) and about which URLs a component appears on.

For Claude Code:

```sh
claude mcp add -s user vue-component-graph -- npx -y vue-component-graph mcp
```

For other clients, add this to the config file:

```json
{
  "mcpServers": {
    "vue-component-graph": { "command": "npx", "args": ["-y", "vue-component-graph", "mcp"] }
  }
}
```

| Tool | Input | Returns |
|---|---|---|
| `component_info` | `component` | Components that use it, components it uses, pages it appears on, external components |
| `who_uses` | `component` | Direct parents, ancestors, paths from entry points, pages it appears on |
| `impact` | `files` or `since` | Affected components and the pages to check |
| `routes` | none | Screen for each route, parent routes, named views, components shared by all pages |
| `find_issues` | none | Unused components, cycles, recursion, analysis warnings |

- Every tool accepts `root` (the directory containing package.json). If omitted, the server's working directory is used
- When the analysis is incomplete (unresolved imports, a monorepo root), every answer starts with lines beginning with `!`, so an agent doesn't treat "Unused" or "0 pages to check" as certain
- Asking about a library or globally registered component (`UButton`, `SvgIcon`) returns the components that use it
- Results are cached per project and refreshed when a file changes, so repeated calls are fast
- Passing `files` to `impact` gives a "what if I change these" estimate, so an agent can check how far a change reaches before making it
- All tools are read-only and never modify files

Example output (`who_uses` on `examples/shop`):

```
PriceTag (src/components/product/PriceTag.vue)
Direct parents (4):
  - CartItem (src/components/cart/CartItem.vue)
  - ProductCard (src/components/product/ProductCard.vue)
  - ProductView (src/views/ProductView.vue)
  - OrdersView (src/views/account/OrdersView.vue)
Ancestors (6): CartView, CartItem, HomeView, ProductCard, ProductView, OrdersView
Loaded by modules (1): src/router.ts
Paths:
  src/router.ts → CartView → CartItem → PriceTag
  src/router.ts → HomeView → ProductCard → PriceTag
  src/router.ts → ProductView → PriceTag
  src/router.ts → OrdersView → PriceTag
Pages (4):
  /                HomeView
  /products/:id    ProductView
  /cart            CartView
  /account/orders  OrdersView
```

## What it detects

### Dependencies between components

| Pattern | Example |
|---|---|
| Relative and aliased imports | `import Foo from './Foo.vue'`, tsconfig `paths`, `resolve.alias` written as literals in `vite.config` / `vue.config` / webpack configs, `@/` `~/`, and webpack-style paths that start with a project directory (`src/components/Foo`) |
| Template tags | `<FooBar>`, `<foo-bar>`, `<component :is="cond ? A : B">` |
| Options API | `components: { Foo }` |
| Lazy loading | `defineAsyncComponent(() => import('./Foo.vue'))`, `const Foo = () => import('./Foo.vue')`, ``import(`./pages/${name}.vue`)`` (matching files), webpack's `require()` / `require.ensure` |
| Global registration | `app.component('Foo', Foo)`, `app.component(Foo.name, Foo)` with `defineOptions({ name })`, `as` casts. Resolved before a component's own file name, as Vue does |
| `resolveComponent` | `resolveComponent('Foo')` counts as using `<Foo>` |
| Auto-imports | `components.d.ts` from unplugin-vue-components / Nuxt; without it, unplugin-vue-components' default naming (file names under `src/components`) |
| Nuxt `components/` | Resolved with Nuxt's naming rules even without `.nuxt/` (`user/Card.vue` → `<UserCard>`, `global/Badge.vue` → `<Badge>`, `Lazy` prefix, imports from `#components`), including layers in the repository (`extends: ['./layers/x']`, `layers/*`) |
| Nuxt Content | Components used from `content/**/*.md` (in layers too) with MDC syntax (`::read-more`, `:kbd[Ctrl]`), linked to the pages that render content with `<ContentRenderer>`; `components/content/` is named without the directory, and `pathPrefix: false` in the `components` setting is honored |
| nuxt-og-image | `defineOgImage('Name')` / `defineOgImageComponent('Name')` and the default in `nuxt.config` |
| Barrels | `export { default as Foo } from './Foo.vue'`, `export const Foo = withInstall(foo)`, `export const Layout = () => import('./Layout.vue')`. `Foo/index.ts` wins over `Foo/index.vue`, as in Vite |
| `import.meta.glob` | Files matched by `import.meta.glob('/src/views/**/*.vue')` or webpack's `require.context()` count as used; their pages are decided at runtime |
| VitePress | Components imported or used in Markdown pages, and the theme in `.vitepress/theme` |
| Recursion | A component that renders itself by its file name |

Tags with a UI library's prefix (`QBtn` for Quasar, `UButton` for Nuxt UI, `VBtn` for Vuetify, `ElButton`, `NButton`, …) are attributed to that library when it is a dependency. Components written in JSX / TSX are not analyzed, but are shown with their file (`Badge (src/components/Badge/badge.tsx)`). Tags that can't be resolved at all — registered by a plugin, or a missing import — are listed separately from library components.

Dependencies that are imported but not rendered in the template (route definitions, `h()`, via variables, and so on) are shown separately as "import only". Named imports from a `.vue` file (such as exported types) are not component dependencies, though `--since` still follows them. Modules such as `main.ts` and `router.ts` that import `.vue` files also appear as nodes.

Components are named the way Vue resolves them: `SvgIcon/index.vue` is `SvgIcon`, and Nuxt's `components/user/Card.vue` is `UserCard`. When two components share a name, the output adds directories to tell them apart (`a/Item`, `b/Item`). With file-based routing, pages are shown by path (`pages/users/[id]`).

### Pages (routes)

- **vue-router**: nested `children`, named views (`components: { default, side }`), dynamic routes built with `.map()` and the like, and route components imported from other modules. A child with an empty path stands for its parent's URL. Routes that only render a shared layout — a parent with `redirect`, a parent whose component wraps several route trees in the default view (the admin-template `Layout`), or a menu entry that points at the layout — and external links (`path: 'https://...'`) are not counted as pages. A parent whose children only fill named views (a list page with a dialog route) is a page
- **Nuxt**: file-based routing in `pages/` (`[id]`, `[[id]]`, `[...slug]`, `(group)`), including layers, and `definePageMeta({ path, alias })`. `settings.vue` with `settings/index.vue` is one page, `/settings`. Each page gets the layout it selects with `definePageMeta({ layout })` — matched by Nuxt's layout names (`layouts/AuthPage.vue` is `auth-page`) — or `<NuxtLayout name>`; `default` otherwise, none for `layout: false`
- Route paths built from string constants (`` `${BASE}/users` ``, also imported ones) are filled in, and `alias` is shown
- When the same path is defined more than once (modules that each define `/`), the defining file is shown
- **Shared by all pages**: everything reachable from the main `createApp(App)` (also `createApp({ render: () => h(App) })` and Vue 2's `new Vue({ render })`) and Nuxt's `app.vue`. A second `createApp` (a dev panel, say) is a separate app. Some of these may only appear conditionally

### Structural issues

- Unused components (not used from anywhere)
- Circular references
- Where external components (from libraries, outside the analysis) are used

## Viewer controls

| Action | What it does |
|---|---|
| Hover / click | Highlights the component's ancestors and descendants. In large projects, clicking a component shows its neighborhood |
| Details panel | Components that use it, components it uses, pages it appears on, external components |
| "Show descendants only" / "Show users" / "Show neighborhood" | Narrows the graph to that scope (the neighborhood is 1–4 steps up and down; change it with − / +). Summary counts are recalculated for the narrowed scope |
| Pages tab | Pick a page to see only the components on it (components on every page are left out and counted in the bar) |
| "Hide widely used parts" | Components used by many others (buttons, …) are not drawn; their users show `+N` instead |
| "Group by directory" | Each directory becomes one box, with edge thickness showing how many dependencies cross; click a box to open it. Pages and neighborhoods with more than 150 components are grouped too |
| "Open in VS Code" | Opens the file in your editor |
| Tabs | Overview (unused, cycles, …) / List (sortable by parents, children, lines) / Pages (screen and component count per route) |
| `/` | Search |
| `F` | Fit the whole graph |
| Drag / pinch or Ctrl+wheel | Pan / zoom |
| `Esc` | Clear selection and filters |

Projects with more than 150 components open grouped by directory, with widely used parts hidden and the Pages tab selected, because drawing everything at once is unreadable at that size. Colors follow directories (atoms / molecules / organisms, …). The legend starts folded so it doesn't cover nodes.

The "日本語" / "English" button switches the language, and the choice is remembered. Light and dark mode follow your OS setting.

## Options

```
vue-component-graph [dir] [options]
```

| Option | Description |
|---|---|
| `-o, --out <file>` | Where to write the HTML |
| `--focus <name>` | Show only the given component and its descendants (also prints its details) |
| `--who-uses <name>` | Show only the components that use the given component (also prints them) |
| `--since <ref>` | Show components and pages affected by changes since the git `ref` |
| `--externals` | Also show external components (from libraries) as nodes |
| `--json` | Print JSON to stdout instead of writing HTML |
| `--routes` | Also print the pages (routes) |
| `--no-open` | Don't open the browser after generating |
| `--lang <ja\|en>` | Output language (default: `VUE_COMPONENT_GRAPH_LANG`, then `LANG`) |

`vue-component-graph mcp [--root <dir>] [--lang <ja|en>]` starts the MCP server (stdio).

`<name>` is a component name (`AppHeader`, `app-header`) or the end of a path (`nav/NavLink`). If several components match, the candidates are printed and the command exits; if none match, similar names are suggested.

Results go to stdout and errors to stderr, so `npx vue-component-graph --since main > impact.txt` works.

## JSON output

`--json` prints the following shape (to the `-o` file if given). Use it with CI or other tools.

```ts
{
  root: string
  nodes: {
    id: string            // path relative to root
    name: string          // component name (Foo/index.vue → Foo); path for modules
    label: string         // display name; adds directories when names collide
    registeredAs?: string[] // names it is globally registered under (app.component('XButton', Button))
    kind: 'component' | 'module' | 'external'
    group: string         // directory directly under src/
    entry: boolean        // rendered directly by the framework (App.vue, file-based pages/ and layouts/, VitePress pages)
    lines: number
    externals: string[]   // "Name (package or file)" for libraries and JSX/TSX; just "Name" when unresolved
    routes: number[]      // pages it appears on (indices into routes)
    shell: boolean        // shared by all pages
  }[]
  edges: { from: string; to: string; type: 'template' | 'script'; async: boolean }[]
  routes: {
    path: string
    dynamic: boolean      // path is an expression; the real URL is decided at runtime
    view: string          // main screen
    layouts: string[]     // screens of parent routes
    chain: string[]       // every route component rendered for this route
    source: string        // file that defines the route
    aliases?: string[]    // other URLs for the same route
  }[]
  orphans: string[]
  cycles: string[][]
  recursive: string[]
  entries: string[]       // modules that call createApp()
  warnings: string[]
  unsupportedPagesDir?: string  // file-based routing directory that can't be read yet
  vitepress?: boolean           // VitePress site: pages are Markdown, routes aren't listed
  unresolvedImports: { from: string; spec: string }[]  // project imports that couldn't be resolved
  workspacePackages?: string[]  // when run at a monorepo root: packages that contain .vue files
  impact?: {
    since: string; changed: string[]; deleted: string[]; unlinked: string[]; projectWide: string[]
    affected: string[]; routes: number[]; everywhere: boolean
  }
}
```

## Limitations

This is static analysis, so anything decided only at runtime is unknown.

- **Dynamic routes**: a route whose `path` is an expression (e.g. `` `/x/${id}` ``) counts as one route. How many real URLs it produces is unknown
- **Render functions**: components rendered with `h()` or JSX / TSX are not detected as template dependencies (if imported, they show up as "import only"), and JSX / TSX files are not analyzed
- **File-based routing in Vite**: no routes are built from `src/pages/` for vue-router's Vite plugin (formerly unplugin-vue-router) or vite-plugin-pages. The output says so, and the page and layout components themselves are still analyzed and are not reported as unused
- **Routes from the server**: screens loaded through `import.meta.glob` for routes built at runtime are counted as used, but which pages they appear on is unknown
- **VitePress**: routes aren't listed. Components used from Markdown are analyzed
- **Monorepos**: run it in each package. Imports from other packages are not seen, so a component used only by another package is reported as unused. Run at a monorepo root, it says so and lists the packages
- **Aliases built by code**: aliases in bundler configs are read only when written as literals (`path.resolve(__dirname, 'src')`, `fileURLToPath(new URL(...))`); ones returned by a helper function aren't. Imports that can't be resolved are listed, and answers say the analysis is incomplete, since they can make used components look unused
- **Dynamic names**: components chosen by a runtime string (`resolveComponent(name)`, `h(componentMap[type])`) and routes whose component is a factory call (`createListView('top')`) can't be followed; the latter are reported as warnings
- **Skipped files**: `node_modules`, `.nuxt`, `__tests__` and the like anywhere; `dist`, `build`, `test`, `tests`, `e2e`, `coverage`, … only at the project root; and `*.spec.*`, `*.test.*`, `*.stories.*`, `*.story.*`, histoire/vitest setup files
- **Nuxt layers outside the repository** (npm packages, `github:`) aren't analyzed; a warning says which
- **Vue 2**: analyzed with Vue 3's SFC compiler. Results are usable, but syntax Vue 3 dropped (such as `<template functional>`) shows up as analysis warnings
- **`components.d.ts` not committed**: auto-imports from unplugin-vue-components are read from the `components.d.ts` the dev server generates; if it isn't in the repository they can't be resolved. Entries pointing at files that no longer exist are reported as warnings. Nuxt is inferred from `components/` even without `.nuxt/`, but extra directories added in `nuxt.config` are resolved only after `nuxi prepare` (a warning says so)
- **Plugin registration**: components registered globally by plugins (`RouterView`, …) are treated as external components
- **Template languages**: templates in pug and the like are not analyzed
- **Composables**: composables are not nodes in the graph (impact analysis does follow them)

## Development

```sh
npm install        # prepare also builds dist/
npm test           # vitest
npm run typecheck
npm run demo       # analyze examples/shop and open it
npm link           # use it as the vue-component-graph command
```

`examples/shop` (in the repository, not in the npm package) is a fictional shop app used for the README screenshots.

## License

[MIT](LICENSE)
