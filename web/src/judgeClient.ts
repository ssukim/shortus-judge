// 판정 서버와 주고받기. 서버 사정(없음, 키 없음)은 화면에 적지 않는다. 실행 방법은 web/README.md.
//
// 판정 서버 주소: 빌드 때 VITE_JUDGE_API로 주면 그 주소, 없으면 같은 곳의 api/judge.
// 열 때 GET으로 물어 {judge: true, ready: true}면 새로 판정하고, 아니면 저장해 둔 결과를 보여 준다.
// 쇼더스에서 새 대본 받기는 같은 곳의 api/fresh. GET이 {fresh: true, ready: true}일 때만 쓴다.

import type { CriterionResult, Result } from './types'

export const API_URL = (import.meta.env.VITE_JUDGE_API as string | undefined)?.trim() || import.meta.env.BASE_URL + 'api/judge'
export const FRESH_URL = API_URL.replace(/judge\/?$/, 'fresh')
// 판정 30초 안팎, 보류·탈락이면 고쳐 다시 판정까지 1분 안팎 걸린다. 넉넉히 둔다
const JUDGE_TIMEOUT_MS = 420_000
const FRESH_CALL_TIMEOUT_MS = 30_000
export const FRESH_WAIT_MAX_MS = 60_000 // 쇼더스가 대본을 만드는 것을 기다리는 끝 (가정값)
export const TEXT_MIN = 100 // 붙여 넣은 글로 대본 받기: judge/fresh.py의 TEXT_MIN과 같은 값
export const TEXT_MAX = 15_000 // judge/fresh.py의 TEXT_MAX와 같은 값
export const PASTED_TITLE_MAX = 60 // judge/fresh.py의 TITLE_MAX와 같은 값

const PROBE_TIMEOUT_MS = 3_000 // 확인 요청(probeLive, probeFresh)만: 이 안에 답이 없으면 서버가 없는 것으로 본다. 판정·받기 요청에는 걸지 않는다

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
export interface Meta { criteria?: MetaCriterion[]; model?: string; stream?: string }
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

let freshProbe: Promise<boolean> | null = null
export function probeFresh(): Promise<boolean> {
  freshProbe ??= probeLive().then((live) => (live ? getJson(FRESH_URL).then((b) => !!(b && b.fresh === true && b.ready === true)) : false))
  return freshProbe
}

/** 판정 서버의 결과: 화면 결과(judge/view.py의 to_view)에 들어간 대본과 요청 번호를 더한 것 */
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

// 판정 서버(judge/serve.py)의 입력 한도
export const SOURCE_MAX = 20_000
export const SCENES_MAX = 12
export const SCENE_MAX = 300

export type JudgePayload = { source: string; scenes: { text: string; sec?: number }[]; script_id?: string }

export function postJudge(payload: JudgePayload) {
  return post<ApiResult>(API_URL, payload, JUDGE_TIMEOUT_MS)
}

/** 판정하면서 기준 하나가 끝날 때마다 onCriterion을 부른다(judge/serve.py의 STREAM).
 *  서버가 흘려보내지 않으면(한 번에 받는 응답) 그 응답을 그대로 쓰고 onCriterion은 부르지 않는다. */
export async function postJudgeStream(payload: JudgePayload, onCriterion: (n: number, c: CriterionResult) => void,
  onStage?: (text: string) => void, onJudged?: (body: ApiResult) => void): Promise<Outcome<ApiResult>> {
  const stream = meta?.stream
  if (!stream || typeof ReadableStream === 'undefined') return postJudge(payload)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), JUDGE_TIMEOUT_MS)
  try {
    const r = await fetch(API_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: `${stream}, application/json` },
      body: JSON.stringify(payload), signal: ctrl.signal,
    })
    if (!(r.headers.get('Content-Type') ?? '').includes(stream) || !r.body) {
      const body = await r.json().catch(() => null)
      return r.ok && body ? { ok: true, body: body as ApiResult } : { ok: false, status: r.status, error: body?.error }
    }
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (value) buf += dec.decode(value, { stream: true })
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        const ev = JSON.parse(line)
        if (ev.type === 'criterion') onCriterion(ev.n, ev.result)
        else if (ev.type === 'judged' && ev.body) onJudged?.(ev.body as ApiResult) // 고치기 전 결론 (judge/serve.py STREAM)
        else if (ev.type === 'step' && typeof ev.text === 'string') onStage?.(ev.text) // 탈락 뒤 고친 대본 만들기 등 (judge/serve.py STREAM)
        else if (ev.type === 'done') {
          return ev.status === 200 ? { ok: true, body: ev.body as ApiResult } : { ok: false, status: ev.status, error: ev.body?.error }
        }
      }
      if (done) return { ok: false, status: 0 } // 끝 줄 없이 끊김
    }
  } catch {
    return { ok: false, status: 0 }
  } finally {
    clearTimeout(timer)
  }
}

export interface ShortusTime { field: string; value: string }
export interface FreshStart {
  source_id: string; title: string; script_id: string; text_source_id: string; send_sec: number; poll_after_sec: number
}
export interface FreshPoll {
  done: boolean; poll_after_sec?: number; scenes?: { text: string; sec: number | null }[]
  text_source_id?: string; created_at?: ShortusTime | null; received_at?: string; raw?: unknown // 쇼더스 응답 그대로(민감한 칸만 가림)
}

/** 쇼더스에 글을 보내 대본 만들기를 시작한다. 모아 둔 글은 sourceId, 붙여 넣은 글은 text */
export function freshStart(from: { sourceId: string } | { text: string; title?: string }) {
  const body = 'sourceId' in from ? { step: 'start', source_id: from.sourceId } : { step: 'start', text: from.text, ...(from.title ? { title: from.title } : {}) }
  return post<FreshStart>(FRESH_URL, body, FRESH_CALL_TIMEOUT_MS)
}

/** 붙여 넣은 글의 제목: 글 첫 줄(PASTED_TITLE_MAX자까지). judge/fresh.py의 pasted()와 같은 규칙 */
export function pastedTitle(text: string): string {
  const first = text.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
  return first.slice(0, PASTED_TITLE_MAX).trimEnd()
}

export function freshPoll(scriptId: string) {
  return post<FreshPoll>(FRESH_URL, { step: 'poll', script_id: scriptId }, FRESH_CALL_TIMEOUT_MS)
}
