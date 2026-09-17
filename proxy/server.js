// 중간 창구(프록시).
// 브라우저 → localhost:4000 (여기) → 프론트 개발 서버 → 백엔드
// 하는 일 세 가지:
//   1. 목업 규칙에 걸리는 요청만 가짜로 답한다
//   2. HTML 응답에 설명 스티커 스크립트를 끼워 넣는다
//   3. 나머지는 그대로 통과시킨다
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import httpProxy from 'http-proxy'
import { findMock, sendMock } from './mock.js'
import { specsForRoute } from './specs.js'
import { kbStatus, listSnapshots, useSnapshot, currentSnapshot, refreshRemote, remoteInfo } from './kb.js'
import { remoteStatus } from './kbremote.js'
import * as gitlab from './gitlab.js'
import { historyOf } from './history.js'

const FRONT_URL = process.env.FRONT_URL ?? 'http://localhost:3000'
const PORT = Number(process.env.PORT ?? 4000)
const MOCK_MODE = process.env.MOCK_MODE ?? 'partial' // off | partial | all | record
const RECORD_DIR = path.resolve('mocks/recorded')

const OVERLAY_BASE = '/__spec'
// locator.js 가 먼저 와야 한다. overlay.js 가 그 안의 규칙을 쓴다.
const OVERLAY_FILES = { 'locator.js': path.resolve('overlay/locator.js'), 'overlay.js': path.resolve('overlay/overlay.js') }
const OVERLAY_TAG =
  `<script src="${OVERLAY_BASE}/locator.js"></script><script src="${OVERLAY_BASE}/overlay.js"></script>`

// 화면 파일(.tsx, .css, 이미지)이 아니라 "데이터를 가져오는 요청"만 골라내는 기준
const API_PREFIXES = ['/api', '/file-server']
const isApi = (pathname) => API_PREFIXES.some((prefix) => pathname.startsWith(prefix))

const proxy = httpProxy.createProxyServer({
  target: FRONT_URL,
  ws: true, // 자동 새로고침(HMR)용 웹소켓도 넘긴다
  changeOrigin: true,
  xfwd: true,
  selfHandleResponse: true, // HTML 에 스크립트를 끼워 넣으려면 응답을 직접 다뤄야 한다
})

proxy.on('proxyReq', (proxyReq, req) => {
  // 압축돼서 오면 본문을 열어볼 수 없다. 로컬이라 압축 이득도 없으니 끈다.
  proxyReq.removeHeader('accept-encoding')
  // 화면 요청에는 "안 바뀌었으면 보내지 마" 를 떼어낸다. 304 로 오면 본문이 없어서
  // 스크립트를 끼워 넣을 수가 없고, 브라우저는 스크립트 없는 옛날 HTML 을 쓰게 된다.
  if ((req.headers.accept ?? '').includes('text/html')) {
    proxyReq.removeHeader('if-none-match')
    proxyReq.removeHeader('if-modified-since')
  }
})

