// 기획안 KB + 캡처 지도로 스펙 파일을 찍어낸다.  실행: npm run gen
//
//   기획안 KB      항목 이름·설명·제약        (<KB>/kb/*.json)
//   캡처 지도      pageId → 화면 주소·진입 조작  (<KB>/capture-map.json)
//   ─────────────────────────────────────────
//   →  specs/generated/<pageId>.yaml
//
// locator 는 항목 이름에서 짐작한다. 짐작이라 틀릴 수 있고, 틀린 건 화면에서 빨간 스티커로
// 드러난다. 4단계의 npm run check 가 그걸 목록으로 뽑아준다.
import fs from 'node:fs'
import path from 'node:path'
import { stringify } from 'yaml'

const KB_DIRS = (process.env.KB_DIR ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const CAPTURE_MAP = process.env.CAPTURE_MAP ?? ''
const OUT_DIR = path.resolve('specs/generated')

if (!KB_DIRS.length || !CAPTURE_MAP) {
  console.error('.env 에 KB_DIR 과 CAPTURE_MAP 을 설정해 주세요.')
  process.exit(1)
}

/* ---------- 기획안 KB 합치기 (같은 화면은 최신 추출본) ---------- */
const pages = new Map()
for (const dir of KB_DIRS) {
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
    const extractedAt = doc.extractedAt ?? ''
    for (const page of doc.pages ?? []) {
      const seen = pages.get(page.pageId)
      if (seen && String(seen.extractedAt) >= String(extractedAt)) continue
      pages.set(page.pageId, { menu: doc.menu ?? path.basename(file, '.json'), page, extractedAt })
    }
  }
}

/* ---------- 캡처 지도에서 화면 주소 ---------- */
const capture = JSON.parse(fs.readFileSync(CAPTURE_MAP, 'utf8'))
const recipes = Array.isArray(capture.pages)
  ? capture.pages
  : Object.entries(capture.pages).map(([pageId, v]) => ({ pageId, ...v }))

/* ---------- 손으로 쓴 스펙이 이미 덮은 화면은 건너뛴다 ---------- */
const handWritten = new Set()
for (const file of fs.readdirSync(path.resolve('specs')).filter((f) => f.endsWith('.yaml'))) {
  const text = fs.readFileSync(path.resolve('specs', file), 'utf8')
  const m = text.match(/^kb:\s*(.+)$/m)
  if (m) handWritten.add(m[1].trim())
}

/* ---------- 항목 이름에서 locator 를 짐작한다 ---------- */
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$|^[0-9a-f]{32}$|^\d+$/i

function guessLocator(name, marker) {
  const n = String(name ?? '').trim()
  // 기획안 이름엔 "(필수 입력)" 같은 꼬리표가 붙는다. 화면에는 없는 글자라 떼고도 찾아본다.
  const bare = n.replace(/\s*\([^)]*\)\s*$/, '').trim()

  // 화면 전체를 설명하는 항목 — 본문 영역에 붙인다.
  // 화면마다 구조가 달라 후보를 여러 개 둔다. 위에서부터 맞는 것이 쓰인다.
  if (marker === '0' || /(페이지|개요)$/.test(n)) return [{ role: 'main' }, { css: 'main' }, { css: '#root' }]
  if (/(모달|팝업|창|알림|토스트)$/.test(n)) return [{ role: 'dialog' }, { role: 'alertdialog' }, { role: 'status' }]

  const button = bare.match(/^(.*?)\s*버튼$/)
  if (button) {
    const b = button[1]
    // 기획안 "저장" 이 화면에선 "저장하기" 인 경우가 흔하다. 변형까지 훑는다.
    return [
      { role: 'button', name: b },
      { role: 'button', name: `${b}하기` },
      { role: 'button', name: b, exact: false },
      { role: 'link', name: b },
    ]
  }

  if (/\(표\)$|^.*\s표$|목록$/.test(bare)) return [{ role: 'table' }, { text: bare }]
  if (/체크박스$/.test(bare)) return { role: 'checkbox' }
  if (/(입력창|입력 ?필드)$/.test(bare)) return { role: 'textbox' }
  if (/(드롭다운|셀렉트|선택 ?박스)$/.test(bare)) return { role: 'combobox' }

  // 나머지는 화면에 그 글자가 그대로 보인다고 보고 글자로 찾는다.
  // 꼬리표를 뗀 것, 제목으로 쓰인 것, 부분 일치까지 차례로 훑는다.
  const 후보 = [{ text: n }]
  if (bare !== n) 후보.push({ text: bare })
  후보.push({ role: 'heading', name: bare }, { text: bare, exact: false })
  return 후보
}

