// 역할·이름·글자로 화면 요소를 찾는 규칙 (Playwright 흉내).
// 스티커를 붙이는 overlay.js 와 자리를 점검하는 scripts/check-specs.js 가 **같은 파일**을 쓴다.
// 둘이 따로 구현하면 점검 결과가 거짓말이 된다.
;(() => {
  if (window.__pkLocator) return

  const INPUT_ROLE = {
    checkbox: 'checkbox',
    radio: 'radio',
    button: 'button',
    submit: 'button',
    reset: 'button',
    range: 'slider',
    search: 'searchbox',
    number: 'spinbutton',
  }

  function implicitRole(el) {
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : null
    if (tag === 'button') return 'button'
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'img') return 'img'
    if (tag === 'table') return 'table'
    if (tag === 'nav') return 'navigation'
    if (tag === 'main') return 'main'
    if (tag === 'form') return 'form'
    if (tag === 'ul' || tag === 'ol') return 'list'
    if (tag === 'li') return 'listitem'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'input') return INPUT_ROLE[(el.type || 'text').toLowerCase()] ?? 'textbox'
    return null
  }

  const roleOf = (el) => el.getAttribute('role') || implicitRole(el)
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim()

  function nameOf(el) {
    const label = el.getAttribute('aria-label')
    if (label) return norm(label)

    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const text = by
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? '')
        .join(' ')
      if (norm(text)) return norm(text)
    }

    if (el.tagName === 'IMG') return norm(el.getAttribute('alt'))
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      const labelText = el.labels?.[0]?.textContent
      if (norm(labelText)) return norm(labelText)
      return norm(el.getAttribute('placeholder'))
    }
    return norm(el.textContent)
  }

  function findAll(locator, scope = document) {
    if (!locator) return []
    if (locator.css) {
      try {
        return [...scope.querySelectorAll(locator.css)]
      } catch {
        return []
      }
    }
    // text: 화면에 보이는 글자로 찾는다. 버튼도 표도 아닌 것(제목, 영역 이름)에 쓴다.
    // 같은 글자를 가진 부모가 줄줄이 잡히므로 "가장 안쪽" 것만 남긴다.
    if (locator.text) {
      const want = norm(locator.text).toLowerCase()
      const hits = []
      for (const el of scope.querySelectorAll('*')) {
        if (el.closest('[aria-hidden="true"]')) continue
        const got = norm(el.textContent).toLowerCase()
        if (locator.exact === false ? got.includes(want) : got === want) hits.push(el)
      }
      return hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)))
    }
    const want = norm(locator.name).toLowerCase()
    const out = []
    for (const el of scope.querySelectorAll('*')) {
      // aria-hidden 은 화면 장식용이라 접근성 트리에 없다. 같은 요소가 두 개로 잡히는 주범.
      if (el.closest('[aria-hidden="true"]')) continue
      if (locator.role && roleOf(el) !== locator.role) continue
      if (want) {
        const got = nameOf(el).toLowerCase()
        if (locator.exact === false ? !got.includes(want) : got !== want) continue
      }
      out.push(el)
    }
    return out
  }

  function resolve(element) {
    let scope = document
    if (element.within) {
      const parent = findAll(element.within)[0]
      if (!parent) return []
      scope = parent
    }
    // locator 를 목록으로 적으면 후보를 위에서부터 본다.
    // 딱 1개를 잡는 후보를 먼저 쓰고, 그런 게 없을 때만 여러 개 잡힌 것을 쓴다.
    if (Array.isArray(element.locator)) {
      let fallback = []
      for (const candidate of element.locator) {
        const found = findAll(candidate, scope)
        if (found.length === 1) return found
        if (found.length && !fallback.length) fallback = found
      }
      return fallback
    }
    return findAll(element.locator, scope)
  }

  /** 못 찾았을 때 "그럼 화면엔 뭐가 있나"를 뽑아 고칠 후보를 제안한다. */
  function candidates(locator, limit = 6) {
    const wanted = Array.isArray(locator) ? locator[0] : locator
    if (!wanted) return []
    const want = norm(wanted.name ?? wanted.text ?? '').toLowerCase()

    const rows = []
    for (const el of document.querySelectorAll('*')) {
      if (el.closest('[aria-hidden="true"]')) continue
      const r = el.getBoundingClientRect()
      if (r.width === 0 && r.height === 0) continue
      const role = roleOf(el)
      const name = wanted.text ? norm(el.textContent) : nameOf(el)
      if (!name || name.length > 60) continue
      // 개발용 도구 패널(TanStack Devtools)은 제품 화면이 아니라서 후보에서 뺀다
      if (/TanStack/i.test(name) || /^\S+\d+ items$/.test(name)) continue
      if (el.closest('[class*="TanStack"],[id*="tanstack"],[data-tanstack]')) continue
      // 역할을 지정했으면 같은 역할만, 아니면 전부
      if (wanted.role && role !== wanted.role) continue
      rows.push({ role, name })
    }

    // 같은 이름 중복 제거 + 원하는 글자와 비슷한 순으로
    const seen = new Set()
    const uniq = rows.filter((r) => {
      const k = `${r.role}|${r.name}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    const score = (s) => {
      const t = s.toLowerCase()
      if (!want) return 0
      if (t === want) return 100
      if (t.includes(want) || want.includes(t)) return 60
      const common = [...new Set(want)].filter((ch) => t.includes(ch)).length
      return (common / Math.max(want.length, 1)) * 40
    }
    return uniq
      .map((r) => ({ ...r, score: score(r.name) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }

  /**
   * 아무 요소나 찍었을 때, 나중에 다시 찾아갈 수 있는 지정 방식을 만든다.
   * 역할+글자로 잡히면 그걸 쓰고(사람이 읽을 수 있음), 안 되면 CSS 경로로 떨어진다.
   */
  function describe(el) {
    const role = roleOf(el)
    const name = nameOf(el)
    if (role && name && name.length <= 60) {
      const cand = { role, name }
      if (findAll(cand).length === 1) return cand
    }
    if (name && name.length <= 60) {
      const cand = { text: name }
      if (findAll(cand).length === 1) return cand
    }
    // 마지막 수단: 부모를 거슬러 올라가며 짧은 CSS 경로를 만든다
    const parts = []
    for (let cur = el; cur && cur !== document.body && parts.length < 5; cur = cur.parentElement) {
      if (cur.id) {
        parts.unshift(`#${CSS.escape(cur.id)}`)
        break
      }
      const tag = cur.tagName.toLowerCase()
      const sibs = [...(cur.parentElement?.children ?? [])].filter((x) => x.tagName === cur.tagName)
      parts.unshift(sibs.length > 1 ? `${tag}:nth-of-type(${sibs.indexOf(cur) + 1})` : tag)
    }
    return { css: parts.join(' > ') }
  }

  /** 찍은 자리를 사람이 알아볼 이름으로 (카드 제목용) */
  function labelFor(el) {
    const name = nameOf(el)
    if (name) return name.length > 30 ? name.slice(0, 30) + '…' : name
    return el.tagName.toLowerCase()
  }

  /**
   * 드래그로 잡은 범위를 다시 찾아갈 수 있게 저장한다.
   * 화면 좌표 그대로 두면 창 크기만 바뀌어도 엉뚱한 데를 가리킨다.
   * 그래서 "그 범위를 품고 있는 요소" 를 기준으로 삼고, 그 안에서의 비율로 적어둔다.
   */
  function describeRegion(rect) {
    let anchor = document.body
    let best = Infinity
    for (const el of document.querySelectorAll('*')) {
      if (el.closest('#__planning_kit_overlay__')) continue
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      const 품는다 =
        r.left <= rect.left + 1 && r.top <= rect.top + 1 &&
        r.right >= rect.right - 1 && r.bottom >= rect.bottom - 1
      if (!품는다) continue
      const 넓이 = r.width * r.height
      if (넓이 < best) {
        best = 넓이
        anchor = el
      }
    }
    const a = anchor.getBoundingClientRect()
    return {
      el: describe(anchor),
      box: {
        x: (rect.left - a.left) / a.width,
        y: (rect.top - a.top) / a.height,
        w: rect.width / a.width,
        h: rect.height / a.height,
      },
    }
  }

  /** 저장해둔 위치(요소든 범위든)를 지금 화면의 사각형으로 바꾼다. 못 찾으면 null. */
  function rectOf(at) {
    if (!at) return null
    if (at.box && at.el) {
      const anchor = findAll(at.el)[0]
      if (!anchor) return null
      const a = anchor.getBoundingClientRect()
      return {
        left: a.left + at.box.x * a.width,
        top: a.top + at.box.y * a.height,
        width: at.box.w * a.width,
        height: at.box.h * a.height,
      }
    }
    const el = findAll(at)[0]
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { left: r.left, top: r.top, width: r.width, height: r.height }
  }

  window.__pkLocator = {
    findAll, resolve, roleOf, nameOf, norm, candidates, describe, labelFor, describeRegion, rectOf,
  }
})()
