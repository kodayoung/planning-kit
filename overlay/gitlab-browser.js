// 공유 링크에서 쓰는 깃랩 창구. 서버가 없으므로 브라우저가 깃랩에 직접 말한다.
//
// 토큰을 묶음에 넣어 돌리면 링크를 받은 사람 누구나 그 토큰으로 글을 쓸 수 있다.
// 그래서 넣지 않는다. 대신 보는 사람이 자기 깃랩 계정으로 로그인하고,
// 그 사람 브라우저 안에서만 사는 출입증으로 자기 이름을 달고 코멘트를 쓴다.
//
// 돌려주는 모양은 proxy/server.js 의 /__spec/comments 와 같다. overlay.js 가 양쪽을 구분하지 않게.
;(() => {
  const cfg = window.__PK_GITLAB
  if (!cfg?.host) return

  const HOST = cfg.host.replace(/\/+$/, '')
  const PROJECT = cfg.project
  const CLIENT = cfg.clientId || ''
  const REDIRECT = cfg.redirect || `${location.origin}/`
  const 키 = { token: 'pk.gl.token', verifier: 'pk.gl.verifier', state: 'pk.gl.state', back: 'pk.gl.back' }

  const 저장소 = {
    get: (k) => {
      try {
        return sessionStorage.getItem(k)
      } catch {
        return null
      }
    },
    set: (k, v) => {
      try {
        sessionStorage.setItem(k, v)
      } catch {
        /* 사생활 보호 창에서는 못 쓴다. 그 경우 매번 로그인한다. */
      }
    },
    del: (k) => {
      try {
        sessionStorage.removeItem(k)
      } catch {
        /* 위와 같다 */
      }
    },
  }

  /* ---------------- 로그인 (OAuth PKCE) ---------------- */
  // 비밀값 없이 도는 방식이다. 묶음 안에 감출 것이 아무것도 없다.

  const 무작위 = () => {
    const a = new Uint8Array(32)
    crypto.getRandomValues(a)
    return [...a].map((b) => b.toString(16).padStart(2, '0')).join('')
  }

  const base64url = (buf) =>
    btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')

  async function login() {
    if (!CLIENT) throw new Error('깃랩 앱이 아직 등록되지 않았습니다')
    const verifier = 무작위()
    const state = 무작위()
    저장소.set(키.verifier, verifier)
    저장소.set(키.state, state)
    // 로그인하고 돌아온 뒤 보던 화면으로 되돌아가려고 적어둔다
    저장소.set(키.back, location.pathname + location.search)
    const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))
    const q = new URLSearchParams({
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      response_type: 'code',
      state,
      scope: 'api',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    })
    location.href = `${HOST}/oauth/authorize?${q}`
  }

  /** 로그인하고 돌아왔을 때 출입증으로 바꾼다. 주소창에 남은 코드는 지운다. */
  async function 돌아옴() {
    const q = new URLSearchParams(location.search)
    const code = q.get('code')
    if (!code) return false
    const verifier = 저장소.get(키.verifier)
    const 기대한state = 저장소.get(키.state)
    저장소.del(키.verifier)
    저장소.del(키.state)
    // state 가 다르면 내가 시작한 로그인이 아니다. 버린다.
    if (!verifier || q.get('state') !== 기대한state) return false

    const res = await fetch(`${HOST}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: CLIENT,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }),
    })
    if (!res.ok) throw new Error(`로그인 실패 ${res.status}`)
    const t = await res.json()
    저장소.set(키.token, t.access_token)
    const back = 저장소.get(키.back) || '/'
    저장소.del(키.back)
    history.replaceState(null, '', back)
    return true
  }

  const token = () => 저장소.get(키.token)
  const logout = () => 저장소.del(키.token)

  /* ---------------- 깃랩 부르기 ---------------- */

  const api = async (path, init = {}) => {
    const t = token()
    if (!t) throw Object.assign(new Error('로그인이 필요합니다'), { needLogin: true })
    const res = await fetch(`${HOST}/api/v4/projects/${encodeURIComponent(PROJECT)}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    })
    if (res.status === 401) {
      // 출입증이 만료됐다. 다시 로그인하면 된다.
      logout()
      throw Object.assign(new Error('로그인이 만료됐습니다'), { needLogin: true })
    }
    if (!res.ok) throw new Error(`깃랩 응답 ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
    return res.status === 204 ? null : res.json()
  }

  /* 아래 표시 규칙은 proxy/gitlab.js 와 글자 하나까지 같아야 한다.
     다르면 링크에서 단 코멘트를 도구가 못 읽고, 그 반대도 마찬가지다. */
  const RESOLVED = '[해결]'
  const tagLine = (specId, branch, at) =>
    `[spec:${specId}]${branch ? ` [branch:${branch}]` : ''}${at ? ` [at:${JSON.stringify(at)}]` : ''}`
  const strip = (body) =>
    body
      .replace(/^\[spec:[^\]]*\]\s*/, '')
      .replace(/^\[branch:[^\]]*\]\s*/, '')
      .replace(/^\[at:\{.*?\}\]\s*/, '')
      .trim()

  async function listThreads(issue) {
    const discussions = await api(`/issues/${issue}/discussions?per_page=100`)
    return (discussions ?? [])
      .map((d) => {
        const notes = (d.notes ?? []).filter((n) => !n.system)
        if (!notes.length) return null
        const first = notes[0]
        let at = null
        const atRaw = first.body.match(/\[at:(\{.*?\})\]/)
        if (atRaw) {
          try {
            at = JSON.parse(atRaw[1])
          } catch {
            at = null
          }
        }
        return {
          id: d.id,
          specId: (first.body.match(/^\[spec:([^\]]+)\]/) ?? [])[1] ?? null,
          branch: (first.body.match(/\[branch:([^\]]+)\]/) ?? [])[1] ?? null,
          at,
          resolved: notes.some((n) => n.body.trim().startsWith(RESOLVED)),
          notes: notes.map((n) => ({
            id: n.id,
            author: n.author?.name ?? n.author?.username ?? '?',
            username: n.author?.username ?? '',
            at: n.created_at,
            body: strip(n.body),
            resolveMark: n.body.trim().startsWith(RESOLVED),
          })),
        }
      })
      .filter(Boolean)
  }

  window.__pkGitlab = {
    설정됨: Boolean(CLIENT),
    로그인됨: () => Boolean(token()),
    login,
    logout,
    돌아옴,

    /** GET /__spec/comments?issue= 와 같은 모양 */
    async comments(issue) {
      if (!CLIENT) return { off: true, message: '깃랩 코멘트: 꺼짐 (깃랩 앱 미등록)' }
      if (!token()) return { off: true, message: '깃랩 코멘트: 로그인하면 볼 수 있습니다', needLogin: true }
      return {
        threads: await listThreads(issue),
        branch: cfg.branch ?? null,
        issueUrl: `${HOST}/${PROJECT}/-/issues/${issue}`,
        defaultIssue: cfg.defaultIssue ?? null,
      }
    },

    /** POST /__spec/comments 와 같은 모양 */
    async post(payload, path = '') {
      if (path.endsWith('/resolve')) {
        await api(`/issues/${payload.issue}/discussions/${payload.discussionId}/notes`, {
          method: 'POST',
          body: JSON.stringify({ body: payload.resolved ? `${RESOLVED} 확인했습니다.` : '[재검토] 다시 봅니다.' }),
        })
      } else if (payload.discussionId) {
        await api(`/issues/${payload.issue}/discussions/${payload.discussionId}/notes`, {
          method: 'POST',
          body: JSON.stringify({ body: payload.body }),
        })
      } else {
        // 공유 링크는 구울 때의 프론트 갈래를 본다. 그걸 그대로 박는다.
        await api(`/issues/${payload.issue}/discussions`, {
          method: 'POST',
          body: JSON.stringify({ body: `${tagLine(payload.specId, cfg.branch, payload.at)}\n\n${payload.body}` }),
        })
      }
      return { threads: await listThreads(payload.issue) }
    },

    async members(q = '') {
      if (!token()) return []
      const list = await api(`/members/all?per_page=50${q ? `&query=${encodeURIComponent(q)}` : ''}`)
      return (list ?? []).map((m) => ({ username: m.username, name: m.name }))
    },

    async me() {
      const t = token()
      if (!t) return null
      try {
        const res = await fetch(`${HOST}/api/v4/user`, { headers: { Authorization: `Bearer ${t}` } })
        if (!res.ok) return null
        const u = await res.json()
        return { name: u.name, username: u.username }
      } catch {
        return null
      }
    },
  }
})()
