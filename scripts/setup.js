// 처음 쓰는 사람을 위한 준비 점검.  실행: npm run setup
//
// 고쳐주지는 않는다. "무엇이 왜 필요한지"와 "어디를 고치면 되는지"만 정확히 알려준다.
// 각자 PC 사정이 달라 자동으로 손대면 오히려 더 헷갈린다.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const 초록 = (s) => `\x1b[32m${s}\x1b[0m`
const 빨강 = (s) => `\x1b[31m${s}\x1b[0m`
const 노랑 = (s) => `\x1b[33m${s}\x1b[0m`
const 흐림 = (s) => `\x1b[90m${s}\x1b[0m`

const 문제 = []
const ok = (m) => console.log(`  ${초록('✓')} ${m}`)
const 경고 = (m, 할일) => {
  console.log(`  ${노랑('▲')} ${m}`)
  문제.push({ 급함: false, 할일 })
}
const 막힘 = (m, 할일) => {
  console.log(`  ${빨강('✗')} ${m}`)
  문제.push({ 급함: true, 할일 })
}

const env = () => {
  try {
    return Object.fromEntries(
      fs
        .readFileSync('.env', 'utf8')
        .split('\n')
        .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    )
  } catch {
    return null
  }
}

const 살아있나 = async (url) => {
  try {
    const c = AbortSignal.timeout(2500)
    await fetch(url, { signal: c })
    return true
  } catch {
    return false
  }
}

console.log('\n기획 도구 준비 점검\n')

/* 1. Node */
console.log('Node')
const major = Number(process.versions.node.split('.')[0])
if (major >= 22) ok(`Node ${process.versions.node}`)
else 막힘(`Node ${process.versions.node} — 22 이상이 필요합니다`, 'Node 22 이상을 설치하세요 (nodejs.org)')

/* 2. 패키지 */
console.log('\n패키지')
if (fs.existsSync('node_modules')) ok('설치되어 있습니다')
else 막힘('아직 설치하지 않았습니다', 'npm install 을 실행하세요')

/* 3. .env */
console.log('\n설정 파일 (.env)')
if (!fs.existsSync('.env')) {
  if (fs.existsSync('.env.example')) {
    fs.copyFileSync('.env.example', '.env')
    console.log(`  ${초록('✓')} .env 를 새로 만들었습니다 (.env.example 을 복사)`)
  } else 막힘('.env 도 .env.example 도 없습니다', '저장소를 다시 받으세요')
} else ok('.env 가 있습니다')

const E = env() ?? {}

/* 4. 경로들 */
console.log('\n가리키는 곳')
const 경로확인 = (key, 설명, 필수 = true) => {
  const v = E[key]
  if (!v) return (필수 ? 막힘 : 경고)(`${key} 가 비어 있습니다 — ${설명}`, `.env 의 ${key} 를 채우세요`)
  const first = v.split(',')[0].trim()
  if (fs.existsSync(first)) ok(`${key} → ${first}`)
  else (필수 ? 막힘 : 경고)(`${key} 가 가리키는 곳이 없습니다: ${first}`, `.env 의 ${key} 를 본인 PC 경로로 고치세요`)
}
// 기획안 저장소가 없어도 보관본(snapshots/)이 있으면 쓸 수 있다.
const 보관본 = fs.existsSync('snapshots') ? fs.readdirSync('snapshots').filter((f) => f.endsWith('.json')) : []
if (E.KB_DIR) {
  경로확인('KB_DIR', '기획안 설명을 여기서 읽습니다')
} else if (보관본.length) {
  ok(`KB_DIR 은 비었지만 보관된 기획안 ${보관본.length}개가 있습니다 — 그중 최신 것을 씁니다`)
  console.log(`  ${흐림('툴바 드롭다운에서 다른 버전으로 바꿀 수 있습니다')}`)
} else {
  막힘(
    'KB_DIR 도 비었고 보관된 기획안도 없습니다 — 설명이 하나도 안 뜹니다',
    '기획안 저장소가 있으면 .env 의 KB_DIR 을 채우고, 없으면 기획자에게 snapshots/ 파일을 받으세요',
  )
}
경로확인('CAPTURE_MAP', 'npm run gen 이 화면 주소를 여기서 읽습니다', false)
경로확인('FRONT_REPO', '지금 보고 있는 프론트 브랜치를 여기서 읽습니다', false)

