;(() => {
  'use strict'

  const DATA = JSON.parse(document.getElementById('graph-data').textContent)
  const SVG_NS = 'http://www.w3.org/2000/svg'
  const $ = (id) => document.getElementById(id)

  const NODE_H = 28
  const PAD_X = 12
  const BAR_W = 4
  const WARN_W = 20
  const GAP_X = 80
  const GAP_Y = 10
  const DUMMY_GAP = 6

  // ---------- 全体グラフの索引（フィルタに依存しない） ----------
  const nodeById = new Map(DATA.nodes.map((n) => [n.id, n]))
  const cycleOf = new Map()
  DATA.cycles.forEach((c, i) => c.forEach((id) => cycleOf.set(id, i)))
  const orphanSet = new Set(DATA.orphans)
  const IMPACT = DATA.impact || null
  const changedSet = new Set(IMPACT ? IMPACT.changed : [])
  const affectedSet = new Set(IMPACT ? IMPACT.affected : [])
  const recursiveSet = new Set(DATA.recursive)
  const parentsOf = new Map(DATA.nodes.map((n) => [n.id, []]))
  const childrenOf = new Map(DATA.nodes.map((n) => [n.id, []]))
  for (const e of DATA.edges) {
    if (e.from === e.to) continue
    childrenOf.get(e.from).push(e)
    parentsOf.get(e.to).push(e)
  }

  // グループ色は全体の件数順で固定する（絞り込んでも塗り直さない）
  const groupCounts = new Map()
  for (const n of DATA.nodes) {
    if (n.kind === 'component') groupCounts.set(n.group, (groupCounts.get(n.group) || 0) + 1)
  }
  const groupOrder = [...groupCounts.keys()].sort(
    (a, b) => groupCounts.get(b) - groupCounts.get(a) || a.localeCompare(b),
  )
  const groupColor = new Map(groupOrder.slice(0, 8).map((g, i) => [g, `var(--series-${i + 1})`]))
  const colorOf = (n) =>
    n.kind === 'component' ? groupColor.get(n.group) || 'var(--text-muted)' : 'var(--text-muted)'

  const state = {
    showScript: true,
    showModules: true,
    showImpact: !!IMPACT,
    focus: null, // { id, dir: 'down' | 'up' }
    selected: null,
    hover: null,
    query: '',
    tab: 'overview',
    sort: { key: 'children', desc: true },
    view: { x: 0, y: 0, k: 1 },
  }

  let current = { nodes: [], edges: [], pos: new Map() }

  // ---------- 表示対象の計算 ----------
  function reach(start, edges, dir) {
    const keep = new Set([start])
    const queue = [start]
    while (queue.length) {
      const cur = queue.shift()
      for (const e of edges) {
        const a = dir === 'down' ? e.from : e.to
        const b = dir === 'down' ? e.to : e.from
        if (a === cur && !keep.has(b)) {
          keep.add(b)
          queue.push(b)
        }
      }
    }
    return keep
  }

  function visibleGraph() {
    let nodes = DATA.nodes.filter((n) => state.showModules || n.kind !== 'module')
    const ids = new Set(nodes.map((n) => n.id))
    let edges = DATA.edges.filter(
      (e) => ids.has(e.from) && ids.has(e.to) && (state.showScript || e.type === 'template'),
    )
    if (state.focus && !ids.has(state.focus.id)) state.focus = null
    if (state.focus) {
      const keep = reach(state.focus.id, edges, state.focus.dir)
      nodes = nodes.filter((n) => keep.has(n.id))
      edges = edges.filter((e) => keep.has(e.from) && keep.has(e.to))
    }
    return { nodes, edges }
  }

  // ---------- 階層レイアウト（左 → 右） ----------
  const measureCtx = document.createElement('canvas').getContext('2d')
  function textWidth(text, mono) {
    measureCtx.font = mono
      ? '400 11.5px ui-monospace, "SF Mono", Menlo, monospace'
      : '500 12px system-ui, -apple-system, "Segoe UI", sans-serif'
    return measureCtx.measureText(text).width
  }

  function nodeWidth(n) {
    let w = BAR_W + PAD_X * 2 + textWidth(n.name, n.kind === 'module')
    if (orphanSet.has(n.id)) w += WARN_W
    return Math.ceil(w)
  }

  function layout(nodes, edges) {
    const ids = nodes.map((n) => n.id)
    const out = new Map(ids.map((id) => [id, []]))
    for (const e of edges) if (e.from !== e.to) out.get(e.from).push(e.to)

    // 1. DFS で後退辺を見つけ、向きを反転して DAG にする
    const indeg = new Map(ids.map((id) => [id, 0]))
    for (const e of edges) if (e.from !== e.to) indeg.set(e.to, indeg.get(e.to) + 1)
    const starts = [...ids].sort((a, b) => {
      const ka = nodeById.get(a).kind === 'module' ? 0 : indeg.get(a) === 0 ? 1 : 2
      const kb = nodeById.get(b).kind === 'module' ? 0 : indeg.get(b) === 0 ? 1 : 2
      return ka - kb
    })
    const mark = new Map()
    const back = new Set()
    const dfs = (v) => {
      mark.set(v, 1)
      for (const w of out.get(v)) {
        const m = mark.get(w) || 0
        if (m === 1) back.add(v + '\0' + w)
        else if (m === 0) dfs(w)
      }
      mark.set(v, 2)
    }
    for (const id of starts) if (!mark.has(id)) dfs(id)

    const dag = []
    for (const e of edges) {
      if (e.from === e.to) continue
      const rev = back.has(e.from + '\0' + e.to)
      dag.push({ from: rev ? e.to : e.from, to: rev ? e.from : e.to, edge: e, rev })
    }

    // 2. 最長路でランク付け
    const rank = new Map(ids.map((id) => [id, 0]))
    const din = new Map(ids.map((id) => [id, 0]))
    const dout = new Map(ids.map((id) => [id, []]))
    for (const d of dag) {
      din.set(d.to, din.get(d.to) + 1)
      dout.get(d.from).push(d.to)
    }
    const queue = starts.filter((id) => din.get(id) === 0)
    while (queue.length) {
      const v = queue.shift()
      for (const w of dout.get(v)) {
        rank.set(w, Math.max(rank.get(w), rank.get(v) + 1))
        din.set(w, din.get(w) - 1)
        if (din.get(w) === 0) queue.push(w)
      }
    }

    // 3. 2 層以上またぐ辺にダミーノードを挟む
    const items = new Map()
    const layers = []
    const put = (item) => {
      items.set(item.id, item)
      ;(layers[item.layer] ||= []).push(item)
    }
    for (const n of nodes) {
      put({ id: n.id, layer: rank.get(n.id), w: nodeWidth(n), h: NODE_H, dummy: false, up: [], down: [] })
    }
    let dummySeq = 0
    for (const d of dag) {
      const chain = [d.from]
      for (let l = rank.get(d.from) + 1; l < rank.get(d.to); l++) {
        const id = `\0d${dummySeq++}`
        put({ id, layer: l, w: 0, h: 0, dummy: true, up: [], down: [] })
        chain.push(id)
      }
      chain.push(d.to)
      for (let i = 0; i < chain.length - 1; i++) {
        items.get(chain[i]).down.push(chain[i + 1])
        items.get(chain[i + 1]).up.push(chain[i])
      }
      d.chain = chain
    }
    for (let l = 0; l < layers.length; l++) layers[l] ||= []

    // 4. 重心法で層内の順序を決める
    const order = new Map()
    const reindex = (layer) => layer.forEach((it, i) => order.set(it.id, i))
    layers.forEach(reindex)
    for (let iter = 0; iter < 12; iter++) {
      const downward = iter % 2 === 0
      const seq = downward
        ? layers.map((_, i) => i).slice(1)
        : layers.map((_, i) => i).reverse().slice(1)
      for (const l of seq) {
        const layer = layers[l]
        const bary = new Map()
        for (const it of layer) {
          const nb = downward ? it.up : it.down
          bary.set(it.id, nb.length ? nb.reduce((s, id) => s + order.get(id), 0) / nb.length : order.get(it.id))
        }
        layer.sort((a, b) => bary.get(a.id) - bary.get(b.id))
        reindex(layer)
      }
    }

    // 5. x 座標（層ごとに左揃え）
    const layerX = []
    const layerW = []
    let x = 0
    for (let l = 0; l < layers.length; l++) {
      layerX[l] = x
      layerW[l] = Math.max(0, ...layers[l].map((it) => it.w))
      x += layerW[l] + GAP_X
    }

    // 6. y 座標：隣接層の平均に寄せ、重なりは前後からの押し出しの平均で解消
    const y = new Map()
    const sep = (a, b) => (a.h + b.h) / 2 + (a.dummy || b.dummy ? DUMMY_GAP : GAP_Y)
    for (const layer of layers) {
      let cy = 0
      layer.forEach((it, i) => {
        if (i > 0) cy += sep(layer[i - 1], it)
        y.set(it.id, cy)
      })
    }
    const place = (layer, desired) => {
      const n = layer.length
      const f = new Array(n)
      const b = new Array(n)
      for (let i = 0; i < n; i++) f[i] = i ? Math.max(desired[i], f[i - 1] + sep(layer[i - 1], layer[i])) : desired[i]
      for (let i = n - 1; i >= 0; i--) {
        b[i] = i < n - 1 ? Math.min(desired[i], b[i + 1] - sep(layer[i], layer[i + 1])) : desired[i]
      }
      layer.forEach((it, i) => y.set(it.id, (f[i] + b[i]) / 2))
    }
    for (let iter = 0; iter < 10; iter++) {
      const downward = iter % 2 === 0
      const seq = downward ? layers.map((_, i) => i) : layers.map((_, i) => i).reverse()
      for (const l of seq) {
        const layer = layers[l]
        const desired = layer.map((it) => {
          const nb = (downward ? it.up : it.down).concat(iter > 5 ? (downward ? it.down : it.up) : [])
          return nb.length ? nb.reduce((s, id) => s + y.get(id), 0) / nb.length : y.get(it.id)
        })
        place(layer, desired)
      }
    }
    const minY = Math.min(...[...items.values()].map((it) => y.get(it.id) - it.h / 2))

    const pos = new Map()
    for (const it of items.values()) {
      pos.set(it.id, { x: layerX[it.layer], y: y.get(it.id) - minY + NODE_H / 2, w: it.w, h: it.h, layerW: layerW[it.layer], dummy: it.dummy })
    }

    // 7. 辺の経路
    const paths = []
    for (const d of dag) {
      const pts = []
      d.chain.forEach((id, i) => {
        const p = pos.get(id)
        if (i === 0) pts.push([p.x + p.w, p.y])
        else if (i === d.chain.length - 1) pts.push([p.x - 1, p.y])
        else pts.push([p.x, p.y], [p.x + p.layerW, p.y])
      })
      let path = `M${pts[0][0]},${pts[0][1]}`
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1]
        const [bx, by] = pts[i]
        if (i % 2 === 0) path += ` L${bx},${by}` // ダミー内は直線
        else {
          const dx = (bx - ax) / 2
          path += ` C${ax + dx},${ay} ${bx - dx},${by} ${bx},${by}`
        }
      }
      paths.push({ edge: d.edge, d: path, rev: d.rev })
    }
    for (const e of edges) {
      if (e.from !== e.to) continue
      const p = pos.get(e.from)
      const rx = p.x + p.w - 14
      const ty = p.y - NODE_H / 2
      paths.push({ edge: e, d: `M${rx},${ty} C${rx},${ty - 22} ${p.x + p.w + 22},${p.y - 8} ${p.x + p.w + 1},${p.y - 3}`, rev: false })
    }
    return { pos, paths }
  }

  // ---------- 描画 ----------
  const svg = $('canvas')
  const viewport = $('viewport')
  const gEdges = $('edges')
  const gNodes = $('nodes')

  function el(tag, attrs, parent) {
    const e = document.createElementNS(SVG_NS, tag)
    for (const k in attrs) e.setAttribute(k, attrs[k])
    if (parent) parent.appendChild(e)
    return e
  }

  function render(fit) {
    const { nodes, edges } = visibleGraph()
    const { pos, paths } = layout(nodes, edges)
    current = { nodes, edges, pos }
    gEdges.textContent = ''
    gNodes.textContent = ''

    for (const p of paths) {
      const e = p.edge
      const cyc = e.from !== e.to && cycleOf.has(e.from) && cycleOf.get(e.from) === cycleOf.get(e.to)
      const cls = ['edge', e.type === 'script' ? 'script' : '', e.async ? 'async' : '', cyc ? 'cycle' : '']
      const path = el('path', { d: p.d, class: cls.filter(Boolean).join(' ') }, gEdges)
      path.dataset.from = e.from
      path.dataset.to = e.to
      path.dataset.cycle = cyc ? '1' : ''
      path.setAttribute(p.rev ? 'marker-start' : 'marker-end', cyc ? 'url(#arrow-cycle)' : 'url(#arrow)')
    }

    for (const n of nodes) {
      const p = pos.get(n.id)
      const g = el('g', { class: `node ${n.kind}`, transform: `translate(${p.x},${p.y - NODE_H / 2})` }, gNodes)
      g.dataset.id = n.id
      if (cycleOf.has(n.id)) g.classList.add('cycle')
      if (changedSet.has(n.id)) g.classList.add('changed')
      else if (affectedSet.has(n.id)) g.classList.add('affected')
      el('rect', { class: 'box', width: p.w, height: NODE_H, rx: 6 }, g)
      if (n.kind === 'component') {
        el('rect', { class: 'bar', x: 0.5, y: 0.5, width: BAR_W, height: NODE_H - 1, rx: 2, fill: colorOf(n) }, g)
      }
      const t = el('text', { x: BAR_W + PAD_X, y: NODE_H / 2 }, g)
      t.textContent = n.name
      if (orphanSet.has(n.id)) {
        const cx = p.w - PAD_X - 6
        el('circle', { class: 'warn', cx, cy: NODE_H / 2, r: 6.5 }, g)
        const m = el('text', { class: 'warn-mark', x: cx, y: NODE_H / 2 + 0.5 }, g)
        m.textContent = '!'
      }
    }

    renderLegend(nodes)
    renderFocusBar(nodes)
    applyHighlight()
    renderSide()
    if (fit) fitView()
  }

  function applyHighlight() {
    const target = state.hover || state.selected
    const visible = new Set(current.nodes.map((n) => n.id))
    let lit = null
    if (target && visible.has(target)) {
      const up = reach(target, current.edges, 'up')
      const down = reach(target, current.edges, 'down')
      lit = { nodes: new Set([...up, ...down]), up, down }
    }
    const q = state.query.trim()
    const matches = q ? new Set(searchNodes(q).map((n) => n.id)) : null
    // 何も選んでいないときは、変更の影響を受ける範囲を強調する
    if (!lit && !matches && state.showImpact && IMPACT) {
      const set = new Set([...affectedSet, ...changedSet])
      lit = { nodes: set, up: set, down: new Set() }
    }

    svg.classList.toggle('impact-on', state.showImpact && !!IMPACT)
    svg.classList.toggle('dim', !!lit || !!(matches && matches.size))
    for (const g of gNodes.children) {
      const id = g.dataset.id
      g.classList.toggle('selected', id === state.selected)
      g.classList.toggle('match', !!matches && matches.has(id))
      g.classList.toggle('lit', lit ? lit.nodes.has(id) : !!matches && matches.has(id))
    }
    for (const p of gEdges.children) {
      const { from, to } = p.dataset
      const hi = !!lit && ((lit.up.has(from) && lit.up.has(to)) || (lit.down.has(from) && lit.down.has(to)))
      p.classList.toggle('hi', hi)
      const marker = p.dataset.cycle ? 'url(#arrow-cycle)' : hi ? 'url(#arrow-hi)' : 'url(#arrow)'
      p.setAttribute(p.hasAttribute('marker-start') ? 'marker-start' : 'marker-end', marker)
    }
  }

  // ---------- パン・ズーム ----------
  function applyView() {
    const { x, y, k } = state.view
    viewport.setAttribute('transform', `translate(${x},${y}) scale(${k})`)
  }

  function fitView() {
    const box = viewport.getBBox()
    const r = svg.getBoundingClientRect()
    if (!box.width || !r.width) return
    const pad = 40
    const k = Math.min(1.25, (r.width - pad * 2) / box.width, (r.height - pad * 2) / box.height)
    state.view = {
      k,
      x: (r.width - box.width * k) / 2 - box.x * k,
      y: (r.height - box.height * k) / 2 - box.y * k,
    }
    applyView()
  }

  function centerOn(id) {
    const p = current.pos.get(id)
    if (!p) return
    const r = svg.getBoundingClientRect()
    const k = Math.max(state.view.k, 0.9)
    state.view = { k, x: r.width / 2 - (p.x + p.w / 2) * k, y: r.height / 2 - p.y * k }
    applyView()
  }

  function zoomAt(factor, cx, cy) {
    const v = state.view
    const k = Math.min(4, Math.max(0.08, v.k * factor))
    v.x = cx - ((cx - v.x) * k) / v.k
    v.y = cy - ((cy - v.y) * k) / v.k
    v.k = k
    applyView()
  }

  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const r = svg.getBoundingClientRect()
      // ピンチ（ctrlKey）や行単位のホイールはズーム、トラックパッドのスクロールはパン
      if (e.ctrlKey || e.metaKey || e.deltaMode === 1) {
        const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
        zoomAt(Math.exp(-dy * 0.01), e.clientX - r.left, e.clientY - r.top)
      } else {
        state.view.x -= e.deltaX
        state.view.y -= e.deltaY
        applyView()
      }
    },
    { passive: false },
  )

  let drag = null
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    drag = { x: e.clientX, y: e.clientY, moved: false, node: e.target.closest('.node') }
    try {
      svg.setPointerCapture(e.pointerId)
    } catch {}
  })
  svg.addEventListener('pointermove', (e) => {
    if (drag) {
      const dx = e.clientX - drag.x
      const dy = e.clientY - drag.y
      if (!drag.moved && Math.hypot(dx, dy) < 4) return
      drag.moved = true
      svg.classList.add('panning')
      state.view.x += dx
      state.view.y += dy
      drag.x = e.clientX
      drag.y = e.clientY
      applyView()
      hideTooltip()
      return
    }
    const g = e.target.closest('.node')
    const id = g ? g.dataset.id : null
    if (id !== state.hover) {
      state.hover = id
      applyHighlight()
    }
    if (id) showTooltip(id, e)
    else hideTooltip()
  })
  svg.addEventListener('pointerup', () => {
    if (drag && !drag.moved) select(drag.node ? drag.node.dataset.id : null)
    drag = null
    svg.classList.remove('panning')
  })
  svg.addEventListener('pointerleave', () => {
    if (drag) return
    state.hover = null
    hideTooltip()
    applyHighlight()
  })
  window.addEventListener('resize', () => applyView())

  // ---------- ツールチップ ----------
  const tooltip = $('tooltip')
  function showTooltip(id, e) {
    const n = nodeById.get(id)
    const meta = [`親 ${parentsOf.get(id).length}`, `子 ${childrenOf.get(id).length}`]
    if (n.lines) meta.push(`${n.lines} 行`)
    tooltip.innerHTML =
      `<div class="t-name">${esc(n.name)}</div><div class="t-path">${esc(n.id)}</div>` +
      `<div class="t-meta">${meta.join(' · ')}</div>` +
      statusHtml(id)
    tooltip.hidden = false
    const main = svg.parentElement.getBoundingClientRect()
    const x = e.clientX - main.left + 14
    const y = e.clientY - main.top + 14
    const tw = tooltip.offsetWidth
    tooltip.style.left = Math.min(x, svg.clientWidth - tw - 8) + 'px'
    tooltip.style.top = y + 'px'
  }
  function hideTooltip() {
    tooltip.hidden = true
  }

  // ---------- 凡例 ----------
  function renderLegend(nodes) {
    const groups = new Set(nodes.filter((n) => n.kind === 'component').map((n) => n.group))
    const rows = groupOrder
      .filter((g) => groups.has(g))
      .slice(0, 8)
      .map((g) => `<div class="row"><span class="swatch" style="background:${groupColor.get(g)}"></span>${esc(g)}</div>`)
    if (groupOrder.length > 8 && groupOrder.slice(8).some((g) => groups.has(g))) {
      rows.push('<div class="row"><span class="swatch" style="background:var(--text-muted)"></span>その他</div>')
    }
    const line = (cls, label) =>
      `<div class="row"><svg width="28" height="10"><path d="M1,5 L27,5" class="edge ${cls}"></path></svg>${label}</div>`
    $('legend').innerHTML =
      rows.join('') +
      '<div class="sep"></div>' +
      line('', 'template で描画') +
      line('script', 'import のみ') +
      line('async', '遅延読み込み') +
      (DATA.cycles.length ? line('cycle', '循環') : '') +
      (DATA.orphans.length ? '<div class="row"><span class="status-icon warning">!</span>未使用</div>' : '') +
      (IMPACT && state.showImpact
        ? '<div class="sep"></div>' +
          '<div class="row"><span class="swatch impact-changed"></span>変更したファイル</div>' +
          '<div class="row"><span class="swatch impact-affected"></span>影響を受ける</div>'
        : '')
  }

  function renderFocusBar(nodes) {
    const bar = $('focus-bar')
    if (!state.focus) {
      bar.hidden = true
      return
    }
    const n = nodeById.get(state.focus.id)
    const what = state.focus.dir === 'down' ? '配下（使っているもの）' : '使っている側'
    bar.hidden = false
    bar.innerHTML = `<span><strong>${esc(n.name)}</strong> の${what}を表示中（${nodes.length - 1} 件）</span><button type="button" data-unfocus>全体に戻す</button>`
  }

  // ---------- サイドパネル ----------
  const side = $('side')

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
  }

  function statusHtml(id) {
    const s = []
    if (orphanSet.has(id)) s.push('<span class="status"><span class="status-icon warning">!</span>未使用</span>')
    if (cycleOf.has(id)) s.push('<span class="status"><span class="status-icon critical">↻</span>循環</span>')
    if (recursiveSet.has(id)) s.push('<span class="status"><span class="status-icon warning">↺</span>再帰</span>')
    return s.length ? `<div>${s.join('')}</div>` : ''
  }

  function nodeItem(id, tags = []) {
    const n = nodeById.get(id)
    const t = tags.map((x) => `<span class="tag">${x}</span>`).join('')
    return `<li class="link" data-select="${esc(id)}" title="${esc(id)}"><span class="dot" style="background:${colorOf(n)}"></span>${esc(n.name)}${t}</li>`
  }

  function edgeTags(e) {
    const t = []
    if (e.type === 'script') t.push('import のみ')
    if (e.async) t.push('async')
    return t
  }

  function renderSide() {
    if (state.selected && nodeById.has(state.selected)) return renderDetail(state.selected)
    const tabs =
      '<div class="tabs" role="tablist">' +
      `<button type="button" role="tab" data-tab="overview" aria-selected="${state.tab === 'overview'}">概要</button>` +
      `<button type="button" role="tab" data-tab="list" aria-selected="${state.tab === 'list'}">一覧</button>` +
      `<button type="button" role="tab" data-tab="pages" aria-selected="${state.tab === 'pages'}">ページ（${DATA.routes.length}）</button>` +
      '</div>'
    const body = state.tab === 'list' ? listHtml() : state.tab === 'pages' ? pagesHtml() : overviewHtml()
    side.innerHTML = tabs + body
  }

  /** 表示中の範囲（絞り込み・表示切り替えを反映） */
  function scope() {
    const ids = new Set(current.nodes.map((n) => n.id))
    const realEdges = (edges) => edges.filter((e) => e.from !== e.to)
    return {
      ids,
      nodes: current.nodes,
      components: current.nodes.filter((n) => n.kind === 'component'),
      edges: realEdges(current.edges),
      orphans: DATA.orphans.filter((id) => ids.has(id)),
      cycles: DATA.cycles.filter((c) => c.every((id) => ids.has(id))),
      recursive: DATA.recursive.filter((id) => ids.has(id)),
      total: {
        components: DATA.nodes.filter((n) => n.kind === 'component').length,
        edges: realEdges(DATA.edges).length,
        orphans: DATA.orphans.length,
        cycles: DATA.cycles.length,
      },
    }
  }

  function overviewHtml() {
    const sc = scope()
    const kpi = (v, total, k) => {
      const of = v !== total ? `<span class="of"> / 全体 ${total}</span>` : ''
      return `<div class="kpi"><div class="v">${v}${of}</div><div class="k">${k}</div></div>`
    }
    let h = impactHtml()
    if (state.focus) {
      const n = nodeById.get(state.focus.id)
      const what = state.focus.dir === 'down' ? 'の配下' : 'を使っている側'
      h += `<p class="scope">表示中の範囲：<strong>${esc(n.name)}</strong> ${what}</p>`
    }
    h += '<div class="kpis">'
    h += kpi(sc.components.length, sc.total.components, 'コンポーネント')
    h += kpi(sc.edges.length, sc.total.edges, '依存')
    h += kpi(sc.orphans.length, sc.total.orphans, '未使用')
    h += kpi(sc.cycles.length, sc.total.cycles, '循環')
    h += '</div>'

    h += '<h3>未使用のコンポーネント</h3>'
    h += sc.orphans.length
      ? `<ul>${sc.orphans.map((id) => nodeItem(id)).join('')}</ul>`
      : '<p class="empty">なし</p>'

    h += '<h3>循環参照</h3>'
    h += sc.cycles.length
      ? sc.cycles.map((c) => `<ul>${c.map((id) => nodeItem(id)).join('')}</ul>`).join('<div style="height:8px"></div>')
      : '<p class="empty">なし</p>'

    if (sc.recursive.length) {
      h += '<h3>再帰コンポーネント</h3>'
      h += `<ul>${sc.recursive.map((id) => nodeItem(id)).join('')}</ul>`
    }

    const ext = new Map()
    for (const n of sc.nodes) for (const x of n.externals) ext.set(x, (ext.get(x) || 0) + 1)
    if (ext.size) {
      h += '<h3>外部コンポーネント（使用ファイル数）</h3><ul>'
      h += [...ext]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 20)
        .map(([name, c]) => `<li>${esc(name)}<span class="tag">${c}</span></li>`)
        .join('')
      h += '</ul>'
    }

    if (DATA.warnings.length) {
      h += `<h3>解析の警告（${DATA.warnings.length}）</h3><ul class="warnings">`
      h += DATA.warnings.map((w) => `<li>${esc(w)}</li>`).join('')
      h += '</ul>'
    }
    return h
  }

  function listHtml() {
    const sc = scope()
    const rows = sc.components.map((n) => ({ n, parents: parentsOf.get(n.id).length, children: childrenOf.get(n.id).length, lines: n.lines }))
    const { key, desc } = state.sort
    rows.sort((a, b) => {
      const v = key === 'name' ? a.n.name.localeCompare(b.n.name) : a[key] - b[key]
      return (desc ? -v : v) || a.n.name.localeCompare(b.n.name)
    })
    const th = (k, label, num) => {
      const arrow = key === k ? (desc ? ' ↓' : ' ↑') : ''
      return `<th class="${num ? 'num' : ''}" data-sort="${k}" aria-sort="${key === k ? (desc ? 'descending' : 'ascending') : 'none'}">${label}${arrow}</th>`
    }
    let h = sc.components.length !== sc.total.components
      ? `<p class="scope">表示中の ${sc.components.length} 件（全体 ${sc.total.components} 件）</p>`
      : ''
    h += `<table class="list"><thead><tr>${th('name', '名前')}${th('parents', '親', 1)}${th('children', '子', 1)}${th('lines', '行', 1)}</tr></thead><tbody>`
    for (const r of rows) {
      h +=
        `<tr class="row" data-select="${esc(r.n.id)}" title="${esc(r.n.id)}">` +
        `<td class="name"><span class="dot" style="background:${colorOf(r.n)}"></span>${esc(r.n.name)}</td>` +
        `<td class="num">${r.parents}</td><td class="num">${r.children}</td><td class="num">${r.lines}</td></tr>`
    }
    return h + '</tbody></table>'
  }

  function renderDetail(id) {
    const n = nodeById.get(id)
    const abs = DATA.root.replace(/\/$/, '') + '/' + n.id
    const parents = parentsOf.get(id)
    const children = childrenOf.get(id)
    let h = '<button type="button" data-back>← 概要</button>'
    h += `<h2 style="margin-top:12px">${esc(n.name)}</h2><div class="path">${esc(n.id)}</div>`
    h += statusHtml(id)
    const meta = []
    if (n.kind === 'component') meta.push(`グループ: ${esc(n.group)}`)
    else meta.push(n.kind === 'module' ? 'JS/TS モジュール' : '外部コンポーネント')
    if (n.lines) meta.push(`${n.lines} 行`)
    h += `<div class="path" style="margin-top:6px;color:var(--text-secondary)">${meta.join(' · ')}</div>`

    h += '<div class="actions">'
    if (children.length) h += `<button type="button" data-focus="${esc(id)}" data-dir="down">配下だけ表示</button>`
    if (parents.length) h += `<button type="button" data-focus="${esc(id)}" data-dir="up">使っている側を表示</button>`
    if (n.kind !== 'external') h += `<a class="button" href="vscode://file${encodeURI(abs)}">VS Code で開く</a>`
    h += '</div>'

    if (n.kind === 'component') h += pagesOfHtml(n)
    h += `<h3>使っている側（${parents.length}）</h3>`
    h += parents.length ? `<ul>${parents.map((e) => nodeItem(e.from, edgeTags(e))).join('')}</ul>` : '<p class="empty">なし</p>'
    h += `<h3>使っているもの（${children.length}）</h3>`
    h += children.length ? `<ul>${children.map((e) => nodeItem(e.to, edgeTags(e))).join('')}</ul>` : '<p class="empty">なし</p>'
    if (n.externals.length) {
      h += `<h3>外部コンポーネント（${n.externals.length}）</h3><ul>`
      h += n.externals.map((x) => `<li>${esc(x)}</li>`).join('')
      h += '</ul>'
    }
    side.innerHTML = h
    side.scrollTop = 0
  }

  function routeLabel(r) {
    return r.dynamic ? `<span class="tag" style="margin:0">動的</span> <code>${esc(r.path)}</code>` : esc(r.path)
  }

  function routeItem(i) {
    const r = DATA.routes[i]
    const page = nodeById.get(r.chain[r.chain.length - 1])
    return `<li class="link route" data-select="${esc(page.id)}" title="${esc(r.chain.join(' > '))}"><span class="rpath">${routeLabel(r)}</span><span class="rcomp">${esc(page.name)}</span></li>`
  }

  function shellNames() {
    return DATA.nodes.filter((n) => n.shell).map((n) => n.name)
  }

  function pagesOfHtml(n) {
    if (n.shell) {
      return `<h3>表示されるページ</h3><p class="note">全ページ（${esc(shellNames()[0] || 'App')} の配下で常に表示）</p>`
    }
    if (!n.routes.length) {
      return `<h3>表示されるページ</h3><p class="empty">${DATA.routes.length ? 'ルートから辿れない' : 'ルート定義が見つからない'}</p>`
    }
    return `<h3>表示されるページ（${n.routes.length}）</h3><ul>${n.routes.map(routeItem).join('')}</ul>`
  }

  function pagesHtml() {
    if (!DATA.routes.length) return '<p class="empty">ルート定義が見つかりませんでした</p>'
    const counts = DATA.routes.map(() => 0)
    for (const n of DATA.nodes) if (n.kind === 'component') for (const i of n.routes) counts[i]++
    let h = ''
    const shell = shellNames()
    if (shell.length) h += `<p class="note">全ページ共通：${shell.map(esc).join('、')}</p>`
    h += '<table class="list"><thead><tr><th>パス</th><th>画面</th><th class="num" title="このページで描画されるコンポーネント数（全ページ共通分を除く）">部品</th></tr></thead><tbody>'
    DATA.routes.forEach((r, i) => {
      const page = nodeById.get(r.chain[r.chain.length - 1])
      const hit = IMPACT && state.showImpact && IMPACT.routes.includes(i)
      h +=
        `<tr class="row${hit ? ' impacted' : ''}" data-select="${esc(page.id)}" title="${esc(r.chain.join(' > '))}">` +
        `<td class="name">${routeLabel(r)}</td><td>${esc(page.name)}</td><td class="num">${counts[i]}</td></tr>`
    })
    return h + '</tbody></table>'
  }

  function impactHtml() {
    if (!IMPACT) return ''
    let h = `<section class="impact"><h3 style="margin-top:4px">変更の影響（${esc(IMPACT.since)} との差分）</h3>`
    if (!IMPACT.changed.length) return h + '<p class="empty">解析対象に関係する変更はありません</p></section>'
    h += `<div class="sub">変更ファイル（${IMPACT.changed.length}）</div><ul>`
    h += IMPACT.changed
      .map((id) => (nodeById.has(id) ? nodeItem(id, ['変更']) : `<li class="file">${esc(id)}</li>`))
      .join('')
    h += '</ul>'
    const others = IMPACT.affected.filter((id) => !changedSet.has(id))
    h += `<div class="sub">影響を受けるコンポーネント（${others.length}）</div>`
    h += others.length ? `<ul>${others.map((id) => nodeItem(id)).join('')}</ul>` : '<p class="empty">なし</p>'
    h += `<div class="sub">確認するページ（${IMPACT.routes.length}）${IMPACT.everywhere ? ' <span class="tag" style="margin:0">全ページ</span>' : ''}</div>`
    h += IMPACT.routes.length ? `<ul>${IMPACT.routes.map(routeItem).join('')}</ul>` : '<p class="empty">なし</p>'
    return h + '</section>'
  }

  function select(id, center) {
    state.selected = id
    if (id && !current.pos.has(id)) {
      // 絞り込みで隠れているなら全体に戻す
      state.focus = null
      if (nodeById.get(id).kind === 'module') state.showModules = $('opt-modules').checked = true
      render(false)
    }
    applyHighlight()
    renderSide()
    if (id && center) centerOn(id)
  }

  side.addEventListener('click', (e) => {
    const t = e.target.closest('[data-select],[data-focus],[data-back],[data-tab],[data-sort]')
    if (!t) return
    if (t.dataset.select) select(t.dataset.select, true)
    else if (t.dataset.focus) {
      state.focus = { id: t.dataset.focus, dir: t.dataset.dir }
      render(true)
    } else if ('back' in t.dataset) select(null)
    else if (t.dataset.tab) {
      state.tab = t.dataset.tab
      renderSide()
    } else if (t.dataset.sort) {
      const k = t.dataset.sort
      state.sort = state.sort.key === k ? { key: k, desc: !state.sort.desc } : { key: k, desc: k !== 'name' }
      renderSide()
    }
  })

  $('focus-bar').addEventListener('click', (e) => {
    if (!e.target.closest('[data-unfocus]')) return
    state.focus = null
    render(true)
  })

  // ---------- 検索 ----------
  const searchInput = $('search')
  const results = $('search-results')
  let resultIndex = 0

  const norm = (s) => s.toLowerCase().replace(/[-_\s]/g, '')
  function searchNodes(q) {
    const nq = norm(q)
    const hits = DATA.nodes.filter((n) => norm(n.name).includes(nq) || n.id.toLowerCase().includes(q.toLowerCase()))
    return hits.sort((a, b) => {
      const sa = norm(a.name).startsWith(nq) ? 0 : 1
      const sb = norm(b.name).startsWith(nq) ? 0 : 1
      return sa - sb || a.name.length - b.name.length || a.name.localeCompare(b.name)
    })
  }

  function renderResults() {
    const q = state.query.trim()
    const hits = q ? searchNodes(q).slice(0, 30) : []
    results.hidden = !hits.length
    resultIndex = Math.min(resultIndex, Math.max(0, hits.length - 1))
    results.innerHTML = hits
      .map(
        (n, i) =>
          `<li role="option" data-id="${esc(n.id)}" aria-selected="${i === resultIndex}"><span class="dot" style="background:${colorOf(n)}"></span>${esc(n.name)}<span class="path">${esc(n.id)}</span></li>`,
      )
      .join('')
  }

  function pickResult(id) {
    results.hidden = true
    searchInput.blur()
    select(id, true)
  }

  searchInput.addEventListener('input', () => {
    state.query = searchInput.value
    resultIndex = 0
    renderResults()
    applyHighlight()
  })
  searchInput.addEventListener('keydown', (e) => {
    const items = results.querySelectorAll('li')
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!items.length) return
      resultIndex = (resultIndex + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items.forEach((li, i) => li.setAttribute('aria-selected', i === resultIndex))
      items[resultIndex].scrollIntoView({ block: 'nearest' })
    } else if (e.key === 'Enter') {
      if (items[resultIndex]) pickResult(items[resultIndex].dataset.id)
    } else if (e.key === 'Escape') {
      searchInput.value = state.query = ''
      renderResults()
      applyHighlight()
      searchInput.blur()
    }
  })
  searchInput.addEventListener('focus', renderResults)
  searchInput.addEventListener('blur', () => setTimeout(() => (results.hidden = true), 150))
  results.addEventListener('mousedown', (e) => {
    const li = e.target.closest('li')
    if (li) pickResult(li.dataset.id)
  })

  // ---------- ツールバー・キーボード ----------
  $('opt-script').addEventListener('change', (e) => {
    state.showScript = e.target.checked
    render(true)
  })
  if (IMPACT) {
    $('opt-impact-wrap').hidden = false
    $('opt-impact').addEventListener('change', (e) => {
      state.showImpact = e.target.checked
      render(false)
    })
  }
  $('opt-modules').addEventListener('change', (e) => {
    state.showModules = e.target.checked
    render(true)
  })
  $('btn-fit').addEventListener('click', fitView)

  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement) return
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const r = svg.getBoundingClientRect()
    if (e.key === '/') {
      e.preventDefault()
      searchInput.focus()
    } else if (e.key === 'f' || e.key === 'F') fitView()
    else if (e.key === '+' || e.key === '=') zoomAt(1.2, r.width / 2, r.height / 2)
    else if (e.key === '-') zoomAt(1 / 1.2, r.width / 2, r.height / 2)
    else if (e.key === 'Escape') {
      if (state.selected) select(null)
      else if (state.focus) {
        state.focus = null
        render(true)
      }
    }
  })

  // ---------- 起動 ----------
  // rtl で末尾側を見せつつ、パス自体は ltr のまま表示する
  $('root-path').textContent = '\u200e' + DATA.root + '\u200e'
  $('root-path').title = DATA.root
  if (DATA.initialFocus) state.focus = DATA.initialFocus
  render(true)
})()
