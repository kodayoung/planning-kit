// 피그마 기획안에서 뽑아둔 지식 베이스(KB). 설명을 여기서 끌어다 쓴다.
// 기획안에 이미 있는 내용을 스펙 파일에 다시 적지 않기 위한 장치.
//
// KB 한 건의 생김새:
//   { menu, pages: [ { pageName, items: [ { marker, name, desc, constraints } ] } ] }
// 스펙에서 가리키는 방법: "설정/라이선스/1"  (메뉴 / 화면 / 번호)
import fs from 'node:fs'
import path from 'node:path'
import { fetchRemoteKb, remoteReady, remoteStatus } from './kbremote.js'

// 여러 곳을 쉼표로 이어 적을 수 있다. 같은 화면이 여러 곳에 있으면 추출일이 최신인 것을 쓰고,
// 한쪽에만 있는 화면은 그대로 살린다. (재추출본이 일부 화면을 빠뜨린 경우가 있어서 필요하다)
const KB_DIRS = (process.env.KB_DIR ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

let cache = null
let cacheStamp = 0

// 깃랩에서 받아온 기획안. 기획안 폴더가 없는 사람(동료)은 이걸로 본다.
let 원격기획안 = null
export async function refreshRemote() {
  if (KB_DIRS.length || !remoteReady) return null
  const got = await fetchRemoteKb()
  if (got && got.file !== 원격기획안?.file) {
    원격기획안 = got
    cache = null // 색인을 다시 만든다
    cacheStamp = 0
  }
  return 원격기획안
}
export const remoteInfo = () => (원격기획안 ? { file: 원격기획안.file, at: 원격기획안.at } : null)

// 과거 기획안 버전을 볼 때 쓰는 스냅샷. null 이면 지금 상태.
// KB 폴더가 없으면(동료 PC) 가장 최근 보관본을 기본으로 쓴다.
let 선택버전 = process.env.SNAPSHOT ?? null
export function useSnapshot(id) {
  선택버전 = id || null
  cache = null // 색인을 다시 만든다
  cacheStamp = 0
  return 선택버전
}
export const currentSnapshot = () => 선택버전

export function listSnapshots() {
  const dir = path.resolve('snapshots')
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
        return {
          id: s.id,
          name: s.name,
          at: s.at,
          auto: s.auto,
          code: s.code ? { branch: s.code.branch, commit: s.code.commit?.slice(0, 8), date: s.code.date } : null,
          pages: s.kb?.pages?.length ?? 0,
        }
      })
      .sort((a, b) => String(b.at).localeCompare(String(a.at)))
  } catch {
    return []
  }
}

function loadFromSnapshot(id) {
  const file = path.join(path.resolve('snapshots'), `${id}.json`)
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'))
  const pages = new Map()
  for (const p of snap.kb.pages ?? []) {
    pages.set(p.page.pageId, { menu: p.menu, page: p.page, extractedAt: p.extractedAt, source: `스냅샷 ${id}` })
  }
  return pages
}

