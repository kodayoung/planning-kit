// 목업 응답. mocks/routes.yaml 을 읽어서 "이 요청은 가짜로 답한다"를 판단한다.
import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'

const MOCKS_DIR = path.resolve('mocks')
const ROUTES_FILE = path.join(MOCKS_DIR, 'routes.yaml')

// 마지막으로 성공적으로 읽은 내용. YAML 을 잘못 고쳐도 서버가 멈추지 않도록 붙잡아 둔다.
let lastGood = []
let lastError = null

function loadRoutes() {
  let raw
  try {
    raw = fs.readFileSync(ROUTES_FILE, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return [] // 아직 목업을 안 만든 상태
    throw err
  }
  try {
    const parsed = parse(raw) ?? []
    if (!Array.isArray(parsed)) {
      throw new Error('맨 바깥이 "- " 로 시작하는 목록이어야 합니다')
    }
    lastGood = parsed
    if (lastError) {
      console.log('✓  mocks/routes.yaml 을 다시 읽었습니다.')
      lastError = null
    }
  } catch (err) {
    if (lastError !== err.message) {
      console.error(`\n⚠  mocks/routes.yaml 을 읽지 못했습니다. 직전에 읽은 내용을 계속 씁니다.\n   ${err.message}\n`)
      lastError = err.message
    }
  }
  return lastGood
}

function matchPath(pattern, pathname) {
  if (typeof pattern !== 'string') return false
  if (pattern.endsWith('*')) return pathname.startsWith(pattern.slice(0, -1))
  return pattern === pathname
}

/** 이 요청에 해당하는 목업 규칙을 찾는다. 없으면 undefined. */
export function findMock(method, pathname) {
  return loadRoutes().find(
    (route) =>
      route &&
      route.enabled !== false &&
      String(route.method ?? 'GET').toUpperCase() === method.toUpperCase() &&
      matchPath(route.path, pathname),
  )
}

/** 목업 규칙대로 응답한다. */
export function sendMock(route, req, res) {
  req.resume() // 요청 본문을 흘려보내야 업로드가 멈추지 않는다

  let body = ''
  if (route.file) {
    const file = path.join(MOCKS_DIR, route.file)
    try {
      body = fs.readFileSync(file, 'utf8')
    } catch (err) {
      const message = `목업 응답 파일을 읽지 못했습니다: mocks/${route.file}\n${err.message}`
      console.error(`\n⚠  ${message}\n`)
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end(message)
      return
    }
  }

  const status = Number(route.status ?? 200)
  const delay = Number(route.delay ?? 0)

  setTimeout(() => {
    if (res.writableEnded) return
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    })
    res.end(body)
  }, delay)
}
