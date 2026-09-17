// 공유 링크용. 백엔드도 프록시도 없이 브라우저 안에서만 도는 상태를 만든다.
// 앱보다 먼저 실행돼야 한다 (앱이 첫 요청을 보내기 전에 가로채야 해서).
//
// 답할 거리는 두 종류다. 순서가 중요하다.
//   1) 목업 규칙 (mocks/routes.yaml) — 기획자가 일부러 정한 것. 성공·실패·지연까지 정한 대로.
//   2) 받아둔 응답 (MOCK_MODE=record) — 실제 서버가 준 것을 그대로 재생.
// 일부러 정한 것이 언제나 이긴다. 아직 없는 기능은 1) 로만 볼 수 있다.
;(() => {
  const BASE = '/__spec'
  const 받아둔것 = window.__PK_MOCKS ?? {}
  const 묶음들 = window.__PK_MOCK_GROUPS ?? []
  const 없는것 = new Set()
  const 고른것키 = 'pk.mock.pick'

  // 같은 자리에 여러 경우(성공·실패·느림)가 실려 온다. 보는 사람이 고른 것을 기억한다.
  // 기획안대로 되는지 보려면 실패 화면도 눌러볼 수 있어야 한다.
  let 고른것 = {}
  try {
    고른것 = JSON.parse(sessionStorage.getItem(고른것키) ?? '{}')
  } catch {
    고른것 = {}
  }

  /** 주소에서 /api 부터를 떼어낸다. 하위 폴더에 배포돼 앞에 뭐가 붙어도 되게. */
  function apiOf(url) {
    let pathname
    try {
      pathname = new URL(url, location.origin).pathname
    } catch {
      return null
    }
    const i = pathname.indexOf('/api')
    return i === -1 ? null : pathname.slice(i)
  }

  /** 받아둔 파일 이름 규칙 (프록시의 받아적기와 같다) */
  const 열쇠 = (method, api) => `${method.toUpperCase()}_${api.replace(/^\/+/, '').replace(/[\\/:*?"<>|]/g, '_')}`

  // proxy/mock.js 의 matchPath 와 같은 규칙이어야 한다. 다르면 도구와 링크가 다르게 답한다.
  const 경로맞나 = (pattern, api) =>
    typeof pattern === 'string' && (pattern.endsWith('*') ? api.startsWith(pattern.slice(0, -1)) : pattern === api)

  /** 이 자리에 지금 고른 경우. 없으면(끄기) null. */
  function 규칙찾기(method, api) {
    const g = 묶음들.find((x) => x.method === method.toUpperCase() && 경로맞나(x.path, api))
    if (!g) return null
    const i = 고른것[g.key] ?? g.pick
    return i >= 0 && g.options[i] ? { ...g.options[i], name: `${g.label} · ${g.options[i].label}` } : null
  }

  // 화면에서 경우를 고를 수 있게 내어준다 (툴바가 쓴다).
  window.__pkMock = {
    묶음들,
    지금(key) {
      const g = 묶음들.find((x) => x.key === key)
      return 고른것[key] ?? g?.pick ?? -1
    },
    고르기(key, index) {
      고른것[key] = index
      try {
        sessionStorage.setItem(고른것키, JSON.stringify(고른것))
      } catch {
        /* 사생활 보호 창에서는 못 쓴다. 새로고침 전까지만 유지된다. */
      }
      // 화면이 이미 받아둔 답을 들고 있어서, 새로 고쳐야 바뀐 경우가 보인다.
      location.reload()
    },
  }

  /** 받아둔 응답. 없으면 빈 목록으로 답한다 — 화면이 깨지는 것보다 낫다. */
  function 받아둔찾기(method, api) {
    const k = 열쇠(method, api)
    if (받아둔것[k] !== undefined) return 받아둔것[k]

    // id 가 들어간 주소는 같은 모양의 것을 하나 빌려 쓴다
    const 모양 = k.replace(/_[0-9a-f]{32}(?=_|$)/g, '_{id}')
    for (const [key, val] of Object.entries(받아둔것)) {
      if (key.replace(/_[0-9a-f]{32}(?=_|$)/g, '_{id}') === 모양) return val
    }

    if (!없는것.has(k)) {
      없는것.add(k)
      console.warn(`[공유링크] 받아둔 응답이 없습니다: ${method} ${api}`)
    }
    return { content: [], totalElements: 0, totalPages: 0, number: 0, size: 0 }
  }

  /** 이 요청에 무엇으로 답할지 정한다. { body, status, delay } 또는 null(가로채지 않음) */
  function 답할것(method, url) {
    if (String(url).includes(BASE)) return null // 기획 도구 자기 파일은 그대로
    const api = apiOf(url)
    if (!api) return null

    const rule = 규칙찾기(method, api)
    if (rule) {
      console.log(`[공유링크] 목업: ${rule.name} → ${rule.status}`)
      return { body: rule.body ?? '', status: Number(rule.status ?? 200), delay: Number(rule.delay ?? 0) }
    }
    return { body: JSON.stringify(받아둔찾기(method, api)), status: 200, delay: 0 }
  }

  const 잠시 = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : null)

  /* fetch 가로채기 */
  const 원래fetch = window.fetch
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url ?? String(input))
    const method = init?.method ?? (typeof input === 'object' ? input?.method : null) ?? 'GET'
    const 답 = 답할것(method, url)
    if (!답) return 원래fetch.apply(this, arguments)
    const 만들기 = () =>
      new Response(답.body, {
        status: 답.status,
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      })
    const 기다림 = 잠시(답.delay)
    return 기다림 ? 기다림.then(만들기) : Promise.resolve(만들기())
  }

  /* XHR 가로채기 (axios 가 이걸 쓴다) */
  const XHR = window.XMLHttpRequest
  const open = XHR.prototype.open
  const send = XHR.prototype.send
  XHR.prototype.open = function (method, url, ...rest) {
    this.__pk = { method, url }
    return open.call(this, method, url, ...rest)
  }
  XHR.prototype.send = function (body) {
    const info = this.__pk
    const 답 = info ? 답할것(info.method, info.url) : null
    if (!답) return send.call(this, body)

    Object.defineProperty(this, 'readyState', { value: 4, configurable: true })
    Object.defineProperty(this, 'status', { value: 답.status, configurable: true })
    Object.defineProperty(this, 'responseText', { value: 답.body, configurable: true })
    Object.defineProperty(this, 'response', { value: 답.body, configurable: true })
    this.getAllResponseHeaders = () => 'content-type: application/json; charset=utf-8'
    this.getResponseHeader = (h) => (/content-type/i.test(h) ? 'application/json; charset=utf-8' : null)
    setTimeout(() => {
      this.onreadystatechange?.()
      this.dispatchEvent?.(new Event('readystatechange'))
      this.dispatchEvent?.(new Event('load'))
      this.dispatchEvent?.(new Event('loadend'))
    }, 답.delay)
  }

  console.log(
    `[공유링크] 목업 자리 ${묶음들.length}곳 · 받아둔 응답 ${Object.keys(받아둔것).length}건으로 돕니다. 백엔드에 연결하지 않습니다.`,
  )
})()
