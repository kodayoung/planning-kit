// 깃랩 이슈 코멘트. 토큰은 여기(서버)에만 있고 브라우저로 절대 내려보내지 않는다.
//
// 이슈 스레드 "해결"은 깃랩이 MR 에만 제공한다. 이슈에는 없다.
// 그래서 첫 줄에 [해결] 로 표시한 답글을 붙이는 방식으로 대신한다. 되돌리기도 같은 방식.
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

// .env 를 직접 읽는다. node --env-file 은 이미 있는 OS 환경변수를 덮지 않는데,
// 이 PC 에는 사용자 환경변수 GITLAB_TOKEN(팀 계정)이 있어서 .env 값이 조용히 무시된다.
// 그대로 두면 의도하지 않은 계정으로 깃랩에 글이 써진다.
function fromEnvFile(key) {
  try {
    const line = fs.readFileSync('.env', 'utf8').match(new RegExp(`^${key}=(.*)$`, 'm'))
    return line ? line[1].trim() : ''
  } catch {
    return ''
  }
}
const pick = (key) => fromEnvFile(key) || process.env[key] || ''

const HOST = pick('GITLAB_URL').replace(/\/+$/, '')
const TOKEN = pick('GITLAB_TOKEN')
const PROJECT = pick('GITLAB_PROJECT_ID')
const FRONT_REPO = pick('FRONT_REPO')

export const gitlabReady = Boolean(HOST && TOKEN && PROJECT)

export function gitlabStatus() {
  if (!HOST) return '깃랩 코멘트: 꺼짐 (.env 의 GITLAB_URL 미설정)'
  if (!TOKEN) return '깃랩 코멘트: 꺼짐 (.env 의 GITLAB_TOKEN 미설정)'
  if (!PROJECT) return '깃랩 코멘트: 꺼짐 (.env 의 GITLAB_PROJECT_ID 미설정)'
  return `깃랩 코멘트: ${HOST} · 프로젝트 ${PROJECT}`
}

const api = async (path, init = {}) => {
  const res = await fetch(`${HOST}/api/v4/projects/${encodeURIComponent(PROJECT)}${path}`, {
    ...init,
    headers: { 'PRIVATE-TOKEN': TOKEN, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    // 토큰이 메시지에 섞여 나가지 않게 본문만 짧게 옮긴다
    throw Object.assign(new Error(`깃랩 응답 ${res.status}: ${text.slice(0, 300)}`), { status: res.status })
  }
  return res.status === 204 ? null : res.json()
}

/** 지금 프론트 레포가 체크아웃한 브랜치. 코멘트에 어느 갈래를 보고 쓴 건지 박아둔다. */
export async function frontBranch() {
  if (!FRONT_REPO) return null
  try {
    const { stdout } = await run('git', ['-C', FRONT_REPO, 'rev-parse', '--abbrev-ref', 'HEAD'])
    return stdout.trim() || null
  } catch {
    return null
  }
}

const RESOLVED = '[해결]'
// 스펙에 없는 자리에 단 코멘트는 "어디에 달았는지"를 같이 저장해야 다시 찾아간다.
const tagLine = (specId, branch, at) =>
  `[spec:${specId}]${branch ? ` [branch:${branch}]` : ''}${at ? ` [at:${JSON.stringify(at)}]` : ''}`

/** 한 이슈의 스레드를 요소별로 갈라서 준다. */
export async function listThreads(issue) {
  const discussions = await api(`/issues/${issue}/discussions?per_page=100`)
  return (discussions ?? [])
    .map((d) => {
      const notes = (d.notes ?? []).filter((n) => !n.system)
      if (!notes.length) return null
      const first = notes[0]
      const specId = (first.body.match(/^\[spec:([^\]]+)\]/) ?? [])[1] ?? null
      const branch = (first.body.match(/\[branch:([^\]]+)\]/) ?? [])[1] ?? null
      let at = null
      const atRaw = first.body.match(/\[at:(\{.*?\})\]/)
      if (atRaw) {
        try {
          at = JSON.parse(atRaw[1])
        } catch {
          at = null
        }
      }
      const strip = (body) =>
        body
          .replace(/^\[spec:[^\]]*\]\s*/, '')
          .replace(/^\[branch:[^\]]*\]\s*/, '')
          .replace(/^\[at:\{.*?\}\]\s*/, '')
          .trim()
      return {
        id: d.id,
        specId,
        branch,
        at,
        resolved: notes.some((n) => n.body.trim().startsWith(RESOLVED)),
        notes: notes.map((n) => ({
          id: n.id,
          author: n.author?.name ?? n.author?.username ?? '?',
          username: n.author?.username ?? '',
          at: n.created_at,
          body: strip(n.body),
          resolveMark: n.body.trim().startsWith(RESOLVED),
          url: `${HOST}/${n.noteable_iid ? '' : ''}`,
        })),
      }
    })
    .filter(Boolean)
}

