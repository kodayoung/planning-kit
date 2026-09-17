// 기획안 설명이 언제 어떻게 바뀌었는지. 기획안 KB 파일의 git 기록에서 뽑는다.
//
// 커밋마다 그 시점의 KB 를 꺼내 해당 항목의 desc 만 비교한다.
// 파일 전체 diff 를 보여주면 다른 화면 변경까지 섞여 읽을 수가 없다.
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'

const run = promisify(execFile)
const MAX = 20 // 오래된 것까지 다 훑을 이유가 없다
const SEP = '' // 커밋 메시지에 안 나오는 구분자

const KB_DIRS = (process.env.KB_DIR ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

let repoRoot = null
let kbRel = '' // 저장소 뿌리에서 KB 폴더까지의 상대 경로
async function root() {
  if (repoRoot !== null) return repoRoot
  for (const dir of KB_DIRS) {
    try {
      const { stdout } = await run('git', ['-C', dir, 'rev-parse', '--show-toplevel'])
      repoRoot = stdout.trim()
      kbRel = path.relative(repoRoot, path.resolve(dir)).split(path.sep).join('/')
      return repoRoot
    } catch {
      /* 다음 폴더로 */
    }
  }
  repoRoot = ''
  return repoRoot
}

const git = async (args) =>
  (await run('git', ['-C', await root(), ...args], { maxBuffer: 64 * 1024 * 1024 })).stdout

/** 그 커밋 시점의 항목 설명. 없으면 null. */
async function descAt(sha, file, pageId, marker) {
  try {
    const doc = JSON.parse(await git(['show', `${sha}:${file}`]))
    const page = (doc.pages ?? []).find((p) => p.pageId === pageId)
    const item = (page?.items ?? []).find((i) => String(i.marker) === String(marker))
    return item ? (item.desc ?? '') : null
  } catch {
    return null
  }
}

/**
 * 한 항목의 설명 변경 이력. 실제로 그 항목 설명이 바뀐 커밋만 남긴다.
 */
export async function historyOf(menu, pageId, marker) {
  if (!(await root())) return { off: true, message: '기획안 KB 가 git 저장소 안에 있지 않습니다' }
  const file = (kbRel ? `${kbRel}/` : '') + `${menu}.json`

  let log
  try {
    log = await git(['log', '--all', `-${MAX}`, `--format=%H${SEP}%aI${SEP}%an${SEP}%s`, '--', file])
  } catch (err) {
    return { off: true, message: `git 기록을 읽지 못했습니다: ${String(err.message).slice(0, 120)}` }
  }

  const commits = log
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, date, author, subject] = line.split(SEP)
      return { sha, date, author, subject }
    })

  // 오래된 것부터 훑으며 값이 바뀐 지점만 남긴다
  const 변경 = []
  let 직전 = null
  for (const c of [...commits].reverse()) {
    const desc = await descAt(c.sha, file, pageId, marker)
    if (desc === null) continue
    if (직전 === null) 변경.push({ ...c, before: null, after: desc, 처음: true })
    else if (desc !== 직전) 변경.push({ ...c, before: 직전, after: desc })
    직전 = desc
  }
  return { file, changes: 변경.reverse() }
}