proxy.on('proxyRes', (proxyRes, req, res) => {
  const headers = { ...proxyRes.headers }

  // Domain=... 이 붙어 있으면 localhost:4000 에서 쿠키가 버려진다. 떼어내고 host-only 로 만든다.
  if (headers['set-cookie']) {
    headers['set-cookie'] = headers['set-cookie'].map((c) => c.replace(/;\s*Domain=[^;]*/gi, ''))
  }

  const pathname = req.url.split('?')[0]
  if (isApi(pathname)) console.log(`[실제] ${req.method} ${pathname} → ${proxyRes.statusCode}`)

  // 받아 적기: 진짜 응답을 그대로 흘려보내면서 사본을 남긴다.
  // 화면을 한 번 훑으면 공유용 가짜 데이터가 저절로 쌓인다.
  if (MOCK_MODE === 'record' && isApi(pathname) && (headers['content-type'] ?? '').includes('json')) {
    const chunks = []
    res.writeHead(proxyRes.statusCode, headers)
    proxyRes.on('data', (c) => {
      chunks.push(c)
      res.write(c)
    })
    proxyRes.on('end', () => {
      res.end()
      try {
        const body = Buffer.concat(chunks).toString('utf8')
        JSON.parse(body) // 깨진 건 안 적는다
        fs.mkdirSync(RECORD_DIR, { recursive: true })
        const name = `${req.method}_${pathname.replace(/^\/+/, '').replace(/[\/:*?"<>|]/g, '_')}.json`
        const file = path.join(RECORD_DIR, name)
        const 처음 = !fs.existsSync(file)
        fs.writeFileSync(file, body, 'utf8')
        if (처음) console.log(`[받아적음] ${req.method} ${pathname} → mocks/recorded/${name}`)
      } catch {
        /* JSON 이 아니면 넘어간다 */
      }
    })
    return
  }

  if (!(headers['content-type'] ?? '').includes('text/html')) {
    res.writeHead(proxyRes.statusCode, headers)
    proxyRes.pipe(res)
    return
  }

  const chunks = []
  proxyRes.on('data', (c) => chunks.push(c))
  proxyRes.on('end', () => {
    let body = Buffer.concat(chunks).toString('utf8')
    body = body.includes('</body>') ? body.replace('</body>', `${OVERLAY_TAG}</body>`) : body + OVERLAY_TAG
    // 본문을 고쳤으니 프론트 서버가 준 캐시 검증표는 더 이상 유효하지 않다.
    // 그대로 넘기면 브라우저가 304 를 받고 스크립트 없는 옛날 HTML 을 다시 쓴다.
    delete headers['content-length']
    delete headers.etag
    delete headers['last-modified']
    res.writeHead(proxyRes.statusCode, {
      ...headers,
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  })
})

proxy.on('error', (err, req, res) => {
  const down = err.code === 'ECONNREFUSED'
  const message = down
    ? `프론트 개발 서버(${FRONT_URL})가 꺼져 있습니다.\n프론트 레포에서 먼저 pnpm dev 를 실행한 뒤 새로고침하세요.`
    : `프록시 오류: ${err.message}`
  console.error(`\n⚠  ${message}\n`)
  if (res.writableEnded) return
  if (typeof res.writeHead === 'function') {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(message)
  } else {
    res.destroy() // 웹소켓 업그레이드는 socket 이 넘어온다
  }
})

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 1e6) reject(new Error('본문이 너무 큽니다'))
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (err) {
        reject(err)
      }
    })
    req.on('error', reject)
  })

const json = (res, data) => {
  const body = JSON.stringify(data)
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(body)
}