export async function addThread(issue, specId, branch, body, at) {
  const made = await api(`/issues/${issue}/discussions`, {
    method: 'POST',
    body: JSON.stringify({ body: `${tagLine(specId, branch, at)}\n\n${body}` }),
  })
  warnIfNotMe(made)
  return made
}

export async function reply(issue, discussionId, body) {
  return api(`/issues/${issue}/discussions/${discussionId}/notes`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  })
}

/** 이슈 스레드에는 깃랩 해결 기능이 없어 [해결] 표시 답글로 대신한다. */
export async function setResolved(issue, discussionId, resolved) {
  return reply(issue, discussionId, resolved ? `${RESOLVED} 확인했습니다.` : '[재검토] 다시 봅니다.')
}

/** @멘션 자동완성용 프로젝트 멤버 */
export async function members(query = '') {
  const list = await api(`/members/all?per_page=50${query ? `&query=${encodeURIComponent(query)}` : ''}`)
  return (list ?? []).map((m) => ({ username: m.username, name: m.name }))
}

/**
 * 지금 토큰이 누구 것인지 확인한다. 엉뚱한 계정으로 글이 써지는 걸 막으려는 것.
 * 프로젝트 한정(fine-grained) 토큰은 /user 를 못 읽으므로, 못 읽는 것 자체는 정상이다.
 * 그 경우엔 글을 쓸 때 작성자를 보고 판단한다(아래 warnIfNotMe).
 */
export async function whoami() {
  if (!HOST || !TOKEN) return null
  try {
    const res = await fetch(`${HOST}/api/v4/user`, { headers: { 'PRIVATE-TOKEN': TOKEN } })
    if (res.status === 403) return { scoped: true } // 프로젝트 한정 토큰
    if (!res.ok) return { error: `인증 실패 ${res.status}` }
    const u = await res.json()
    return { name: u.name, username: u.username }
  } catch (err) {
    return { error: err.message }
  }
}

const EXPECTED = process.env.GITLAB_EXPECTED_USER ?? ''
let 경고함 = false

/** 실제로 등록된 글의 작성자를 보고 계정이 맞는지 알린다. 한 번만 경고한다. */
function warnIfNotMe(note) {
  const who = note?.author?.username ?? note?.notes?.[0]?.author?.username
  if (!who || 경고함) return
  경고함 = true
  if (!EXPECTED || who === EXPECTED) console.log(`깃랩 작성자 확인: @${who}`)
  else {
    console.warn(`
⚠  코멘트가 @${who} 계정으로 등록됐습니다. 기대한 계정은 @${EXPECTED} 입니다.`)
    console.warn(`   .env 의 GITLAB_TOKEN 을 확인하세요. (이 PC 사용자 환경변수에 다른 토큰이 있습니다)
`)
  }
}

export const issueUrl = (issue) => (HOST && PROJECT ? `${HOST}/${PROJECT}/-/issues/${issue}` : null)