function loadIndex() {
  // 10초마다 한 번만 다시 읽는다. 기획안 KB 는 자주 바뀌지 않는다.
  if (cache && Date.now() - cacheStamp < 10_000) return cache

  // 0) 메뉴별 피그마 페이지 주소. menu_map.json 은 kb/ 바로 위에 있다.
  //    프레임 단위 node-id 는 KB 에 없어서, 링크는 "그 메뉴 페이지"까지만 데려다준다.
  const figmaByMenu = new Map()
  for (const dir of KB_DIRS) {
    try {
      const map = JSON.parse(fs.readFileSync(path.join(dir, '..', 'menu_map.json'), 'utf8'))
      for (const m of map.menus ?? []) {
        if (!m.pageNodeId || figmaByMenu.has(m.menu)) continue
        figmaByMenu.set(m.menu, `https://www.figma.com/design/${map.fileKey}/?node-id=${String(m.pageNodeId).replace(':', '-')}`)
      }
    } catch {
      /* 지도가 없으면 링크만 안 뜬다 */
    }
  }

  // 깃랩에서 받아온 기획안이 있으면 그것으로 (기획안 폴더가 없는 사람)
  if (!KB_DIRS.length && !선택버전 && 원격기획안?.snapshot) {
    const byId = new Map()
    const byName = new Map()
    for (const p of 원격기획안.snapshot.kb?.pages ?? []) {
      for (const item of p.page.items ?? []) {
        const entry = {
          menu: p.menu,
          pageId: p.page.pageId,
          page: p.page.pageName,
          marker: item.marker,
          name: item.name,
          desc: item.desc ?? '',
          extractedAt: p.extractedAt ?? null,
          figmaUrl: figmaByMenu.get(p.menu) ?? null,
          source: `깃랩 ${원격기획안.file}`,
        }
        byId.set(`${p.page.pageId}/${item.marker}`, entry)
        const k = `${p.menu}/${p.page.pageName}/${item.marker}`
        const seen = byName.get(k)
        if (!seen) byName.set(k, entry)
        else if (seen.ambiguous) seen.ambiguous.push(p.page.pageId)
        else byName.set(k, { ambiguous: [seen.pageId, p.page.pageId] })
      }
    }
    cache = { byId, byName, pageCount: (원격기획안.snapshot.kb?.pages ?? []).length }
    cacheStamp = Date.now()
    return cache
  }

  // 과거 버전을 고른 상태면 그 스냅샷 내용을 쓴다
  if (선택버전) {
    try {
      const saved = loadFromSnapshot(선택버전)
      const byId = new Map()
      const byName = new Map()
      for (const { menu, page, extractedAt, source } of saved.values()) {
        for (const item of page.items ?? []) {
          const entry = {
            menu,
            pageId: page.pageId,
            page: page.pageName,
            marker: item.marker,
            name: item.name,
            desc: item.desc ?? '',
            extractedAt: extractedAt || null,
            figmaUrl: figmaByMenu.get(menu) ?? null,
            source,
            snapshot: 선택버전,
          }
          byId.set(`${page.pageId}/${item.marker}`, entry)
          const k = `${menu}/${page.pageName}/${item.marker}`
          const seen = byName.get(k)
          if (!seen) byName.set(k, entry)
          else if (seen.ambiguous) seen.ambiguous.push(page.pageId)
          else byName.set(k, { ambiguous: [seen.pageId, page.pageId] })
        }
      }
      cache = { byId, byName, pageCount: saved.size }
      cacheStamp = Date.now()
      return cache
    } catch (err) {
      console.error(`⚠  스냅샷 ${선택버전} 을 읽지 못했습니다: ${err.message}`)
      선택버전 = null
    }
  }

  // 1) 모든 KB 폴더에서 화면(page)을 모은다. 같은 pageId 면 추출일이 최신인 것만 남긴다.
  const pages = new Map() // pageId → { menu, page, extractedAt, source, items }
  for (const dir of KB_DIRS) {
    let files
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
    } catch (err) {
      console.error(`\n⚠  기획안 KB 폴더를 열지 못했습니다: ${dir}\n   ${err.message}\n`)
      continue
    }
    for (const file of files) {
      let doc
      try {
        doc = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'))
      } catch (err) {
        console.error(`⚠  기획안 KB 를 읽지 못했습니다: ${file} — ${err.message}`)
        continue
      }
      const menu = doc.menu ?? path.basename(file, '.json')
      const extractedAt = doc.extractedAt ?? ''
      for (const page of doc.pages ?? []) {
        const seen = pages.get(page.pageId)
        if (seen && String(seen.extractedAt) >= String(extractedAt)) continue
        pages.set(page.pageId, { menu, page, extractedAt, source: dir })
      }
    }
  }

  // 2) 항목 단위로 색인한다.
  // pageId 는 고유하지만 pageName 은 겹치는 게 많다(341개 중 35건).
  // pageId 를 정답으로 쓰고, 이름은 안 겹칠 때만 별칭으로 허용한다.
  const byId = new Map() // "설정-라이선스/1" → item
  const byName = new Map() // "설정/라이선스/1" → item | { ambiguous: [...] }
  for (const { menu, page, extractedAt, source } of pages.values()) {
    for (const item of page.items ?? []) {
      const entry = {
        menu,
        pageId: page.pageId,
        page: page.pageName,
        marker: item.marker,
        name: item.name,
        desc: item.desc ?? '',
        extractedAt: extractedAt || null,
        figmaUrl: figmaByMenu.get(menu) ?? null,
        source,
      }
      byId.set(`${page.pageId}/${item.marker}`, entry)

      const nameKey = `${menu}/${page.pageName}/${item.marker}`
      const seen = byName.get(nameKey)
      if (!seen) byName.set(nameKey, entry)
      else if (seen.ambiguous) seen.ambiguous.push(page.pageId)
      else byName.set(nameKey, { ambiguous: [seen.pageId, page.pageId] })
    }
  }

  cache = { byId, byName, pageCount: pages.size }
  cacheStamp = Date.now()
  return cache
}

