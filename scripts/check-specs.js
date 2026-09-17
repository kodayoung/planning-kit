// 스티커가 제자리를 찾는지 화면을 하나씩 열어서 점검한다.  실행: npm run check
//
// 요소를 찾는 규칙은 overlay/locator.js 한 곳에만 있고, 여기서도 그 파일을 그대로 쓴다.
// 못 찾은 요소는 "그럼 화면엔 뭐가 있나"를 같이 뽑아 고칠 후보를 제안한다.
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const BASE = `http://localhost:${process.env.PORT ?? 4000}`
const ID = process.env.CHECK_ID ?? ''
const PW = process.env.CHECK_PW ?? ''
const ONLY = process.argv.slice(2).filter((a) => !a.startsWith('-')).join(' ')
const HEADED = process.argv.includes('--headed')

const LOCATOR_FILE = path.resolve('overlay/locator.js')
const REPORT_FILE = path.resolve('check-report.json')

const 초록 = (s) => `\x1b[32m${s}\x1b[0m`
const 빨강 = (s) => `\x1b[31m${s}\x1b[0m`
const 노랑 = (s) => `\x1b[33m${s}\x1b[0m`
const 흐림 = (s) => `\x1b[90m${s}\x1b[0m`

async function main() {
  let specs
  try {
    specs = await (await fetch(`${BASE}/__spec/all.json`)).json()
  } catch {
    console.error(`기획 도구(${BASE})가 안 떠 있습니다. 다른 창에서 npm run dev 를 먼저 실행하세요.`)
    process.exit(1)
  }

  // 메뉴 목록만 보고 싶을 때: npm run check -- --list
  if (process.argv.includes('--list')) {
    const 메뉴 = {}
    for (const sp of specs) {
      const m = (sp.title ?? '').split('>')[0].trim() || '기타'
      메뉴[m] = (메뉴[m] ?? 0) + 1
    }
    console.log('메뉴별 화면 수 (한 번에 이 단위로 점검하세요)')
    for (const [m, n] of Object.entries(메뉴).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(3)}개  npm run check -- "${m} >"`)
    }
    console.log('전체를 한 번에 돌리면 뒤로 갈수록 화면이 느려져 숫자가 나빠집니다.')
    return
  }

  const 대상 = specs.filter((s) => (s.visit ?? s.route) && (!ONLY || `${s.screen} ${s.title}`.includes(ONLY)))
  if (!대상.length) {
    console.error(ONLY ? `"${ONLY}" 에 맞는 화면이 없습니다.` : '점검할 스펙이 없습니다.')
    process.exit(1)
  }

  // 이미 깔려 있는 Chrome 을 쓴다. 브라우저를 따로 130MB 받지 않으려고.
  // 없으면 Playwright 가 들고 있는 것으로 넘어간다.
  let browser
  for (const opts of [{ channel: 'chrome' }, {}]) {
    try {
      browser = await chromium.launch({ headless: !HEADED, ...opts })
      break
    } catch (err) {
      if (opts.channel) continue
      console.error(빨강('브라우저를 띄우지 못했습니다.'))
      console.error(흐림('Chrome 이 없다면 npx playwright install chromium 을 한 번 실행하세요.'))
      console.error(흐림(String(err.message).split('\n')[0]))
      process.exit(1)
    }
  }
  const VIEWPORT = { width: 1600, height: 900 }
  let context = await browser.newContext({ viewport: VIEWPORT })
  let page = await context.newPage()
  let 로그인상태 = null

  if (ID && PW) {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' })
    // 개발 서버는 첫 로드가 느리다. 화면이 그려질 때까지 기다린 뒤 입력한다.
    await page
      .waitForSelector('input[placeholder*="아이디"]', { timeout: 60000 })
      .catch(() => null)
    if (!(await page.$('input[placeholder*="아이디"]'))) {
      console.error(빨강('로그인 화면이 뜨지 않았습니다.'))
      console.error(흐림(`${BASE}/login 을 브라우저로 열어 화면이 나오는지 확인해 주세요.`))
      await browser.close()
      process.exit(1)
    }
    await page.getByRole('textbox', { name: /아이디/ }).fill(ID)
    await page.getByRole('textbox', { name: /비밀번호/ }).fill(PW)
    await page.getByRole('button', { name: '로그인', exact: true }).click()
    await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 }).catch(() => {})
    if (page.url().includes('/login')) {
      console.error(빨강('로그인에 실패했습니다. .env 의 CHECK_ID / CHECK_PW 를 확인하세요.'))
      await context.close().catch(() => {})
  await browser.close()
      process.exit(1)
    }
    console.log(흐림(`로그인 완료 (${ID})\n`))
  } else {
    console.log(노랑('.env 에 CHECK_ID / CHECK_PW 가 없어 로그인 없이 점검합니다.'))
    console.log(노랑('로그인이 필요한 화면은 전부 못 찾음으로 나옵니다.\n'))
  }

  const 결과 = []
  let 합계 = { ok: 0, 없음: 0, 여러개: 0 }

  for (const spec of 대상) {
    const url = BASE + (spec.visit ?? spec.route)
    const row = { screen: spec.screen, title: spec.title, url, elements: [] }
    const 시작 = Date.now()

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
    } catch {
      row.error = '화면을 열지 못했습니다'
      결과.push(row)
      console.log(`${빨강('✗')} ${spec.title}  ${흐림('— 화면을 열지 못했습니다')}`)
      continue
    }
    if (new URL(page.url()).pathname.startsWith('/login') && !url.includes('/login')) {
      row.error = '로그인 화면으로 튕김'
      결과.push(row)
      console.log(`${빨강('✗')} ${spec.title}  ${흐림('— 로그인이 풀렸습니다')}`)
      continue
    }

    // 모달 안 요소처럼 먼저 눌러야 보이는 경우
    for (const step of spec.prepare ?? []) {
      try {
        if (step.type === 'clickText') await page.getByText(step.value, { exact: false }).first().click({ timeout: 5000 })
        else if (step.type === 'click') await page.click(step.value, { timeout: 5000 })
        else if (step.type === 'fill') await page.fill(step.selector, step.value, { timeout: 5000 })
        else if (step.type === 'waitFor') await page.waitForSelector(step.value, { timeout: 5000 })
        else if (step.type === 'wait') await page.waitForTimeout(step.ms ?? 500)
        else if (step.type === 'goto') await page.goto(BASE + step.value, { waitUntil: 'domcontentloaded' })
      } catch {
        row.prepareFailed = (row.prepareFailed ?? []).concat(`${step.type} ${step.value ?? step.ms ?? ''}`)
      }
    }

    await page
      .waitForFunction(() => document.getElementById('root')?.children.length > 0, { timeout: 15000 })
      .catch(() => {})

    // 세션이 풀리면 주소는 그대로인 채 화면만 로그인 폼으로 바뀐다.
    // 이걸 못 잡으면 전부 "못 찾음"으로 세어져 숫자가 통째로 거짓이 된다.
    if (ID && PW && !url.includes('/login')) {
      const 로그인폼 = await page
        .evaluate(() => Boolean(document.querySelector('input[placeholder*="아이디"]')))
        .catch(() => false)
      if (로그인폼) {
        row.error = '로그인이 풀려 로그인 화면이 떴습니다'
        row.ms = Date.now() - 시작
        결과.push(row)
        console.log(`${빨강('✗')} ${spec.title}  ${흐림('— 로그인이 풀렸습니다')}`)
        continue
      }
    }

    // 고정 시간만 기다리면 안 된다. 화면 92개를 연속으로 열면 뒤로 갈수록 느려져서
    // 덜 그려진 화면을 재게 되고, 멀쩡한 요소가 "못 찾음"으로 찍힌다.
    // 그래서 "다 찾을 때까지" 최대 SETTLE_MS 동안 되묻고, 더 안 좋아지면 거기서 멈춘다.
    const SETTLE_MS = 4000
    const STEP_MS = 400
    let 판정 = []
    let 최고 = -1
    for (let waited = 0; ; waited += STEP_MS) {
      await page.addScriptTag({ path: LOCATOR_FILE }).catch(() => {})
      const 이번 = await page.evaluate((elements) => {
        const L = window.__pkLocator
        return elements.map((el) => {
          const found = L.resolve(el)
          return { name: el.name, kb: el.kb ?? null, locator: el.locator, count: found.length }
        })
      }, spec.elements)
      // 자동 새로고침으로 위젯이 다시 그려지는 화면이 있어 마지막이 가장 좋다는 보장이 없다.
      const 점수 = 이번.filter((e) => e.count === 1).length
      if (점수 > 최고) {
        최고 = 점수
        판정 = 이번
      }
      if (점수 === 이번.length || waited >= SETTLE_MS) break
      await page.waitForTimeout(STEP_MS)
    }

    // 끝까지 못 찾은 것만 "그럼 화면엔 뭐가 있나"를 뽑는다. 무거운 작업이라 마지막에 한 번만.
    const 못찾음 = 판정.filter((e) => e.count !== 1)
    if (못찾음.length) {
      const 후보 = await page.evaluate(
        (ls) => ls.map((l) => window.__pkLocator.candidates(l)),
        못찾음.map((e) => e.locator),
      )
      못찾음.forEach((e, i) => {
        e.suggestions = 후보[i]
      })
    }

    row.elements = 판정
    row.ms = Date.now() - 시작
    결과.push(row)

    const ok = 판정.filter((e) => e.count === 1).length
    const 없음 = 판정.filter((e) => e.count === 0).length
    const 여러개 = 판정.filter((e) => e.count > 1).length
    합계 = { ok: 합계.ok + ok, 없음: 합계.없음 + 없음, 여러개: 합계.여러개 + 여러개 }

    const 표시 = 없음 + 여러개 === 0 ? 초록('✓') : 여러개 && !없음 ? 노랑('△') : 빨강('✗')
    const 꼬리 = [없음 && 빨강(`못찾음 ${없음}`), 여러개 && 노랑(`여러개 ${여러개}`)].filter(Boolean).join(' · ')
    console.log(`${표시} ${spec.title}  ${흐림(`${ok}/${판정.length} · ${(row.ms / 1000).toFixed(1)}s`)}${꼬리 ? '  ' + 꼬리 : ''}`)
    if (row.prepareFailed) console.log(`   ${노랑('진입 조작 실패:')} ${row.prepareFailed.join(', ')}`)
  }

  await context.close().catch(() => {})
  await browser.close()
  fs.writeFileSync(REPORT_FILE, JSON.stringify(결과, null, 2), 'utf8')

  const 전체 = 합계.ok + 합계.없음 + 합계.여러개
  console.log(`\n${'─'.repeat(50)}`)
  console.log(`화면 ${대상.length}개 · 요소 ${전체}개`)
  console.log(`  ${초록(`제자리 ${합계.ok}`)}  ${빨강(`못 찾음 ${합계.없음}`)}  ${노랑(`여러 개 ${합계.여러개}`)}`)
  console.log(`  적중률 ${전체 ? Math.round((합계.ok / 전체) * 100) : 0}%`)
  console.log(`\n자세한 내용과 고칠 후보: ${path.relative(process.cwd(), REPORT_FILE)}`)
  console.log(흐림('Claude Code 에 "check 결과 보고 locator 고쳐줘" 라고 하면 됩니다.'))
}

main()
