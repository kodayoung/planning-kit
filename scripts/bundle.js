// 공유 링크용 정적 묶음을 만든다.  실행: npm run bundle  (다시 빌드 안 하려면 npm run bundle -- --skip-build)
//
// 백엔드도 기획 도구 서버도 없이 브라우저만으로 도는 한 덩어리를 만든다.
//   기획 건별 프론트 빌드 + 목업 + 받아둔 응답 + 기획안 설명 + 스티커 스크립트
//
// 기획 건마다 프론트 갈래가 다르다. 갈래가 다르면 화면 자체가 다른 프로그램이라
// 하나의 파일로 합칠 수 없다. 그래서 건마다 주소 아래 자기 자리를 주고(/license/ 같은),
// 툴바에서 옮겨 다니게 한다. 링크는 하나다.
//
// 코멘트는 보는 사람이 자기 깃랩 계정으로 로그인해서 쓴다.
// 토큰은 묶음에 넣지 않는다 — 넣으면 링크를 받은 누구나 그 계정으로 글을 쓸 수 있다.
import fs from 'node:fs'
import path from 'node:path'
import { parse } from 'yaml'
import { execFileSync } from 'node:child_process'
import { specsForRoute } from '../proxy/specs.js'
import { listSnapshots } from '../proxy/kb.js'

const OUT = path.resolve('public')
const SPEC_OUT = path.join(OUT, '__spec')
const BUILDS = path.resolve('.builds')
const RECORDED = path.resolve('mocks/recorded')
const 다시빌드안함 = process.argv.includes('--skip-build')

/* ── 기획 건 목록 ─────────────────────────────────────────── */

const 기획건들 = (() => {
  try {
    const list = parse(fs.readFileSync(path.resolve('plans.yaml'), 'utf8')) ?? []
    return list.filter((p) => p?.slug && p?.repo)
  } catch {
    return []
  }
})()

if (!기획건들.length) {
  console.error('plans.yaml 에 기획 건이 없습니다. slug / title / repo 를 적어주세요.')
  process.exit(1)
}

const git = (repo, args) => {
  try {
    return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

/** 그 갈래를 자기 자리(/slug/)에 맞게 빌드한다. 자리 이름이 주소에 들어가므로 빌드할 때 알려줘야 한다. */
function 빌드(plan) {
  const 결과 = path.join(BUILDS, plan.slug)
  if (다시빌드안함 && fs.existsSync(path.join(결과, 'index.html'))) {
    console.log(`  ${plan.slug}: 전에 빌드한 것을 그대로 씁니다`)
    return 결과
  }
  if (!fs.existsSync(path.join(plan.repo, 'node_modules'))) {
    console.warn(`  ${plan.slug}: 건너뜁니다 — ${plan.repo} 에서 pnpm install 을 한 번 해주세요`)
    return null
  }
  console.log(`  ${plan.slug}: 빌드 중… (${plan.repo})`)
  try {
    // 윈도우에서는 npx 가 .cmd 라 이름을 그대로 써야 한다 (shell:true 를 쓰면 인자가 안 감싸진다)
    execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', [
      'vite',
      'build',
      `--base=/${plan.slug}/`,
      '--outDir',
      결과,
      '--emptyOutDir',
    ], { cwd: plan.repo, stdio: 'pipe' })
  } catch (err) {
    console.error(`  ${plan.slug}: 빌드 실패 — ${String(err.stderr ?? err.message).slice(0, 300)}`)
    return null
  }
  return fs.existsSync(path.join(결과, 'index.html')) ? 결과 : null
}

/* ── 목업 ─────────────────────────────────────────────────── */

