// 화면 위에 얹히는 설명 스티커. 프론트 코드는 건드리지 않고 프록시가 끼워 넣는다.
// 프론트 스타일과 서로 영향이 없도록 전부 Shadow DOM 안에서 산다.
;(() => {
  if (window.__specOverlayLoaded) return
  window.__specOverlayLoaded = true

  const BASE = '/__spec'
  const POLL_MS = 1000
  // 공유 링크(정적 묶음)에서는 서버가 없다. 미리 구워둔 파일에서 읽는다.
  const 혼자서 = Boolean(window.__PK_STANDALONE)
  const 정적 = (name) => `/__spec/${name}`

  let specs = []
  let specsRaw = ''
  let mode = 'use' // use | spec | comment
  let threadsBySpec = new Map() // 요소id → 스레드 목록
  let commentsOff = null // 깃랩이 꺼져 있을 때 안내 문구
  let 로그인필요 = false // 공유 링크에서 아직 깃랩 로그인을 안 한 상태
  let 이슈주소 = null // 이력 탭 커밋 메시지의 #번호를 링크로 걸 때 쓸 이슈 주소
  // 스펙이 없는 화면에서 임의로 달 때 쓸 이슈.
  // 도구로 돌 때는 서버가 알려주지만, 공유 링크에는 서버가 없어 구울 때 박아둔 값을 쓴다.
  let 기본이슈 = (혼자서 && window.__PK_GITLAB?.defaultIssue) || null
  let adhoc = [] // 스펙에 없는 자리에 달린 코멘트 (스티커로 띄운다)
  let adhocKeys = '' // 위 목록이 바뀌었는지 보는 값
  // 평소 쓸 때는 제품 화면 그대로 보여야 한다. 스티커는 스펙 모드에서만 나온다.
  // 툴바의 "스티커" 버튼으로 사용 모드에서도 켤 수 있다 (모드를 바꾸면 다시 따라간다).
  let showStickers = false
  let targets = [] // { el, element, spec, index }
  let lastRoute = location.pathname

  /* ---------------- 요소 찾기 ---------------- */
  // 규칙은 overlay/locator.js 한 곳에만 있다. 점검 스크립트도 같은 파일을 쓴다.
  const { resolve } = window.__pkLocator

  /* ---------------- Shadow DOM ---------------- */

  const host = document.createElement('div')
  host.id = '__planning_kit_overlay__'
  const root = host.attachShadow({ mode: 'open' })
  document.documentElement.appendChild(host)

  root.innerHTML = `
    <style>
      :host { all: initial; }
      #layer, #bar, #cards {
        position: fixed; inset: 0; pointer-events: none;
        z-index: 2147483600;
        font: 12px/1.5 "Pretendard Variable", -apple-system, "Segoe UI", sans-serif;
        color: #111827;
      }
      .sticker {
        position: fixed; pointer-events: auto; cursor: pointer;
        min-width: 18px; height: 18px; padding: 0 4px;
        border-radius: 9px; background: #4f46e5; color: #fff;
        font-size: 11px; font-weight: 700; line-height: 18px; text-align: center;
        box-shadow: 0 1px 4px rgba(0,0,0,.35);
        display: flex; align-items: center; justify-content: center; gap: 3px;
      }
      .sticker.missing { background: #dc2626; }
      .sticker.nokb { background: #6b7280; }
      .sticker.adhoc { background: #0891b2; }
      #sel { position: fixed; display: none; pointer-events: none;
        border: 2px dashed #0891b2; background: rgba(8,145,178,.12); border-radius: 3px; }
      .spot { position: fixed; pointer-events: none; border-radius: 3px;
        border: 2px dashed #0891b2; background: rgba(8,145,178,.10); }
      .spot.el { border-style: solid; background: rgba(8,145,178,.07); }
      .spot.open { border-color: #4f46e5; background: rgba(79,70,229,.12); }
      .sticker.missing.nokb { background: #dc2626; outline: 2px solid #6b7280; }
      .sticker .dot {
        display: inline-block; min-width: 13px; height: 13px; border-radius: 7px;
        background: #fbbf24; color: #111827; font-size: 9px; line-height: 13px;
      }
      .ring {
        position: fixed; pointer-events: none; border: 2px solid #4f46e5;
        border-radius: 4px; background: rgba(79,70,229,.08);
      }
      #bar {
        inset: auto auto 12px 12px; width: max-content; height: max-content;
        pointer-events: auto; display: flex; align-items: center; gap: 6px;
        padding: 6px 8px; border-radius: 8px;
        background: rgba(17,24,39,.92); color: #f9fafb;
        box-shadow: 0 4px 16px rgba(0,0,0,.3);
      }
      #bar button {
        all: unset; cursor: pointer; padding: 3px 8px; border-radius: 5px;
        background: #374151; color: #f9fafb; font-size: 11px;
      }
      #bar button.on { background: #4f46e5; }
      #bar .label { font-size: 11px; opacity: .7; }
      #bar select { font: inherit; font-size: 11px; max-width: 200px; border: 0; border-radius: 5px;
        padding: 3px 6px; background: #374151; color: #f9fafb; }
      #bar select.past { background: #b45309; }
      /* 목업 경우 고르개. 지금 무엇으로 보고 있는지가 한눈에 보여야 해서 색을 준다. */
      #bar select.mock { max-width: 280px; background: #065f46; }
      /* 기획 건 고르개. 지금 어느 건을 보고 있는지가 제일 먼저 읽혀야 한다. */
      #bar #plan { background: #4c1d95; font-weight: 600; max-width: 220px; }
      #bar #mocks { display: inline-flex; gap: 6px; }
      #bar .warn { font-size: 11px; color: #fbbf24; }
      .card {
        position: fixed; pointer-events: auto; width: 320px; max-height: 60vh;
        overflow: auto; background: #fff; border: 1px solid #d1d5db;
        border-radius: 8px; box-shadow: 0 8px 28px rgba(0,0,0,.2);
      }
      .card header {
        display: flex; align-items: center; gap: 6px; cursor: move;
        padding: 7px 9px; background: #f3f4f6; border-bottom: 1px solid #e5e7eb;
        font-weight: 700; font-size: 12px;
      }
      .card header .num.nokb { background: #6b7280; }
      .card header .num {
        background: #4f46e5; color: #fff; border-radius: 8px;
        min-width: 16px; height: 16px; font-size: 10px; line-height: 16px; text-align: center;
      }
      .card header .grow { flex: 1; }
      .card header button {
        all: unset; cursor: pointer; padding: 1px 5px; border-radius: 4px;
        font-size: 11px; background: #e5e7eb;
      }
      .card header button.on { background: #4f46e5; color: #fff; }
      .card .body { padding: 10px 12px; }
      .card .desc { white-space: pre-wrap; }
      .card .none { margin: 0; color: #9ca3af; font-style: italic; }
      .card .foot {
        display: flex; justify-content: space-between; align-items: baseline; gap: 10px;
        margin: 12px 0 0; padding-top: 8px; border-top: 1px solid #f3f4f6;
        font-size: 10px; color: #9ca3af;
      }
      .card .foot a { color: #4f46e5; text-decoration: none; }
      .card .foot a:hover { text-decoration: underline; }
      .card .hist { margin-top: 10px; padding-top: 9px; border-top: 1px solid #e5e7eb; }
      .card .hist h5 { margin: 0 0 6px; font-size: 10px; color: #6b7280; letter-spacing: .04em; }
      .card .hist .rev { margin: 0 0 8px; }
      .card .hist .when { font-size: 10px; color: #6b7280; }
      .card .hist .msg { font-size: 11px; color: #374151; }
      .card .hist .line { white-space: pre-wrap; font-size: 11px; padding: 1px 4px; border-radius: 3px; }
      .card .hist .del { background: #fef2f2; color: #991b1b; text-decoration: line-through; }
      .card .hist .add { background: #f0fdf4; color: #166534; }
      .card .hist .same { color: #9ca3af; }
      .card .hist button { all: unset; cursor: pointer; font-size: 10px; color: #4f46e5; }
      .sticker .n { display:inline-block; min-width:13px; height:13px; border-radius:7px;
        background:#f59e0b; color:#111827; font-size:9px; line-height:13px; margin-left:2px; }
      .card .cmt { margin-top:12px; padding-top:10px; border-top:1px solid #e5e7eb; }
      .card .cmt h5 { margin:0 0 8px; font-size:10px; color:#6b7280; letter-spacing:.04em; }
      .card .thread { margin:0 0 10px; padding:8px 9px; border:1px solid #e5e7eb; border-radius:6px; }
      .card .thread.done { background:#f0fdf4; border-color:#bbf7d0; }
      .card .note { margin:0 0 6px; }
      .card .note:last-child { margin-bottom:0; }
      .card .note .who { font-size:10px; color:#6b7280; }
      .card .note .txt { white-space:pre-wrap; }
      .card .cmt textarea { width:100%; min-height:52px; box-sizing:border-box; resize:vertical;
        border:1px solid #d1d5db; border-radius:6px; padding:6px 7px; font:inherit; }
      .card .cmt .acts { display:flex; gap:6px; margin-top:6px; align-items:center; }
      .card .cmt button { all:unset; cursor:pointer; padding:4px 10px; border-radius:5px;
        background:#4f46e5; color:#fff; font-size:11px; }
      .card .cmt button.ghost { background:#e5e7eb; color:#374151; }
      .card .cmt .hint { font-size:10px; color:#9ca3af; }
      .card .mention { position:absolute; z-index:10; background:#fff; border:1px solid #d1d5db;
        border-radius:6px; box-shadow:0 6px 18px rgba(0,0,0,.18); max-height:150px; overflow:auto; }
      .card .mention div { padding:5px 9px; cursor:pointer; font-size:12px; }
      .card .mention div:hover, .card .mention div.on { background:#eef2ff; }
    </style>
    <div id="layer"></div>
    <div id="sel"></div>
    <div id="cards"></div>
    <div id="bar">
      <select id="plan" title="기획 건"></select>
      <span class="label" id="where">기획 도구</span>
      <button id="btn-mode">스펙 모드 (S)</button>
      <button id="btn-stickers">스티커</button>
      <button id="btn-comment">코멘트 (C)</button>
      <select id="ver" title="보관된 기획안 버전"></select>
      <span id="mocks"></span>
      <span class="label" id="status"></span>
    </div>
  `

  const layer = root.getElementById('layer')
  const cardLayer = root.getElementById('cards')
  const btnMode = root.getElementById('btn-mode')
  const btnStickers = root.getElementById('btn-stickers')
  const status = root.getElementById('status')
  const sel = root.getElementById('sel')
  const ring = document.createElement('div')
  ring.className = 'ring'
  ring.style.display = 'none'
  layer.appendChild(ring)

  /* ---------------- 스펙 불러오기 ---------------- */

  let 정적스펙 = null
  const 경로맞나 = (pattern, pathname) => {
    if (!pattern) return false
    const trim = (x) => x.replace(/\/+$/, '')
    if (!pattern.includes('*')) return trim(pattern) === trim(pathname)
    const a = trim(pattern).split('/')
    const b = trim(pathname).split('/')
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] === '**') return true
      if (a[i] === '*') continue
      if (a[i] !== b[i]) return false
    }
    return a.length === b.length
  }

  async function fetchSpecs() {
    if (혼자서) {
      if (!정적스펙) 정적스펙 = await (await fetch(정적('specs-by-route.json'))).json()
      // 지금 경로에서 앞에 붙은 배포 폴더를 떼고 맞춰본다
      const here = location.pathname
      const 골라낸 = Object.entries(정적스펙)
        .filter(([route]) => 경로맞나(route, here) || 경로맞나(route, here.slice(here.indexOf('/', 1)) || here))
        .flatMap(([, v]) => v)
      const text = JSON.stringify(골라낸)
      if (text === specsRaw && here === lastRoute) return
      specsRaw = text
      lastRoute = here
      specs = 골라낸
      rebuild()
      return
    }
    try {
      const res = await fetch(`${BASE}/specs.json?route=${encodeURIComponent(location.pathname)}`)
      const text = await res.text()
      if (text === specsRaw && location.pathname === lastRoute) return
      specsRaw = text
      lastRoute = location.pathname
      specs = JSON.parse(text)
      rebuild()
    } catch {
      /* 프록시가 잠깐 안 뜬 상태. 다음 주기에 다시 시도한다 */
    }
  }

  /* ---------------- 코멘트 (깃랩 이슈) ---------------- */

  async function fetchComments() {
    // 스펙의 issue 는 숫자, .env 의 기본 이슈는 문자라 그냥 Set 에 넣으면 같은 이슈를 두 번 읽는다
    const issues = [...new Set([...specs.map((sp) => sp.issue), 기본이슈].filter(Boolean).map(String))]
    threadsBySpec = new Map()
    for (const issue of issues) {
      try {
        // 공유 링크에는 서버가 없다. 브라우저가 깃랩에 직접 말한다 (보는 사람 계정으로).
        const data = 혼자서
          ? await window.__pkGitlab.comments(issue)
          : await (await fetch(`${BASE}/comments?issue=${encodeURIComponent(issue)}`)).json()
        if (data.off) {
          commentsOff = data.message
          로그인필요 = Boolean(data.needLogin)
          for (const t of targets) paint(t.node, t.element, t.count)
          return
        }
        commentsOff = null
        로그인필요 = false
        기본이슈 = data.defaultIssue ?? 기본이슈
        이슈주소 = data.issueUrl ?? 이슈주소
        for (const t of data.threads ?? []) {
          if (!t.specId) continue
          const list = threadsBySpec.get(t.specId) ?? []
          list.push({ ...t, issue, issueUrl: data.issueUrl })
          threadsBySpec.set(t.specId, list)
        }
      } catch {
        /* 다음 주기에 다시 */
      }
    }
    // 임의 코멘트가 새로 생기거나 사라졌으면 스티커를 다시 만든다.
    // 스펙을 먼저 읽고 스티커를 만든 뒤에 코멘트가 도착하므로, 여기서 한 번 더 손봐야 한다.
    const 지금 = adhocElements()
      .map((e) => e.id)
      .sort()
      .join('|')
    if (지금 !== adhocKeys) {
      adhocKeys = 지금
      rebuild()
      return
    }
    for (const t of targets) paint(t.node, t.element, t.count)
  }

  const unresolvedOf = (element) =>
    (threadsBySpec.get(element.id) ?? []).filter((t) => !t.resolved).length

  async function postComment(payload, path = '') {
    if (혼자서) {
      await window.__pkGitlab.post(payload, path)
      await fetchComments()
      return
    }
    const res = await fetch(`${BASE}/comments${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message ?? '등록에 실패했습니다')
    await fetchComments()
  }

  /* ---------------- 스티커 만들기 ---------------- */

  // 스티커에 적히는 번호는 기획안의 그 번호다. 따로 매기지 않는다.
  // 기획안에 없는 항목만 ＋ 로 표시한다.
  const labelOf = (element) =>
    element.region ? '▭' : element.adhoc ? '💬' : element.kbItem && !element.kbItem.missing ? String(element.kbItem.marker) : '＋'

  // 스티커의 색과 말풍선은 "요소를 제대로 찾았는지"를 그대로 비춘다.
  // 화면이 바뀌면 다시 찾으므로 그때마다 여기를 다시 부른다.
  function paint(node, element, count) {
    const name = element.name ?? element.id
    const kb = element.kbItem
    const nokb = !kb || kb.missing
    node.className =
      'sticker' + (count === 1 ? '' : ' missing') + (element.adhoc ? ' adhoc' : nokb ? ' nokb' : '')
    const 미해결 = unresolvedOf(element)
    node.innerHTML = `${esc(labelOf(element))}${미해결 ? `<span class="n">${미해결}</span>` : ''}`
    const 기획안 =
      !kb ? ' · 기획안에 없는 항목' : kb.missing ? ` · 기획안 연결 안 됨 (${kb.reason})` : ` · 기획안 ${kb.page} ${kb.marker}`
    node.title =
      (count === 1 ? name : count === 0 ? `${name} — 요소를 못 찾았습니다` : `${name} — ${count}개가 찾아집니다`) + 기획안
  }

  /** 스펙에 없는 자리에 달린 코멘트를, 저장해둔 위치로 되살려 스티커 대상에 넣는다 */
  function adhocElements() {
    const seen = new Map()
    for (const [specId, list] of threadsBySpec) {
      if (!specId.startsWith('adhoc-')) continue
      const at = list.find((t) => t.at)?.at
      if (!at || seen.has(specId)) continue
      const 범위 = Boolean(at.box && at.el)
      const 안쪽 = 범위 ? (at.el.name ?? at.el.text ?? at.el.css ?? '화면') : (at.name ?? at.text ?? at.css ?? '임의 코멘트')
      const 이름 = 범위 ? `범위 · ${String(안쪽).slice(0, 20)} 안` : String(안쪽)
      seen.set(specId, {
        id: specId,
        name: 이름.length > 34 ? 이름.slice(0, 34) + '…' : 이름,
        locator: at,
        at,
        region: 범위,
        adhoc: true,
        issue: list[0]?.issue ?? 기본이슈,
      })
    }
    return [...seen.values()]
  }

  function rebuild() {
    targets = []
    for (const sticker of layer.querySelectorAll('.sticker')) sticker.remove()

    adhoc = adhocElements()
    let index = 0
    for (const spec of [...specs, { screen: '(임의 코멘트)', title: '임의 코멘트', issue: 기본이슈, elements: adhoc }]) {
      for (const element of spec.elements ?? []) {
        index += 1
        const found = element.region
          ? window.__pkLocator.rectOf(element.at)
            ? [1]
            : []
          : resolve(element)
        const node = document.createElement('div')
        paint(node, element, found.length)
        node.addEventListener('click', (e) => {
          e.stopPropagation()
          openCard(element, index, spec)
        })
        layer.appendChild(node)
        targets.push({ el: found[0] ?? null, count: found.length, element, spec, index, node })
      }
    }
    const bad = targets.filter((t) => t.count !== 1).length
    status.textContent = bad ? `${targets.length}개 중 ${bad}개 못 찾음` : `${targets.length}개`
    position()
  }

  /* ---------------- 위치 따라가기 ---------------- */
  // ponytail: 주기적으로 위치를 다시 잰다. 스크롤·모달·창크기·애니메이션을 각각
  // 이벤트로 처리하지 않고 한 번에 해결하는 대신 CPU 를 조금 쓴다. 로컬 기획 도구라
  // 그 편이 낫다. 느려지면 그때 IntersectionObserver 로 바꾼다.
  /** 코멘트가 달린 자리를 화면에 표시한다. 어디에 남겼는지 눈으로 보이게. */
  function drawSpots() {
    const 열린카드 = [...cardLayer.querySelectorAll('.card')].map((c) => c.dataset.spec)
    for (const t of targets) {
      const 코멘트있음 = (threadsBySpec.get(t.element.id) ?? []).length > 0
      const 열림 = 열린카드.includes(t.element.id)
      const 보여야 = (mode === 'comment' && 코멘트있음) || 열림
      if (!보여야) {
        t.spot?.remove()
        t.spot = null
        continue
      }
      const r = window.__pkLocator.rectOf(t.element.at ?? t.element.locator)
      if (!r || r.width < 1) {
        t.spot?.remove()
        t.spot = null
        continue
      }
      if (!t.spot) {
        t.spot = document.createElement('div')
        layer.appendChild(t.spot)
      }
      t.spot.className = 'spot' + (t.element.region ? '' : ' el') + (열림 ? ' open' : '')
      Object.assign(t.spot.style, {
        left: `${r.left}px`,
        top: `${r.top}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      })
    }
  }

  function position() {
    drawSpots()
    for (const t of targets) {
      const visible = showStickers && t.el
      if (!visible) {
        t.node.style.display = 'none'
        continue
      }
      // 범위 코멘트는 요소가 아니라 저장된 사각형 자리에 붙인다
      if (t.element.region) {
        const rr = window.__pkLocator.rectOf(t.element.at)
        if (!rr) {
          t.node.style.display = 'none'
          continue
        }
        t.node.style.display = 'flex'
        t.node.style.left = `${Math.max(2, rr.left - 9)}px`
        t.node.style.top = `${Math.max(2, rr.top - 9)}px`
        continue
      }
      // 파일 선택칸처럼 눈에 안 보이게 숨긴 요소는 크기가 0 이다.
      // 그럴 땐 눈에 보이는 가장 가까운 부모 자리에 스티커를 붙인다.
      let box = t.el
      let r = box.getBoundingClientRect()
      while (r.width === 0 && r.height === 0 && box.parentElement && box !== document.body) {
        box = box.parentElement
        r = box.getBoundingClientRect()
      }
      const onScreen = r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight
      t.node.style.display = onScreen ? 'flex' : 'none'
      if (!onScreen) continue
      t.node.style.left = `${Math.max(2, r.left - 9)}px`
      t.node.style.top = `${Math.max(2, r.top - 9)}px`
    }
  }

  function frame() {
    position()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  // requestAnimationFrame 은 창이 가려지거나 최소화되면 멈춘다. 그러면 스티커가 그 자리에
  // 얼어붙는다. 타이머로 한 겹 더 받쳐서 어떤 경우에도 위치가 갱신되게 한다.
  setInterval(position, 250)

  // 화면이 바뀌면(모달 열림, 라우팅) 요소를 다시 찾아야 한다. 1초에 두 번이면 충분하다.
  setInterval(() => {
    if (location.pathname !== lastRoute) {
      fetchSpecs()
      return
    }
    for (const t of targets) {
      // 범위 코멘트는 요소를 찾는 게 아니라 "기준 요소가 아직 있나"로 판정한다
      const found = t.element.region
        ? window.__pkLocator.rectOf(t.element.at)
          ? [1]
          : []
        : resolve(t.element)
      if (found[0] !== t.el || found.length !== t.count) {
        t.el = found[0] ?? null
        t.count = found.length
        paint(t.node, t.element, found.length)
      }
    }
    const bad = targets.filter((t) => t.count !== 1).length
    status.textContent = bad ? `${targets.length}개 중 ${bad}개 못 찾음` : `${targets.length}개`
  }, 500)

  /* ---------------- 설명 카드 ---------------- */

  let cardSeq = 0
  function openCard(element, index, spec) {
    const target = targets.find((t) => t.element === element)?.el
    const card = document.createElement('div')
    card.className = 'card'
    const id = ++cardSeq

    // 카드에는 기획안 설명을 그대로 보여준다. 여기서 따로 적는 칸은 두지 않는다.
    const kb = element.kbItem
    let body
    if (!kb) {
      body = `<p class="none">기획안에 없는 항목입니다.</p>`
    } else if (kb.missing) {
      body = `<p class="none">기획안 연결 안 됨 — ${esc(kb.key)} · ${esc(kb.reason)}</p>`
    } else {
      body = `<div class="desc">${esc(kb.desc) || '<i>기획안에 설명이 비어 있습니다</i>'}</div>`
    }

    const foot =
      kb && !kb.missing
        ? `<p class="foot">${kb.figmaUrl ? `<a href="${esc(kb.figmaUrl)}" target="_blank" rel="noreferrer">피그마 ${esc(kb.menu)} 페이지 열기 ↗</a>` : ''}<span>${kb.extractedAt ? `${esc(kb.extractedAt)} 추출` : ''}</span></p>`
        : ''

    const threads = threadsBySpec.get(element.id) ?? []
    const 시각 = (iso) => { try { return new Date(iso).toLocaleString('ko-KR', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}) } catch { return '' } }
    const cmtBlock = commentsOff
      ? `<div class="cmt"><h5>코멘트</h5><p class="hint">${esc(commentsOff)}</p>${
          로그인필요 ? '<button class="gl-login">깃랩 계정으로 로그인</button>' : ''
        }</div>`
      : !spec.issue
        ? `<div class="cmt"><h5>코멘트</h5><p class="hint">이 화면 스펙에 issue 번호가 없습니다. specs 파일에 issue: 12 처럼 적어주세요.</p></div>`
        : `<div class="cmt"><h5>코멘트 ${threads.length ? `· ${threads.filter((t) => !t.resolved).length}건 미해결` : ''}</h5>
            ${threads
              .map(
                (t) => `<div class="thread${t.resolved ? ' done' : ''}" data-did="${esc(t.id)}">
                  ${t.notes.map((n) => `<p class="note"><span class="who">${esc(n.author)} · ${esc(시각(n.at))}</span><br><span class="txt">${esc(n.body)}</span></p>`).join('')}
                  <div class="acts">
                    <button class="ghost reply">답글</button>
                    <button class="ghost resolve">${t.resolved ? '되돌리기' : '해결'}</button>
                    ${t.issueUrl ? `<a href="${esc(t.issueUrl)}" target="_blank" rel="noreferrer" class="hint">깃랩에서 열기 ↗</a>` : ''}
                  </div></div>`,
              )
              .join('')}
            <p class="hint">${element.region ? '드래그로 잡은 범위' : element.adhoc ? '찍은 요소' : '기획안 항목'}에 답니다. 파란 점선이 그 자리입니다.</p>
            <textarea placeholder="여기에 코멘트를 씁니다. @ 를 치면 멤버가 뜹니다."></textarea>
            <div class="acts"><button class="send">등록</button><span class="hint">깃랩 이슈 #${esc(spec.issue)} 에 저장됩니다</span></div>
          </div>`

    card.innerHTML = `
      <header>
        <span class="num${kb && !kb.missing ? '' : ' nokb'}">${esc(labelOf(element))}</span>
        <span class="grow">${esc(kb && !kb.missing ? kb.name : (element.name ?? element.id ?? '이름 없음'))}</span>
        <button class="pin" title="고정">고정</button>
        <button class="close" title="닫기">✕</button>
      </header>
      <div class="body">
        ${body}
        ${foot}
        ${kb && !kb.missing && !혼자서 ? '<div class="hist"><h5>이력</h5><button class="load">기획안이 언제 바뀌었는지 보기</button></div>' : ''}
        ${cmtBlock}
      </div>
    `

    const r = target?.getBoundingClientRect()
    card.style.left = `${Math.min(innerWidth - 340, (r?.right ?? innerWidth / 2) + 12)}px`
    card.style.top = `${Math.min(innerHeight - 120, r?.top ?? 80)}px`

    card.querySelector('.hist .load')?.addEventListener('click', async (e) => {
      const box = card.querySelector('.hist')
      e.target.textContent = '불러오는 중…'
      let d
      try {
        d = await (
          await fetch(
            `${BASE}/history?menu=${encodeURIComponent(kb.menu)}&pageId=${encodeURIComponent(kb.pageId)}&marker=${encodeURIComponent(kb.marker)}`,
          )
        ).json()
      } catch (err) {
        e.target.textContent = `이력을 읽지 못했습니다: ${err.message}`
        return
      }
      if (d.off) {
        box.innerHTML = `<h5>이력</h5><p class="none">${esc(d.message)}</p>`
        return
      }
      if (!d.changes?.length) {
        box.innerHTML = '<h5>이력</h5><p class="none">기록된 변경이 없습니다.</p>'
        return
      }
      // 재추출하면 내용은 그대로인데 줄바꿈·구분자만 바뀌는 일이 많다.
      // 그대로 줄 단위로 비교하면 전체가 바뀐 것처럼 보여 오해를 부른다.
      // 그래서 줄바꿈과 " : " 를 같은 구분자로 보고 조각 단위로 견준다.
      const 조각 = (t) =>
        (t ?? '')
          .split(/[\r\n]|\s:\s/)
          .map((x) => x.replace(/\s+/g, ' ').replace(/^[:\s]+|[:\s]+$/g, '').trim())
          .filter(Boolean)

      const 줄diff = (before, after) => {
        const a = 조각(before)
        const b = 조각(after)
        const 빠짐 = a.filter((x) => !b.includes(x))
        const 들어옴 = b.filter((x) => !a.includes(x))
        if (!빠짐.length && !들어옴.length) {
          return '<div class="line same">내용은 그대로이고 줄바꿈·구분자만 바뀌었습니다</div>'
        }
        return (
          빠짐.map((l) => `<div class="line del">− ${esc(l)}</div>`).join('') +
          들어옴.map((l) => `<div class="line add">+ ${esc(l)}</div>`).join('')
        )
      }
      box.innerHTML =
        '<h5>이력</h5>' +
        d.changes
          .map(
            (c) => `<div class="rev">
              <div class="when">${esc(c.date.slice(0, 10))} · ${esc(c.author)}</div>
              <div class="msg">${링크걸기(esc(c.subject))}</div>
              ${c.처음 ? '<div class="line same">처음 기록된 시점입니다</div>' : 줄diff(c.before, c.after)}
            </div>`,
          )
          .join('')
    })

    const ta = card.querySelector('.cmt textarea')
    const 보냄 = async (fn) => {
      const btns = [...card.querySelectorAll('.cmt button')]
      btns.forEach((b) => (b.style.opacity = '.5'))
      try {
        await fn()
        openCard(element, index, spec) // 새로 불러온 내용으로 다시 그린다
      } catch (err) {
        const hint = card.querySelector('.cmt .hint')
        if (hint) hint.textContent = String(err.message).slice(0, 120)
        btns.forEach((b) => (b.style.opacity = '1'))
      }
    }
    card.querySelector('.cmt .send')?.addEventListener('click', () => {
      const text = ta?.value.trim()
      if (!text) return
      보냄(() =>
        postComment({ issue: spec.issue, specId: element.id, body: text, at: element.at ?? null }),
      )
    })
    for (const btn of card.querySelectorAll('.thread .resolve')) {
      btn.addEventListener('click', (e) => {
        const box = e.target.closest('.thread')
        보냄(() =>
          postComment(
            { issue: spec.issue, discussionId: box.dataset.did, resolved: !box.classList.contains('done') },
            '/resolve',
          ),
        )
      })
    }
    for (const btn of card.querySelectorAll('.thread .reply')) {
      btn.addEventListener('click', (e) => {
        const box = e.target.closest('.thread')
        const text = prompt('답글 내용')
        if (text?.trim()) 보냄(() => postComment({ issue: spec.issue, discussionId: box.dataset.did, body: text.trim() }))
      })
    }
    if (ta) 멘션달기(ta, card)

    let pinned = false
    card.querySelector('.gl-login')?.addEventListener('click', () => window.__pkGitlab.login())
    card.querySelector('.close').addEventListener('click', () => card.remove())
    card.querySelector('.pin').addEventListener('click', (e) => {
      pinned = !pinned
      e.currentTarget.classList.toggle('on', pinned)
      card.dataset.pinned = String(pinned)
    })

    // 헤더를 잡고 끌어서 옮긴다
    const header = card.querySelector('header')
    header.addEventListener('pointerdown', (e) => {
      if (e.target.tagName === 'BUTTON') return
      const startX = e.clientX - card.offsetLeft
      const startY = e.clientY - card.offsetTop
      const move = (ev) => {
        card.style.left = `${ev.clientX - startX}px`
        card.style.top = `${ev.clientY - startY}px`
      }
      const up = () => {
        removeEventListener('pointermove', move)
        removeEventListener('pointerup', up)
      }
      addEventListener('pointermove', move)
      addEventListener('pointerup', up)
    })

    // 고정하지 않은 카드는 한 번에 하나만 띄운다
    for (const open of cardLayer.querySelectorAll('.card')) {
      if (open.dataset.pinned !== 'true') open.remove()
    }
    card.dataset.spec = element.id
    cardLayer.appendChild(card)
    card.dataset.id = String(id)
  }

  /** 입력창에서 @ 를 치면 프로젝트 멤버를 띄워 고르게 한다. */
  function 멘션달기(ta, card) {
    let box = null
    const 닫기 = () => {
      box?.remove()
      box = null
    }
    ta.addEventListener('keydown', (e) => {
      if (!box) return
      const items = [...box.children]
      const cur = items.findIndex((el) => el.classList.contains('on'))
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const next = (cur + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
        items.forEach((el, i) => el.classList.toggle('on', i === next))
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        items[Math.max(cur, 0)]?.click()
      } else if (e.key === 'Escape') {
        e.stopPropagation()
        닫기()
      }
    })
    ta.addEventListener('input', async () => {
      const upto = ta.value.slice(0, ta.selectionStart)
      const m = upto.match(/@([\w.-]*)$/)
      if (!m) return 닫기()
      let list = []
      try {
        list = 혼자서
          ? await window.__pkGitlab.members(m[1])
          : await (await fetch(`${BASE}/members?q=${encodeURIComponent(m[1])}`)).json()
      } catch {
        return 닫기()
      }
      if (!Array.isArray(list) || !list.length) return 닫기()
      닫기()
      box = document.createElement('div')
      box.className = 'mention'
      box.innerHTML = list
        .slice(0, 8)
        .map((u, i) => `<div class="${i === 0 ? 'on' : ''}" data-u="${esc(u.username)}">${esc(u.name)} <span class="hint">@${esc(u.username)}</span></div>`)
        .join('')
      box.style.left = `${ta.offsetLeft}px`
      box.style.top = `${ta.offsetTop + ta.offsetHeight + 2}px`
      box.addEventListener('click', (e) => {
        const pick = e.target.closest('[data-u]')
        if (!pick) return
        const before = ta.value.slice(0, ta.selectionStart).replace(/@[\w.-]*$/, '')
        const after = ta.value.slice(ta.selectionStart)
        ta.value = `${before}@${pick.dataset.u} ${after}`
        ta.focus()
        닫기()
      })
      card.querySelector('.cmt').appendChild(box)
    })
    ta.addEventListener('blur', () => setTimeout(닫기, 150))
  }

  /** 스펙에 없는 자리를 찍었을 때. 찍은 위치를 지정 방식으로 저장해 나중에 다시 찾아간다. */
  function 임의코멘트열기(el) {
    const L = window.__pkLocator
    // 화면 전체(body·root)를 찍은 건 실수일 가능성이 커서 무시한다
    if (!el || el === document.body || el === document.documentElement) return
    const locator = L.describe(el)
    const 이름 = L.labelFor(el)
    const 열쇠 = `adhoc-${location.pathname}-${JSON.stringify(locator)}`
      .replace(/[^\w가-힣-]/g, '')
      .slice(0, 80)
    const 이슈 = specs.find((sp) => sp.issue)?.issue ?? 기본이슈
    openCard(
      { id: 열쇠, name: 이름, locator, adhoc: true, at: locator },
      '＋',
      { title: `임의 코멘트 · ${location.pathname}`, issue: 이슈, screen: '(임의)' },
    )
  }

  /** 드래그로 잡은 범위에 코멘트를 연다 */
  function 영역코멘트열기(rect) {
    const L = window.__pkLocator
    const at = L.describeRegion(rect)
    const 열쇠 = `adhoc-${location.pathname}-영역-${JSON.stringify(at)}`
      .replace(/[^\w가-힣-]/g, '')
      .slice(0, 80)
    const 이슈 = specs.find((sp) => sp.issue)?.issue ?? 기본이슈
    const 안쪽 = (at.el.name ?? at.el.text ?? at.el.css ?? '화면').slice(0, 20)
    openCard(
      { id: 열쇠, name: `범위 · ${안쪽} 안`, locator: at, adhoc: true, region: true, at },
      '▭',
      { title: `임의 코멘트 · ${location.pathname}`, issue: 이슈, screen: '(임의)' },
    )
  }

  /** 커밋 메시지의 #12 를 코멘트 프로젝트의 깃랩 이슈 링크로 바꾼다. 이슈 주소를 모르면 그대로 둔다 */
  const 링크걸기 = (text) => {
    const base = 이슈주소?.replace(/\d+$/, '')
    if (!base) return text
    return text.replace(/#(\d+)/g, (_, n) => `<a href="${base}${n}" target="_blank" rel="noreferrer">#${n}</a>`)
  }

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

  /* ---------------- 모드 ---------------- */

  const btnComment = root.getElementById('btn-comment')

  function setMode(next) {
    mode = next
    showStickers = mode !== 'use'
    btnStickers.classList.toggle('on', showStickers)
    btnMode.classList.toggle('on', mode === 'spec')
    btnMode.textContent = mode === 'spec' ? '사용 모드 (Esc)' : '스펙 모드 (S)'
    btnComment.classList.toggle('on', mode === 'comment')
    ring.style.display = 'none'
  }

  btnComment.addEventListener('click', () => setMode(mode === 'comment' ? 'use' : 'comment'))

  btnMode.addEventListener('click', () => setMode(mode === 'spec' ? 'use' : 'spec'))
  btnStickers.addEventListener('click', () => {
    showStickers = !showStickers
    btnStickers.classList.toggle('on', showStickers)
  })

  function elementAt(e) {
    return targets.find((t) => t.el && (t.el === e.target || t.el.contains(e.target)))
  }

  // 캡처 단계에서 가로채야 프론트 코드보다 먼저 잡는다
  /* ---------------- 코멘트 모드: 클릭 = 요소, 드래그 = 범위 ---------------- */
  let 드래그 = null

  addEventListener(
    'pointerdown',
    (e) => {
      if (mode !== 'comment' || e.button !== 0) return
      if (e.composedPath().includes(host)) return // 툴바·카드 위에서는 빼고
      드래그 = { x: e.clientX, y: e.clientY, moved: false }
    },
    true,
  )

  addEventListener(
    'pointermove',
    (e) => {
      if (!드래그) return
      const w = Math.abs(e.clientX - 드래그.x)
      const h = Math.abs(e.clientY - 드래그.y)
      if (!드래그.moved && w < 6 && h < 6) return
      드래그.moved = true
      Object.assign(sel.style, {
        display: 'block',
        left: `${Math.min(e.clientX, 드래그.x)}px`,
        top: `${Math.min(e.clientY, 드래그.y)}px`,
        width: `${w}px`,
        height: `${h}px`,
      })
    },
    true,
  )

  addEventListener(
    'pointerup',
    (e) => {
      if (!드래그) return
      const d = 드래그
      드래그 = null
      sel.style.display = 'none'
      if (!d.moved) return // 그냥 클릭 — click 처리기가 맡는다
      e.preventDefault()
      e.stopPropagation()
      const rect = {
        left: Math.min(e.clientX, d.x),
        top: Math.min(e.clientY, d.y),
        right: Math.max(e.clientX, d.x),
        bottom: Math.max(e.clientY, d.y),
        width: Math.abs(e.clientX - d.x),
        height: Math.abs(e.clientY - d.y),
      }
      영역코멘트열기(rect)
    },
    true,
  )

  addEventListener(
    'click',
    (e) => {
      if (e.target === host) return
      const hit = elementAt(e)
      if (mode === 'spec' || mode === 'comment') {
        e.preventDefault()
        e.stopPropagation()
        if (hit) openCard(hit.element, hit.index, hit.spec)
        else if (mode === 'comment') 임의코멘트열기(e.target)
        return
      }
      if (e.altKey && hit) {
        e.preventDefault()
        e.stopPropagation()
        openCard(hit.element, hit.index, hit.spec)
      }
    },
    true,
  )

  addEventListener(
    'mousemove',
    (e) => {
      if (mode === 'use') return
      const hit = elementAt(e)
      if (!hit) {
        ring.style.display = 'none'
        return
      }
      const r = hit.el.getBoundingClientRect()
      Object.assign(ring.style, {
        display: 'block',
        left: `${r.left - 2}px`,
        top: `${r.top - 2}px`,
        width: `${r.width}px`,
        height: `${r.height}px`,
      })
    },
    true,
  )

  addEventListener('keydown', (e) => {
    const el = document.activeElement
    const typing =
      el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    if (typing) return // 입력창에 커서가 있으면 단축키 무시
    if (e.key === 's' || e.key === 'S') setMode(mode === 'spec' ? 'use' : 'spec')
    if (e.key === 'c' || e.key === 'C') setMode(mode === 'comment' ? 'use' : 'comment')
    if (e.key === 'Escape') setMode('use')
  })

  /* ---------------- 기획안 버전 (보관본 조회) ---------------- */
  const ver = root.getElementById('ver')
  const 경고 = document.createElement('span')
  경고.className = 'warn'
  root.getElementById('bar').appendChild(경고)

  async function 버전목록() {
    let d
    try {
      d = await (await fetch(혼자서 ? 정적('snapshots.json') : `${BASE}/snapshots`)).json()
    } catch {
      return
    }
    if (혼자서) ver.disabled = true // 서버가 없어 버전 전환은 못 한다
    const 지금코드 = specs[0]?.branch ?? null
    ver.innerHTML =
      `<option value="">지금 기획안</option>` +
      (d.list ?? [])
        .map((s) => {
          const 라벨 = s.name ?? `${s.at.slice(0, 10)} ${s.auto ? '(자동)' : ''}`
          return `<option value="${esc(s.id)}"${d.current === s.id ? ' selected' : ''}>${esc(라벨)}</option>`
        })
        .join('')
    ver.classList.toggle('past', Boolean(d.current))
    const 고른것 = (d.list ?? []).find((s) => s.id === d.current)
    경고.textContent = 고른것?.code
      ? `과거 기획안 · 그때 코드 ${고른것.code.branch}@${고른것.code.commit}`
      : ''
  }

  ver.addEventListener('change', async () => {
    await fetch(`${BASE}/snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: ver.value }),
    })
    specsRaw = '' // 설명을 다시 받아온다
    await fetchSpecs()
    await 버전목록()
  })

  // 지금 어느 브랜치를 보고 있는지 툴바에 띄운다.
  // 동료가 자기 브랜치를 보면서 남의 화면 얘기를 하는 사고를 막는다.
  async function 지금상태() {
    try {
      // 공유 링크에는 서버가 없다. 구울 때 그 기획 건 화면에 박아둔 값을 읽는다.
      const d = 혼자서
        ? { branch: window.__PK_PLAN?.branch ?? null, mockMode: 'all' }
        : await (await fetch(`${BASE}/status`)).json()
      const where = root.getElementById('where')
      where.textContent = d.branch ? d.branch : '기획 도구'
      where.title = [
        d.branch ? `프론트 브랜치: ${d.branch}` : '프론트 브랜치를 읽지 못했습니다 (.env 의 FRONT_REPO)',
        `목업: ${d.mockMode}`,
      ].join(' · ')
    } catch {
      /* 다음에 */
    }
  }

  // 기획 건마다 프론트 갈래가 달라 화면 자체가 다른 프로그램이다. 그래서 건을 바꾸는 것은
  // 같은 화면 안에서 값을 갈아끼우는 게 아니라 그 건의 자리로 넘어가는 일이 된다.
  function 기획건고르개() {
    const sel = root.getElementById('plan')
    const 건들 = (혼자서 && window.__PK_PLANS) || []
    if (건들.length < 2) return sel.remove()
    sel.innerHTML = 건들.map((p) => `<option value="${esc(p.slug)}">${esc(p.title)}</option>`).join('')
    sel.value = window.__PK_PLAN?.slug ?? 건들[0].slug
    sel.addEventListener('change', () => {
      const 건 = 건들.find((p) => p.slug === sel.value)
      // 뿌리 실행기가 이 값을 받아 그 건의 화면을 띄우고 주소를 start 로 되돌린다
      if (건) location.href = `/?plan=${encodeURIComponent(건.slug)}&go=${encodeURIComponent(건.start ?? '/')}`
    })
  }
  기획건고르개()

  // 공유 링크에는 한 자리에 여러 경우(성공·실패·느림)가 같이 실려 온다.
  // 기획안대로 처리되는지 보려면 보는 사람이 직접 실패 화면을 눌러볼 수 있어야 한다.
  function 목업고르개() {
    const 칸 = root.getElementById('mocks')
    const 묶음들 = (혼자서 && window.__pkMock?.묶음들) || []
    // 경우가 하나뿐인 자리는 고를 것이 없으니 내놓지 않는다
    const 고를것 = 묶음들.filter((g) => g.options.length > 1)
    if (!고를것.length) return

    for (const g of 고를것) {
      const sel = document.createElement('select')
      sel.className = 'mock'
      sel.title = `${g.label} — 화면이 어떻게 반응하는지 골라 봅니다`
      const 지금 = window.__pkMock.지금(g.key)
      sel.innerHTML =
        g.options.map((o, i) => `<option value="${i}">${esc(g.label)}: ${esc(o.label)}</option>`).join('') +
        `<option value="-1">${esc(g.label)}: 목업 끔</option>`
      sel.value = String(지금)
      sel.addEventListener('change', () => window.__pkMock.고르기(g.key, Number(sel.value)))
      칸.appendChild(sel)
    }
  }
  목업고르개()

  // 공유 링크에서 깃랩 로그인을 마치고 돌아온 길이면 여기서 출입증으로 바꾼다.
  const 깃랩복귀 = 혼자서 && window.__pkGitlab ? window.__pkGitlab.돌아옴().catch(() => false) : Promise.resolve(false)

  깃랩복귀.then(() => fetchSpecs()).then(fetchComments).then(버전목록).then(지금상태)
  setInterval(지금상태, 10000)
  setInterval(fetchSpecs, POLL_MS)
  setInterval(fetchComments, 5000)
})()
