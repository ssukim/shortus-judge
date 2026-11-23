// 판정 서버(judge/serve.py)와 주고받기. 서버 사정(없음, 키 없음)은 화면에 적지 않는다. 실행 방법은 web/README.md.
//
// 판정 서버 주소: 빌드 때 VITE_JUDGE_API로 주면 그 주소, 없으면 같은 곳의 api/judge.
// 열 때 GET으로 물어 {judge: true, ready: true}면 새로 판정하고, 아니면 저장해 둔 결과를 보여 준다.
// 판정 서버는 한 번에 받는 응답(JSON)만 낸다. 기준 줄은 판정이 끝날 때 한꺼번에 채워진다.

import type { Result } from './types'

export const API_URL = (import.meta.env.VITE_JUDGE_API as string | undefined)?.trim() || import.meta.env.BASE_URL + 'api/judge'
// 사실 묶음을 세 번 묻고 구성 묶음을 한 번 물어, 대본 하나에 30초 안팎 걸린다. 넉넉히 둔다
const JUDGE_TIMEOUT_MS = 240_000
const PROBE_TIMEOUT_MS = 3_000 // 확인 요청만: 이 안에 답이 없으면 서버가 없는 것으로 본다

// 직접 넣기의 입력 한도 (judge/serve.py와 같은 값)
export const SOURCE_MAX = 20_000
export const SCENES_MAX = 12
export const SCENE_MAX = 300

export async function getJson(url: string): Promise<Record<string, unknown> | null> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS)
  try {
    const r = await fetch(url, { method: 'GET', signal: ctl.signal })
    return r.ok ? await r.json() : null
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/** 판정 서버가 알려 주는 기준 목록 (judge/view.py의 criteria_meta) */
export interface MetaCriterion { n: number; name: string; text?: string; by?: string }
export interface Meta { criteria?: MetaCriterion[]; model?: string }
let meta: Meta | null = null
export const getMeta = () => meta

let liveProbe: Promise<boolean> | null = null
export function probeLive(): Promise<boolean> {
  liveProbe ??= getJson(API_URL).then((b) => {
    const ok = !!(b && b.judge === true && b.ready === true)
    if (ok) meta = b as Meta
    return ok
  })
  return liveProbe
}

export interface ApiResult extends Result {
  request_id?: string
  input: { sec_estimated_scenes: number[]; scenes: { n: number; text: string; sec: number }[] }
}

export type Outcome<T> = { ok: true; body: T } | { ok: false; status: number; error?: string }

async function post<T>(url: string, payload: unknown, timeoutMs: number): Promise<Outcome<T>> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    })
    const body = await r.json().catch(() => null)
    return r.ok && body ? { ok: true, body: body as T } : { ok: false, status: r.status, error: body?.error }
  } catch {
    return { ok: false, status: 0 }
  } finally {
    clearTimeout(timer)
  }
}

export type JudgePayload = { source: string; scenes: { text: string; sec?: number }[]; script_id?: string }

export function postJudge(payload: JudgePayload) {
  return post<ApiResult>(API_URL, payload, JUDGE_TIMEOUT_MS)
}