const server = http.createServer((req, res) => {
  const [pathname, query = ''] = req.url.split('?')

  // 1) 기획 도구 자신의 파일
  const overlayFile = pathname.startsWith(`${OVERLAY_BASE}/`) && OVERLAY_FILES[pathname.slice(OVERLAY_BASE.length + 1)]
  if (overlayFile) {
    res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(fs.readFileSync(overlayFile))
    return
  }
  // 지금 무엇을 보고 있는지 (툴바 표시용)
  if (pathname === `${OVERLAY_BASE}/status`) {
    return gitlab.frontBranch().then(
      (branch) => json(res, { branch, mockMode: MOCK_MODE, snapshot: currentSnapshot() }),
      () => json(res, { branch: null, mockMode: MOCK_MODE, snapshot: currentSnapshot() }),
    )
  }

  // 보관된 기획안 버전 목록 / 고르기
  if (pathname === `${OVERLAY_BASE}/snapshots`) {
    if (req.method === 'POST') {
      return readBody(req)
        .then((b) => {
          const id = useSnapshot(b.id)
          console.log(id ? `기획안 버전 전환: ${id}` : '기획안 버전: 지금 상태로 되돌림')
          json(res, { current: id })
        })
        .catch(() => json(res, { current: currentSnapshot() }))
    }
    return json(res, { current: currentSnapshot(), list: listSnapshots() })
  }
  if (pathname === `${OVERLAY_BASE}/history`) {
    const q = new URLSearchParams(query)
    return historyOf(q.get('menu'), q.get('pageId'), q.get('marker')).then(
      (data) => json(res, data),
      (err) => json(res, { off: true, message: String(err.message).slice(0, 200) }),
    )
  }
  if (pathname === `${OVERLAY_BASE}/all.json`) {
    return json(res, specsForRoute(null)) // 전부
  }
  // ── 깃랩 코멘트. 토큰은 여기서만 쓰고 브라우저로 내려보내지 않는다.
  if (pathname.startsWith(`${OVERLAY_BASE}/comments`) || pathname === `${OVERLAY_BASE}/members`) {
    const fail = (err) => {
      console.error(`⚠  깃랩 호출 실패: ${err.message}`)
      res.writeHead(err.status === 401 || err.status === 403 ? 403 : 502, {
        'Content-Type': 'application/json; charset=utf-8',
      })
      res.end(JSON.stringify({ message: err.message }))
    }
    if (!gitlab.gitlabReady) {
      req.resume()
      return json(res, { off: true, message: gitlab.gitlabStatus() })
    }
    const q = new URLSearchParams(query)

    if (req.method === 'GET' && pathname === `${OVERLAY_BASE}/members`) {
      return gitlab.members(q.get('q') ?? '').then((list) => json(res, list), fail)
    }
    if (req.method === 'GET') {
      const issue = q.get('issue')
      if (!issue) return json(res, { threads: [], branch: null })
      return Promise.all([gitlab.listThreads(issue), gitlab.frontBranch()]).then(
        ([threads, branch]) =>
          json(res, {
            threads,
            branch,
            issueUrl: gitlab.issueUrl(issue),
            defaultIssue: process.env.GITLAB_DEFAULT_ISSUE ?? null,
          }),
        fail,
      )
    }
    if (req.method === 'POST') {
      return readBody(req)
        .then(async (b) => {
          if (pathname.endsWith('/resolve')) {
            await gitlab.setResolved(b.issue, b.discussionId, b.resolved)
          } else if (b.discussionId) {
            await gitlab.reply(b.issue, b.discussionId, b.body)
          } else {
            await gitlab.addThread(b.issue, b.specId, await gitlab.frontBranch(), b.body, b.at)
          }
          const threads = await gitlab.listThreads(b.issue)
          json(res, { threads })
        })
        .catch(fail)
    }
  }

  if (pathname === `${OVERLAY_BASE}/specs.json`) {
    const route = new URLSearchParams(query).get('route') ?? '/'
    return json(res, specsForRoute(route))
  }

  // 2) 목업
  if (MOCK_MODE !== 'off') {
    const route = findMock(req.method, pathname)
    if (route) {
      const label = [route.name, route.status && route.status !== 200 ? `${route.status}` : null, route.delay ? `${route.delay}ms` : null]
        .filter(Boolean)
        .join(' · ')
      console.log(`[목업] ${req.method} ${pathname}${label ? `  (${label})` : ''}`)
      return sendMock(route, req, res)
    }
    if (MOCK_MODE === 'all' && isApi(pathname)) {
      console.warn(`[목업없음] ${req.method} ${pathname}  ← routes.yaml 에 추가하세요`)
      req.resume()
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ message: `목업이 없는 API 입니다: ${req.method} ${pathname}` }))
      return
    }
  }

  // 3) 그대로 통과
  proxy.web(req, res)
})

server.on('upgrade', (req, socket, head) => proxy.ws(req, socket, head))

// 기획안을 깃랩에서 받아온다. 프론트가 백엔드에서 데이터를 받아오듯,
// 기획안이 갱신되면 동료가 아무것도 안 해도 반영된다.
const 원격새로고침 = () => refreshRemote().catch(() => {})
원격새로고침()
setInterval(원격새로고침, 5 * 60 * 1000)

server.listen(PORT, () => {
  console.log(`기획 도구 중간 창구: http://localhost:${PORT}  →  ${FRONT_URL}`)
  const rs = remoteStatus()
  if (rs) console.log(rs)
  console.log(kbStatus())
  console.log(gitlab.gitlabStatus())
  gitlab.whoami().then((me) => {
    if (!me) return
    if (me.error) return console.error(`⚠  깃랩 토큰 확인 실패: ${me.error}`)
    if (me.scoped) return console.log('깃랩 계정: 프로젝트 한정 토큰 (첫 코멘트 등록 때 작성자를 확인합니다)')
    console.log(`깃랩 계정: ${me.name} (@${me.username})`)
    const expected = process.env.GITLAB_EXPECTED_USER
    if (expected && me.username !== expected) {
      console.warn(`
⚠  기대한 계정(@${expected})이 아닙니다. 이 계정으로 코멘트가 등록됩니다.`)
      console.warn(`   의도한 게 아니면 지금 멈추고 .env 의 GITLAB_TOKEN 을 확인하세요.
`)
    }
  })
  console.log(`목업 모드: ${MOCK_MODE}  (off = 전부 실제 / partial = routes.yaml 만 가짜 / all = 전부 가짜 / record = 실제로 쓰면서 응답을 받아적음)`)
  if (MOCK_MODE === 'record') console.log(`받아적는 곳: ${path.relative(process.cwd(), RECORD_DIR)}`)
})