/**
 * 스펙의 kb 참조를 실제 기획안 내용으로 바꿔준다.
 * 스펙 맨 위에 kb: 설정-라이선스 를 적어두면 각 요소는 kb: 1 처럼 번호만 적으면 된다.
 * 전체로 적을 수도 있다: "설정-라이선스/1" (pageId 기준) 또는 "설정/라이선스/1" (이름 기준)
 */
export function lookupKb(ref, basePage) {
  if (ref === undefined || ref === null || ref === '') return null
  const key = String(ref).includes('/') ? String(ref) : `${basePage ?? ''}/${ref}`

  // KB 폴더가 없어도 보관된 버전을 고르면 그걸로 답한다.
  // 기획안 저장소가 없는 사람(동료)도 스냅샷만 있으면 쓸 수 있어야 한다.
  if (!KB_DIRS.length && !선택버전 && !원격기획안) {
    const 있는것 = listSnapshots()
    return {
      key,
      missing: true,
      reason: 있는것.length
        ? `기획안 폴더가 없습니다. 툴바에서 보관된 버전(${있는것.length}개) 중 하나를 고르세요`
        : 'KB_DIR 이 .env 에 설정되지 않았고 보관된 버전도 없습니다',
    }
  }
  const { byId, byName } = loadIndex()

  const hit = byId.get(key) ?? byName.get(key)
  if (!hit) return { key, missing: true, reason: '기획안에서 이 번호를 찾지 못했습니다' }
  if (hit.ambiguous) {
    return {
      key,
      missing: true,
      reason: `화면 이름이 겹칩니다. 다음 중 하나로 정확히 적어주세요 — ${hit.ambiguous.join(' / ')}`,
    }
  }
  return { key, ...hit }
}

/** 기획안 KB 를 쓸 수 있는 상태인지 (서버 시작 시 안내용) */
export function kbStatus() {
  if (!KB_DIRS.length && 원격기획안) {
    const { byId, pageCount } = loadIndex()
    return `기획안: 깃랩에서 받아옴 (${원격기획안.file}) · 화면 ${pageCount}개 · 항목 ${byId.size}개`
  }
  if (!KB_DIRS.length) {
    const 있는것 = listSnapshots()
    if (선택버전) return `기획안: 보관본 ${선택버전} 사용 (KB 폴더 없음)`
    if (있는것.length) {
      선택버전 = 있는것[0].id // 가장 최근 것
      return `기획안: KB 폴더가 없어 가장 최근 보관본(${선택버전})을 씁니다`
    }
    return '기획안 KB: 꺼짐 (.env 의 KB_DIR 미설정, 보관본도 없음)'
  }
  const { byId, pageCount } = loadIndex()
  return `기획안 KB: 화면 ${pageCount}개 · 항목 ${byId.size}개 (출처 ${KB_DIRS.length}곳, 같은 화면은 최신 추출본 사용)`
}