/** 레코드 id 가 박힌 주소는 * 로 바꿔 어느 레코드에서든 맞게 한다 */
function generalizeUrl(url) {
  const [pathOnly] = String(url).split('?')
  return (
    pathOnly
      .split('/')
      .map((seg) => (UUID.test(seg) ? '*' : seg))
      .join('/') || '/'
  )
}

/* ---------- 만들기 ---------- */
fs.rmSync(OUT_DIR, { recursive: true, force: true })
fs.mkdirSync(OUT_DIR, { recursive: true })

let 만듦 = 0
let 항목 = 0
const 건너뜀 = { 주소없음: 0, 손으로씀: 0, KB없음: 0, 항목없음: 0 }
const 종류 = {}

for (const recipe of recipes) {
  if (recipe.skip || !recipe.url) {
    건너뜀.주소없음 += 1
    continue
  }
  if (handWritten.has(recipe.pageId)) {
    건너뜀.손으로씀 += 1
    continue
  }
  const hit = pages.get(recipe.pageId)
  if (!hit) {
    건너뜀.KB없음 += 1
    continue
  }
  const items = hit.page.items ?? []
  if (!items.length) {
    건너뜀.항목없음 += 1
    continue
  }

  const doc = {
    screen: recipe.pageId,
    route: generalizeUrl(recipe.url), // 스티커를 붙일 때 맞춰보는 규칙 (id 자리는 *)
    visit: recipe.url, // 점검할 때 실제로 열어볼 주소
    title: `${hit.menu} > ${hit.page.pageName}`,
    kb: recipe.pageId,
    elements: items.map((item, i) => {
      const locator = guessLocator(item.name, String(item.marker))
      const first = Array.isArray(locator) ? locator[0] : locator
      const kind = first.role ?? (first.text ? 'text' : 'css')
      종류[kind] = (종류[kind] ?? 0) + 1
      항목 += 1
      return {
        id: `${recipe.pageId}-${item.marker}-${i}`,
        name: item.name,
        locator,
        kb: item.marker,
      }
    }),
  }
  if (recipe.steps?.length) doc.prepare = recipe.steps

  const safe = recipe.pageId.replace(/[\\/:*?"<>|]/g, '_')
  const header =
    '# 자동 생성된 파일입니다. npm run gen 을 다시 돌리면 덮어써집니다.\n' +
    '# 설명은 기획안 KB 에서 읽어오므로 여기 없습니다. locator 가 틀렸으면 고쳐서\n' +
    '# specs/ 바로 아래로 옮기세요. 그러면 다음 생성 때 이 화면은 건드리지 않습니다.\n\n'
  fs.writeFileSync(path.join(OUT_DIR, `${safe}.yaml`), header + stringify(doc), 'utf8')
  만듦 += 1
}

console.log(`스펙 파일 ${만듦}개 · 요소 ${항목}개를 만들었습니다 → specs/generated/`)
console.log('  locator 종류:', 종류)
console.log('  건너뛴 것:', 건너뜀)
console.log('\n짐작으로 만든 locator 라 틀린 게 섞여 있습니다.')
console.log('화면에서 빨간 스티커로 보이고, 4단계의 npm run check 가 목록으로 뽑아줍니다.')
