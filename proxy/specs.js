// 화면 설명 스펙. specs/*.yaml 을 읽어서 현재 화면 경로에 맞는 것만 골라준다.
import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { lookupKb } from './kb.js'

const SPECS_DIR = path.resolve('specs')

let lastGood = []
let lastError = null

function loadAll() {
  let files
  try {
    // specs/generated/ 같은 하위 폴더까지 훑는다
    files = fs
      .readdirSync(SPECS_DIR, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
      .map((e) => path.relative(SPECS_DIR, path.join(e.parentPath ?? e.path, e.name)))
  } catch (err) {
    if (err.code === 'ENOENT') return [] // 아직 스펙을 안 만든 상태
    throw err
  }

  const loaded = []
  const problems = []
  for (const file of files) {
    try {
      const doc = parse(fs.readFileSync(path.join(SPECS_DIR, file), 'utf8'))
      if (doc) loaded.push({ ...doc, _file: file })
    } catch (err) {
      problems.push(`${file}: ${err.message}`)
    }
  }

  if (problems.length) {
    const key = problems.join('|')
    if (lastError !== key) {
      console.error(`\n⚠  스펙 파일을 읽지 못했습니다. 직전에 읽은 내용을 계속 씁니다.\n   ${problems.join('\n   ')}\n`)
      lastError = key
    }
    // 하나라도 깨졌으면 직전 내용을 그대로 유지한다 (화면에서 스티커가 통째로 사라지지 않게)
    return lastGood
  }

  if (lastError) {
    console.log('✓  스펙 파일을 다시 읽었습니다.')
    lastError = null
  }
  lastGood = loaded
  return lastGood
}

// 경로 조각마다 * 를 쓸 수 있다. 예: /policy/agent/*/edit
// 레코드 id 가 들어가는 화면은 id 자리에 * 를 넣어야 어느 레코드에서든 맞는다.
function matchRoute(pattern, pathname) {
  if (!pattern) return false
  const trim = (s) => s.replace(/\/+$/, '')
  if (!pattern.includes('*')) return trim(pattern) === trim(pathname)

  const p = trim(pattern).split('/')
  const a = trim(pathname).split('/')
  for (let i = 0; i < p.length; i += 1) {
    if (p[i] === '**') return true // 여기부터 아래 전부
    if (p[i] === '*') continue
    if (p[i] !== a[i]) return false
  }
  return p.length === a.length
}

/** 현재 화면 경로에 해당하는 스펙만 돌려준다. kb 참조는 기획안 내용으로 바꿔서 준다. */
export function specsForRoute(pathname) {
  return loadAll()
    .filter((spec) => pathname === null || matchRoute(spec.route, pathname))
    .map((spec) => ({
      ...spec,
      elements: (spec.elements ?? []).map((element) => ({
        ...element,
        kbItem: lookupKb(element.kb, spec.kb),
      })),
    }))
}