// 같은 주소에 여러 경우(성공·실패·느림)를 적어두면 한 묶음으로 만든다.
// 도구로 돌 때는 routes.yaml 을 고쳐 가며 보지만, 링크를 받은 사람은 그럴 수 없다.
// 그래서 경우를 전부 실어 보내고 화면에서 고르게 한다. enabled 는 "처음에 뭘 보여줄까"가 된다.
//
// 이름 규칙: "라이선스 파일 업로드 · 성공" — 가운뎃점 앞이 묶음 이름, 뒤가 경우 이름.
const 묶음맵 = new Map()
try {
  const 원본 = parse(fs.readFileSync(path.resolve('mocks/routes.yaml'), 'utf8')) ?? []
  for (const r of 원본) {
    if (!r?.path) continue
    let body = ''
    if (r.file) {
      try {
        body = fs.readFileSync(path.resolve('mocks', r.file), 'utf8')
      } catch {
        console.warn(`  목업 응답 파일을 못 읽어 건너뜁니다: mocks/${r.file}`)
        continue
      }
    }
    const method = String(r.method ?? 'GET').toUpperCase()
    const key = `${method} ${r.path}`
    const [묶음이름, 경우이름] = String(r.name ?? r.path).split('·').map((s) => s.trim())
    const g = 묶음맵.get(key) ?? { key, method, path: r.path, label: 묶음이름, options: [], pick: -1 }
    if (r.enabled !== false && g.pick === -1) g.pick = g.options.length
    g.options.push({ label: 경우이름 || 묶음이름, status: r.status ?? 200, delay: r.delay ?? 0, body })
    묶음맵.set(key, g)
  }
} catch {
  /* routes.yaml 이 없거나 깨졌으면 규칙 없이 간다 */
}
const 묶음들 = [...묶음맵.values()]

/* 받아둔 응답 (MOCK_MODE=record 로 모은 것) */
const mocks = {}
if (fs.existsSync(RECORDED)) {
  for (const f of fs.readdirSync(RECORDED).filter((x) => x.endsWith('.json'))) {
    try {
      mocks[path.basename(f, '.json')] = JSON.parse(fs.readFileSync(path.join(RECORDED, f), 'utf8'))
    } catch {
      console.warn(`  깨진 응답은 건너뜁니다: ${f}`)
    }
  }
}

/* ── 기획안 설명 ──────────────────────────────────────────── */

const all = specsForRoute(null)
const byRoute = {}
for (const spec of all) {
  const key = spec.route ?? ''
  ;(byRoute[key] ??= []).push(spec)
}

/* ── 만들기 ───────────────────────────────────────────────── */

fs.rmSync(OUT, { recursive: true, force: true })
fs.mkdirSync(SPEC_OUT, { recursive: true })

console.log('기획 건별로 화면을 빌드합니다.')
const 실은건 = []
for (const plan of 기획건들) {
  const dist = 빌드(plan)
  if (!dist) continue
  fs.cpSync(dist, path.join(OUT, plan.slug), { recursive: true })
  실은건.push({
    slug: plan.slug,
    title: plan.title ?? plan.slug,
    start: plan.start ?? '/',
    branch: git(plan.repo, ['rev-parse', '--abbrev-ref', 'HEAD']) || null,
    commit: git(plan.repo, ['log', '-1', '--format=%h %s']) || null,
  })
}

if (!실은건.length) {
  console.error('실을 수 있는 기획 건이 하나도 없습니다.')
  process.exit(1)
}

/* 기획 도구 자기 파일들. 건마다 같은 것을 쓰므로 뿌리에 한 벌만 둔다. */
for (const f of ['locator.js', 'overlay.js', 'standalone.js', 'gitlab-browser.js']) {
  fs.copyFileSync(path.resolve('overlay', f), path.join(SPEC_OUT, f))
}
fs.writeFileSync(path.join(SPEC_OUT, 'specs-by-route.json'), JSON.stringify(byRoute), 'utf8')
fs.writeFileSync(path.join(SPEC_OUT, 'snapshots.json'), JSON.stringify({ current: null, list: listSnapshots() }), 'utf8')

