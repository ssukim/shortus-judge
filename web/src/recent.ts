// 왼쪽 메뉴의 「최근 판정」: 이 브라우저에서 판정해 보기로 끝낸 차례를 localStorage에 둔다(서버로 보내지 않음).
// 끝난 결과(RunState)를 그대로 같이 두고, 다시 열 때 그 결과를 이 탭의 sessionStorage에 되돌려 놓는다.
// 그러면 runs.ts의 start()가 「이미 끝난 차례」로 보고 판정 서버를 다시 부르지 않는다.

import type { RunState, Spec } from './runs'

const KEY = 'judge-recent'
const MAX = 30

export interface Recent {
  token: string
  label: string // Feed의 turnLabel과 같은 이름
  verdict: string // 목록과 같은 결정 낱말 (common.tsx decisionWord)
  spec: Spec
  run: RunState
}

let cache: Recent[] | null = null
const listeners = new Set<() => void>()

function read(): Recent[] {
  if (cache) return cache
  try {
    cache = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Recent[]
  } catch {
    cache = []
  }
  return cache
}

function write(list: Recent[]) {
  cache = list
  // 저장 칸이 모자라면 오래된 것부터 덜어 낸다
  for (let n = list.length; n >= 0; n--) {
    try {
      localStorage.setItem(KEY, JSON.stringify(list.slice(0, n)))
      break
    } catch {
      /* 다음 바퀴에서 하나 덜고 다시 */
    }
  }
  listeners.forEach((f) => f())
}

export function subscribeRecent(fn: () => void) {
  listeners.add(fn)
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) {
      cache = null
      fn()
    }
  }
  window.addEventListener('storage', onStorage) // 다른 탭에서 판정한 것도 보이게
  return () => {
    listeners.delete(fn)
    window.removeEventListener('storage', onStorage)
  }
}

export const recentList = (): Recent[] => read()

/** 끝난 차례를 맨 위에 적는다. 이미 있는 차례(다시 연 것, 새로고침)는 자리를 바꾸지 않는다 */
export function addRecent(item: Recent) {
  const list = read()
  if (list.some((x) => x.token === item.token)) return
  write([item, ...list].slice(0, MAX))
}

export function clearRecent() {
  write([])
}

/** 최근 판정 하나만 지운다 */
export function removeRecent(token: string) {
  write(read().filter((x) => x.token !== token))
}

/** 다시 열기 전에: 표와 끝난 결과를 이 탭에 되돌려 놓는다 (runs.ts와 같은 열쇠) */
export function restoreRecent(item: Recent) {
  try {
    const specKey = `judge-feed:spec:${item.token}`
    // 이 탭에 글 본문까지 든 표가 이미 있으면 그대로 둔다(같은 글로 하나 더 받기가 되게)
    if (item.spec.kind !== 'saved' && !sessionStorage.getItem(specKey)) sessionStorage.setItem(specKey, JSON.stringify(item.spec))
    sessionStorage.setItem(`judge-feed:run:${item.token}`, JSON.stringify(item.run))
  } catch {
    /* 되돌리지 못하면 Feed가 표를 못 찾아 그 차례를 그리지 않는다 */
  }
}