/* 5. 프론트 개발 서버 */
console.log('\n프론트 개발 서버')
const front = E.FRONT_URL || 'http://localhost:3000'
if (await 살아있나(front)) ok(`${front} 응답합니다`)
else
  경고(`${front} 가 응답하지 않습니다`, `프론트 레포에서 pnpm dev 를 먼저 실행하세요 (기획 도구는 그 앞에 섭니다)`)

/* 6. 브랜치 */
if (E.FRONT_REPO && fs.existsSync(E.FRONT_REPO)) {
  try {
    const { stdout } = await run('git', ['-C', E.FRONT_REPO, 'rev-parse', '--abbrev-ref', 'HEAD'])
    console.log(`  ${흐림(`지금 체크아웃된 브랜치: ${stdout.trim()}`)}`)
  } catch {
    /* git 이 없거나 저장소가 아님 */
  }
}

/* 7. 깃랩 (코멘트용) */
console.log('\n깃랩 코멘트 (선택)')
if (!E.GITLAB_TOKEN) {
  경고('GITLAB_TOKEN 이 비어 있습니다 — 코멘트 기능만 꺼집니다', '토큰을 발급해 .env 의 GITLAB_TOKEN 에 넣으세요 (README 참고)')
} else if (!E.GITLAB_PROJECT_ID) {
  경고('GITLAB_PROJECT_ID 가 비어 있습니다', '.env 의 GITLAB_PROJECT_ID 를 채우세요')
} else {
  try {
    const res = await fetch(
      `${E.GITLAB_URL.replace(/\/+$/, '')}/api/v4/projects/${encodeURIComponent(E.GITLAB_PROJECT_ID)}`,
      { headers: { 'PRIVATE-TOKEN': E.GITLAB_TOKEN }, signal: AbortSignal.timeout(5000) },
    )
    if (res.ok) ok(`${E.GITLAB_PROJECT_ID} 에 접근됩니다`)
    else
      경고(
        `깃랩이 ${res.status} 로 거절했습니다`,
        '토큰 권한을 확인하세요 — Project/Work Item/Member/Label 읽기 + Work Item 생성 (README 참고)',
      )
  } catch {
    경고('깃랩에 연결하지 못했습니다', '사내망에 붙어 있는지, GITLAB_URL 이 맞는지 확인하세요')
  }
}

/* 8. 점검용 계정 */
console.log('\n화면 점검 계정 (선택)')
if (E.CHECK_ID && E.CHECK_PW) ok(`${E.CHECK_ID} 로 점검합니다`)
else 경고('CHECK_ID / CHECK_PW 가 비어 있습니다 — npm run check 가 로그인 뒤 화면을 못 봅니다', '.env 에 본인 테스트 계정을 넣으세요')

/* 마무리 */
console.log(`\n${'─'.repeat(52)}`)
const 급한것 = 문제.filter((p) => p.급함)
if (!문제.length) {
  console.log(초록('준비 끝. npm run dev 로 시작하세요.'))
} else {
  if (급한것.length) {
    console.log(빨강(`먼저 해결해야 시작됩니다 (${급한것.length}건)`))
    급한것.forEach((p, i) => console.log(`  ${i + 1}. ${p.할일}`))
  }
  const 나중 = 문제.filter((p) => !p.급함)
  if (나중.length) {
    console.log(노랑(`${급한것.length ? '\n' : ''}없어도 시작은 됩니다 (${나중.length}건)`))
    나중.forEach((p, i) => console.log(`  ${i + 1}. ${p.할일}`))
  }
  if (!급한것.length) console.log(`\n${초록('시작할 수 있습니다: npm run dev')}`)
}
console.log(흐림('\n자세한 설명은 README.md'))
