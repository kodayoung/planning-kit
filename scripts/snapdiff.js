// 기획안 버전 목록과 버전 간 차이.
//   npm run snapshots                 목록
//   npm run snapdiff <A> <B>          두 버전 차이 (B 없으면 지금 상태와 비교)
import fs from 'node:fs'
import path from 'node:path'

const OUT = path.resolve('snapshots')
const 초록 = (s) => `\x1b[32m${s}\x1b[0m`
const 빨강 = (s) => `\x1b[31m${s}\x1b[0m`
const 노랑 = (s) => `\x1b[33m${s}\x1b[0m`
const 흐림 = (s) => `\x1b[90m${s}\x1b[0m`

const load = () =>
  fs.existsSync(OUT)
    ? fs
        .readdirSync(OUT)
        .filter((f) => f.endsWith('.json'))
        .map((f) => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')))
        .sort((a, b) => String(a.at).localeCompare(String(b.at)))
    : []

function 목록() {
  const all = load()
  if (!all.length) {
    console.log('보관된 기획안 버전이 없습니다. npm run snapshot "이름" 으로 뜨세요.')
    return
  }
  console.log(`보관된 기획안 버전 ${all.length}개 (오래된 것부터)`)
  for (const s of all) {
    const 항목 = s.kb.pages.reduce((n, p) => n + (p.page.items ?? []).length, 0)
    console.log(
      `  ${s.id}  ${s.name ? s.name : 흐림(s.auto ? '(자동)' : '(이름 없음)')}\n` +
        `      화면 ${s.kb.pages.length} · 항목 ${항목}` +
        (s.code ? ` · 코드 ${s.code.branch}@${s.code.commit.slice(0, 8)}` : ' · 코드 좌표 없음'),
    )
  }
  console.log(`\n차이 보기:  npm run snapdiff -- ${all[0].id} ${all.at(-1).id}`)
}

/** 항목을 "화면/번호" 로 펼친다 */
const flatten = (snap) => {
  const m = new Map()
  for (const p of snap.kb.pages)
    for (const item of p.page.items ?? [])
      m.set(`${p.page.pageId}/${item.marker}`, { menu: p.menu, page: p.page.pageName, ...item })
  return m
}

function 차이(A, B) {
  const a = flatten(A)
  const b = flatten(B)
  const 신규 = [...b.keys()].filter((k) => !a.has(k))
  const 삭제 = [...a.keys()].filter((k) => !b.has(k))
  const 변경 = [...b.keys()].filter((k) => a.has(k) && (a.get(k).desc ?? '') !== (b.get(k).desc ?? ''))

  // 줄바꿈·구분자만 바뀐 것은 따로 센다. 재추출하면 이게 대량으로 생긴다.
  const 조각 = (t) =>
    (t ?? '')
      .split(/[\r\n]|\s:\s/)
      .map((x) => x.replace(/\s+/g, ' ').replace(/^[:\s]+|[:\s]+$/g, '').trim())
      .filter(Boolean)
      .sort()
      .join('\u0001')
  const 형식만 = 변경.filter((k) => 조각(a.get(k).desc) === 조각(b.get(k).desc))
  const 내용 = 변경.filter((k) => !형식만.includes(k))

  console.log(`${A.id}${A.name ? ` (${A.name})` : ''}  →  ${B.id}${B.name ? ` (${B.name})` : ''}`)
  if (A.code && B.code) {
    console.log(
      흐림(`  코드: ${A.code.branch}@${A.code.commit.slice(0, 8)} → ${B.code.branch}@${B.code.commit.slice(0, 8)}`),
    )
  }
  console.log(
    `\n  ${초록(`신규 ${신규.length}`)}  ${빨강(`삭제 ${삭제.length}`)}  ${노랑(`내용 변경 ${내용.length}`)}  ${흐림(`형식만 ${형식만.length}`)}\n`,
  )

  const 묶음 = {}
  const 담기 = (종류, keys, src) => {
    for (const k of keys) {
      const it = src.get(k)
      ;(묶음[it.menu] ??= []).push({ 종류, key: k, page: it.page, name: it.name })
    }
  }
  담기('신규', 신규, b)
  담기('삭제', 삭제, a)
  담기('변경', 내용, b)

  for (const [menu, rows] of Object.entries(묶음).sort((x, y) => y[1].length - x[1].length)) {
    console.log(`[${menu}] ${rows.length}건`)
    for (const r of rows.slice(0, 12)) {
      const 표 = r.종류 === '신규' ? 초록('＋') : r.종류 === '삭제' ? 빨강('－') : 노랑('△')
      console.log(`  ${표} ${r.page} · ${r.name}`)
    }
    if (rows.length > 12) console.log(흐림(`  … 그 외 ${rows.length - 12}건`));
  }
  if (!Object.keys(묶음).length) console.log('내용이 바뀐 항목이 없습니다.')
  if (형식만.length) console.log(흐림(`\n형식만 바뀐 ${형식만.length}건은 위 목록에서 제외했습니다 (줄바꿈·구분자).`))
}

const args = process.argv.slice(2).filter((a) => !a.startsWith('-'))
if (process.argv.includes('--list') || !args.length) {
  목록()
} else {
  const all = load()
  const find = (id) => all.find((s) => s.id === id || s.name === id || s.id.startsWith(id))
  const A = find(args[0])
  const B = args[1] ? find(args[1]) : all.at(-1)
  if (!A || !B) {
    console.error('버전을 찾지 못했습니다. npm run snapshots 로 목록을 보세요.')
    process.exit(1)
  }
  차이(A, B)
}
