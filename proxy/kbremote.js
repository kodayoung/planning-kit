// 기획안을 깃랩에서 받아온다.
//
// 프론트가 사내 백엔드에 붙어 데이터를 받아오듯, 기획안도 한 곳에 두고 다들 거기서 받아간다.
// 그래야 기획안이 갱신될 때마다 동료가 파일을 다시 받지 않아도 된다.
//
// 받아온 것은 .cache/ 에 남겨 두고, 사내망 밖이거나 깃랩이 답이 없으면 그걸로 버틴다.
import fs from 'node:fs'
import path from 'node:path'

const CACHE = path.resolve('.cache')
const CACHE_FILE = path.join(CACHE, 'kb-remote.json')
const 유효시간 = 5 * 60 * 1000 // 5분에 한 번만 물어본다

const pick = (key) => {
  try {
    const line = fs.readFileSync('.env', 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'))
    if (line?.[1]?.trim()) return line[1].trim()
  } catch {
    /* .env 가 없을 수도 있다 */
  }
  return process.env[key] ?? ''
}

const HOST = pick('GITLAB_URL').replace(/\/+$/, '')
const TOKEN = pick('GITLAB_TOKEN')
const PROJECT = pick('KB_GITLAB_PROJECT') || pick('GITLAB_PROJECT_ID')
const 폴더 = pick('KB_GITLAB_PATH') || 'snapshots'
const BRANCH = pick('KB_GITLAB_BRANCH') || 'main'

export const remoteReady = Boolean(HOST && TOKEN && PROJECT)

let 마지막확인 = 0
let 마지막결과 = null

const api = async (p) => {
  const res = await fetch(`${HOST}/api/v4/projects/${encodeURIComponent(PROJECT)}${p}`, {
    headers: { 'PRIVATE-TOKEN': TOKEN },
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    throw Object.assign(new Error(`깃랩 ${res.status}: ${t.slice(0, 160)}`), { status: res.status })
  }
  return res
}

function 캐시읽기() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 깃랩에 올려둔 기획안 보관본 중 가장 최근 것을 받아온다.
 * 실패하면 마지막으로 받아둔 것을 그대로 쓴다 (사내망 밖에서도 보이게).
 */
export async function fetchRemoteKb() {
  if (!remoteReady) return null
  if (마지막결과 && Date.now() - 마지막확인 < 유효시간) return 마지막결과

  try {
    const list = await (
      await api(`/repository/tree?path=${encodeURIComponent(폴더)}&ref=${encodeURIComponent(BRANCH)}&per_page=100`)
    ).json()
    const 파일들 = (list ?? []).filter((f) => f.type === 'blob' && f.name.endsWith('.json')).map((f) => f.name).sort()
    if (!파일들.length) throw new Error(`${폴더}/ 에 보관본이 없습니다`)

    const 최신 = 파일들.at(-1) // 파일명이 날짜라 이름순 = 시간순
    const 캐시 = 캐시읽기()
    if (캐시?.file === 최신) {
      마지막결과 = 캐시
      마지막확인 = Date.now()
      return 캐시
    }

    const raw = await (
      await api(
        `/repository/files/${encodeURIComponent(`${폴더}/${최신}`)}/raw?ref=${encodeURIComponent(BRANCH)}`,
      )
    ).text()
    const snap = JSON.parse(raw)
    const 결과 = { file: 최신, at: new Date().toISOString(), snapshot: snap }

    fs.mkdirSync(CACHE, { recursive: true })
    fs.writeFileSync(CACHE_FILE, JSON.stringify(결과), 'utf8')
    마지막결과 = 결과
    마지막확인 = Date.now()
    console.log(`기획안을 깃랩에서 받아왔습니다: ${폴더}/${최신}`)
    return 결과
  } catch (err) {
    마지막확인 = Date.now() // 계속 두드리지 않는다
    const 캐시 = 캐시읽기()
    if (캐시) {
      if (!마지막결과) console.warn(`⚠  깃랩에서 기획안을 못 받아 마지막에 받아둔 것을 씁니다 (${캐시.file})`)
      마지막결과 = 캐시
      return 캐시
    }
    console.error(`⚠  기획안을 깃랩에서 받지 못했습니다: ${err.message}`)
    if (err.status === 403) {
      console.error('   토큰에 Repository: Read 권한이 필요합니다.')
    }
    return null
  }
}

export function remoteStatus() {
  if (!remoteReady) return null
  return `기획안 받아올 곳: ${PROJECT} / ${폴더} (${BRANCH})`
}