// 깃랩 설정. 비밀값은 없다 — 앱 번호와 주소뿐이라 그대로 내보내도 된다.
const 깃랩 = {
  host: process.env.GITLAB_URL ?? '',
  project: process.env.GITLAB_PROJECT_ID ?? '',
  clientId: process.env.GITLAB_OAUTH_CLIENT_ID ?? '',
  redirect: process.env.PAGES_URL ?? '',
  defaultIssue: process.env.GITLAB_DEFAULT_ISSUE ?? null,
}

/** 건마다 자기 index.html 에 스크립트를 끼워 넣는다. */
function 끼우기(plan) {
  const idx = path.join(OUT, plan.slug, 'index.html')
  let html = fs.readFileSync(idx, 'utf8')
  const 넣을것 = [
    `<script>window.__PK_MOCKS=${JSON.stringify(mocks)};`,
    `window.__PK_STANDALONE=true;`,
    `window.__PK_MOCK_GROUPS=${JSON.stringify(묶음들)};`,
    `window.__PK_GITLAB=${JSON.stringify({ ...깃랩, branch: plan.branch })};`,
    `window.__PK_PLAN=${JSON.stringify(plan)};`,
    `window.__PK_PLANS=${JSON.stringify(실은건.map(({ slug, title, start }) => ({ slug, title, start })))};</script>`,
    `<script src="/__spec/standalone.js"></script>`,
    `<script src="/__spec/gitlab-browser.js"></script>`,
    `<script src="/__spec/locator.js"></script>`,
    `<script defer src="/__spec/overlay.js"></script>`,
  ].join('')

  // standalone 은 앱보다 먼저 와야 한다. 앱이 첫 요청을 보내기 전에 가로채야 하므로.
  const 앱 = html.match(/<script[^>]*type="module"[^>]*><\/script>/)
  html = 앱 ? html.replace(앱[0], 넣을것 + 앱[0]) : html.replace('</body>', `${넣을것}</body>`)

  // 토큰이 묶음에 섞여 들어가면 링크를 받은 누구나 그 계정으로 깃랩에 글을 쓸 수 있다.
  // 실수로 한 번이라도 새어 나가면 되돌릴 수 없으니, 내보내기 전에 여기서 막는다.
  for (const key of ['GITLAB_TOKEN', 'CHECK_PW', 'FIGMA_TOKEN']) {
    const 값 = process.env[key]
    if (값 && 값.length > 8 && html.includes(값)) {
      console.error(`중단: ${key} 값이 묶음에 섞여 들어갔습니다. 내보내지 않습니다.`)
      process.exit(1)
    }
  }
  fs.writeFileSync(idx, html, 'utf8')
  // 그 건 안에서 깊은 주소로 바로 들어와도 앱이 뜨게
  fs.copyFileSync(idx, path.join(OUT, plan.slug, '404.html'))
}
실은건.forEach(끼우기)

/* 뿌리 화면 — 목록이자 실행기.
 *
 * 왜 이렇게 하나: 기획 건을 /license/ 같은 하위 자리에 두면 화면 주소도 /license/설정/… 이 된다.
 * 그런데 프론트의 화면 전환기는 앞에 붙은 /license/ 를 모른다(코드에 basepath 가 없고, 우리는
 * 프론트 코드를 고치지 않는다). 그래서 주소는 원래대로 두고, 고른 건의 화면만 이 자리에서
 * 통째로 불러와 띄운다. 그림 파일은 건별 자리(/license/assets/…)에 그대로 있어서 섞이지 않는다.
 *
 * 고른 건은 브라우저에 적어둬 새로고침해도 유지된다. 링크로 건네려면 ?plan=license 를 붙인다.
 */
