// 기획안 전체를 한 덩어리로 떠서 보관한다.  실행: npm run snapshot ["이름"]
//
// 왜 필요한가: 설명은 기획안 KB 에서 그때그때 읽어온다. KB 가 갱신되면 과거 상태는
// 화면에서 사라진다. KB 는 다른 저장소에 있고 브랜치도 갈려 있어
// 그쪽이 통으로 바뀌면 기준이 같이 흔들린다. 그래서 기획 도구 안에 떠서 커밋한다.
//
// 기획안은 자기 박자로 버저닝하되, "그때 프론트 코드 좌표"를 같이 박는다.
// 나중에 과거 버전을 열었을 때 어느 코드를 보고 쓴 기획안인지 알아야 짝을 맞출 수 있다.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parse } from 'yaml'

const run = promisify(execFile)
const OUT = path.resolve('snapshots')
const SPECS_DIR = path.resolve('specs')

const KB_DIRS = (process.env.KB_DIR ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const FRONT_REPO = process.env.FRONT_REPO ?? ''

const git = async (cwd, args) => {
  try {
    return (await run('git', ['-C', cwd, ...args], { maxBuffer: 32 * 1024 * 1024 })).stdout.trim()
  } catch {
    return ''
  }
}

/** 그때 프론트 코드가 어디였는지. 이게 없으면 과거 기획안을 열어도 짝을 못 맞춘다. */
async function codeCoords() {
  if (!FRONT_REPO) return null
  const branch = await git(FRONT_REPO, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const commit = await git(FRONT_REPO, ['rev-parse', 'HEAD'])
  const subject = await git(FRONT_REPO, ['log', '-1', '--format=%s'])
  const date = await git(FRONT_REPO, ['log', '-1', '--format=%aI'])
  // 기준 브랜치(develop)와 얼마나 떨어져 있나 — 나중에 "그 뒤로 N커밋 갔다"를 말하려면 필요
  const ahead = await git(FRONT_REPO, ['rev-list', '--count', 'origin/develop..HEAD'])
  const behind = await git(FRONT_REPO, ['rev-list', '--count', 'HEAD..origin/develop'])
  return { repo: path.basename(FRONT_REPO), branch, commit, subject, date, ahead: Number(ahead) || 0, behind: Number(behind) || 0 }
}

/** 기획안 KB 를 합친 상태 그대로 (같은 화면은 최신 추출본) */
function collectKb() {
  const pages = new Map()
  const sources = []
  for (const dir of KB_DIRS) {
    let files
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    } catch {
      continue
    }
    const dates = new Set()
    for (const file of files) {
      const doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
      dates.add(doc.extractedAt ?? '')
      const menu = doc.menu ?? path.basename(file, '.json')
      for (const page of doc.pages ?? []) {
        const seen = pages.get(page.pageId)
        if (seen && String(seen.extractedAt) >= String(doc.extractedAt ?? '')) continue
        pages.set(page.pageId, { menu, extractedAt: doc.extractedAt ?? '', page })
      }
    }
    sources.push({ dir, extractedAt: [...dates].sort().reverse()[0] ?? null })
  }
  return { sources, pages: [...pages.values()] }
}

function collectSpecs() {
  let files = []
  try {
    files = fs
      .readdirSync(SPECS_DIR, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
      .map((e) => path.relative(SPECS_DIR, path.join(e.parentPath ?? e.path, e.name)))
  } catch {
    return []
  }
  const out = []
  for (const file of files) {
    try {
      const doc = parse(fs.readFileSync(path.join(SPECS_DIR, file), 'utf8'))
      if (doc) out.push({ _file: file, ...doc })
    } catch {
      /* 깨진 파일은 건너뛴다 */
    }
  }
  return out
}

/** 내용이 같은지 보는 지문. 자동 스냅샷이 같은 내용을 또 뜨지 않게. */
const fingerprint = (kb) =>
  JSON.stringify(kb.pages.map((p) => [p.page.pageId, (p.page.items ?? []).map((i) => [i.marker, i.desc])]))

async function main() {
  const 이름 = process.argv.slice(2).filter((a) => !a.startsWith('-')).join(' ') || null
  const 자동 = process.argv.includes('--auto')

  if (!KB_DIRS.length) {
    console.error('.env 의 KB_DIR 이 없습니다.')
    process.exit(1)
  }
  fs.mkdirSync(OUT, { recursive: true })

  const kb = collectKb()
  const 지문 = fingerprint(kb)

  const 기존 = fs
    .readdirSync(OUT)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))

  if (기존[0]?.fingerprint === 지문) {
    if (자동) {
      console.log('기획안 내용이 직전 스냅샷과 같습니다. 새로 뜨지 않습니다.')
      return
    }
    console.log('⚠  기획안 내용이 직전 스냅샷과 같습니다. 이름만 다른 스냅샷이 생깁니다.')
  }

  const at = new Date().toISOString()
  const id = at.slice(0, 19).replace(/[:T]/g, '-')
  const snap = {
    id,
    name: 이름,
    at,
    auto: 자동,
    fingerprint: 지문,
    code: await codeCoords(),
    kb,
    specs: collectSpecs(),
  }
  const file = path.join(OUT, `${id}.json`)
  fs.writeFileSync(file, JSON.stringify(snap, null, 1), 'utf8')

  const 항목 = kb.pages.reduce((n, p) => n + (p.page.items ?? []).length, 0)
  console.log(`스냅샷 ${id}${이름 ? ` · ${이름}` : ''}`)
  console.log(`  기획안 화면 ${kb.pages.length}개 · 항목 ${항목}개`)
  console.log(`  스펙 ${snap.specs.length}개`)
  if (snap.code) console.log(`  프론트 코드: ${snap.code.branch} @ ${snap.code.commit.slice(0, 8)} (${snap.code.date?.slice(0, 10)})`)
  else console.log('  프론트 코드 좌표: 없음 (.env 의 FRONT_REPO 미설정)')
  console.log(`  → ${path.relative(process.cwd(), file)}`)
  console.log('\n이 파일을 커밋해 두면 원본 저장소가 어떻게 바뀌어도 이 시점 기획안이 남습니다.')
}

main()