const 실행기 = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>기획 검토</title>
<style>
 :root{color-scheme:dark}
 body{margin:0;padding:48px 16px;font:15px/1.7 "Malgun Gothic",system-ui,sans-serif;background:#111827;color:#f9fafb}
 main{max-width:560px;margin:0 auto}
 h1{font-size:20px;margin:0 0 4px}
 p.sub{margin:0 0 28px;opacity:.6;font-size:13px}
 ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
 li{background:#1f2937;border-radius:8px}
 li a{display:block;padding:14px 16px;color:#f9fafb;text-decoration:none;font-weight:600;border-radius:8px}
 li a:hover{background:#374151}
 li small{display:block;margin-top:2px;opacity:.5;font-size:12px;font-weight:400}
 footer{margin-top:28px;font-size:12px;opacity:.5}
</style></head><body><main id="여기"></main>
<script>
(function () {
  var 건들 = ${JSON.stringify(실은건)}
  var 적어둔곳 = 'pk.plan'
  var q = new URLSearchParams(location.search)
  var 아는건 = function (s) { return 건들.some(function (p) { return p.slug === s }) }

  // 링크로 건네받았으면 그걸 기억하고 주소를 깨끗하게 되돌린다
  var 넘어온것 = q.get('plan')
  if (넘어온것 && 아는건(넘어온것)) {
    try { localStorage.setItem(적어둔곳, 넘어온것) } catch (e) {}
    history.replaceState(null, '', q.get('go') || '/')
  }

  var 지금건 = null
  try { 지금건 = localStorage.getItem(적어둔곳) } catch (e) {}
  if (!아는건(지금건)) 지금건 = null

  // 뿌리 주소를 그냥 열었으면 목록부터 보여준다
  if (!넘어온것 && location.pathname === '/') {
    document.getElementById('여기').innerHTML =
      '<h1>기획 검토</h1>' +
      '<p class="sub">보고 싶은 기획 건을 고르세요. 화면 안에서도 서로 옮겨 다닐 수 있습니다.</p><ul>' +
      건들.map(function (p) {
        return '<li><a href="/?plan=' + p.slug + '&go=' + encodeURIComponent(p.start) + '">' +
          p.title + '<small>' + (p.branch || '') + '</small></a></li>'
      }).join('') +
      '</ul><footer>실제 서버에 연결하지 않습니다. 데이터는 검토용으로 미리 만들어 둔 것입니다.</footer>'
    return
  }

  // 고른 건의 화면을 이 자리에 통째로 띄운다
  var 건 = 지금건 || 건들[0].slug
  fetch('/' + 건 + '/index.html')
    .then(function (r) { return r.text() })
    .then(function (html) { document.open(); document.write(html); document.close() })
    .catch(function () { location.replace('/') })
})()
</script></body></html>`

fs.writeFileSync(path.join(OUT, 'index.html'), 실행기, 'utf8')
// 깊은 주소로 바로 들어와도 같은 실행기가 받는다 (깃랩 Pages 는 없는 주소에 404.html 을 돌려준다)
fs.writeFileSync(path.join(OUT, '404.html'), 실행기, 'utf8')

/* ── 보고 ─────────────────────────────────────────────────── */

const 파일수 = fs.readdirSync(OUT, { recursive: true }).length
const 요소수 = all.reduce((n, s) => n + (s.elements ?? []).length, 0)
console.log('\n공유용 묶음을 만들었습니다 → public/')
for (const p of 실은건) console.log(`  /${p.slug}  ${p.title}  (${p.branch})`)
console.log(`  목업: 자리 ${묶음들.length}곳 · 골라볼 수 있는 자리 ${묶음들.filter((g) => g.options.length > 1).length}곳`)
console.log(`  받아둔 응답: ${Object.keys(mocks).length}건`)
console.log(`  기획안 스펙: 화면 ${all.length}개 · 요소 ${요소수}개`)
console.log(`  파일 ${파일수}개`)
console.log('\n확인: npx serve public   ·  올리기: npm run deploy')
if (!깃랩.clientId || !깃랩.redirect) {
  console.log('  코멘트: 꺼짐. 깃랩에 앱을 등록하고 .env 에 GITLAB_OAUTH_CLIENT_ID / PAGES_URL 을 넣으세요.')
}
