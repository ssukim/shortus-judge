// 판정해 보기 화면의 한 차례(turn)마다 하는 일과 그 결과.
// 차례는 주소의 t 값에 쌓인다: 모아 둔 대본은 id, 직접 넣은 대본은 "o-…" 표.
// 표의 내용과 끝난 결과는 이 탭의 sessionStorage에 둔다. 새로고침해도 다시 부르지 않는다.
// 판정 서버는 한 번에 답하므로 기준 줄(checks)은 판정이 끝날 때 한꺼번에 채워진다. 지어낸 진행 줄은 없다.

import type { CriterionResult, Data, Result, Scene, Script } from './types'
import { parseHash, verdictWord } from './common'
import { getMeta, postJudge, probeLive, type ApiResult } from './judgeClient'

export type Spec =
  | { kind: 'saved'; id: string }
  | { kind: 'own'; source: string; scenes: { text: string; sec?: number }[] }

/** 기준 하나의 진행 줄 */
export interface CheckLine {
  n: number
  name: string
  by?: string // code / model
  state: 'doing' | 'pass' | 'hit' | 'error' | 'not_checked'
  r?: CriterionResult
  sec?: number
  seq?: number
}

export interface Step {
  text: string
  done: boolean
  startedAt?: number
  sec?: number
  scenes?: Scene[]
  checks?: CheckLine[] // 판정 줄: 기준마다 진행
  stages?: { text: string; sec: number }[]
  judge?: boolean // 판정을 끝낸 줄
}

/** 대본이 어디서 왔는지. 쇼더스 서버 기록에서 id로 찾아볼 수 있게 줄이지 않고 둔다 */
export interface Origin {
  kind: 'saved'
  scriptId: string
  textSourceId?: string
  receivedAt?: string | null
  raw?: unknown // 쇼더스 응답 그대로
}

export interface Final {
  r?: Result
  scenes: Scene[]
  sourceText: string
  meta: string // 결과 위 한 줄: 새로 판정함 / 저장해 둔 결과
  notes: string[]
  costLines: string[] // 「시간과 비용」에 들어갈 줄
  estimated?: number[] // 초를 어림한 장면
  savedId?: string
  sourceId?: string
  error?: string // 결과 없이 끝났을 때
  requestId?: string
  checks?: CheckLine[]
  origin?: Origin
  at?: string | null // 판정한 때
  stages?: { text: string; sec: number }[]
  savedDiff?: string // 새로 판정한 것이 저장해 둔 판정과 다를 때
}

export interface RunState {
  steps: Step[]
  final?: Final
}

// ---- 표 ----

const store = (k: string) => `judge-feed:${k}`

export function newToken(): string {
  return 'o-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

function ss(fn: () => void) {
  try { fn() } catch { /* 저장 칸을 못 쓰면 새로고침 때 다시 판정한다 */ }
}

export function saveSpec(token: string, spec: Spec) {
  if (spec.kind !== 'saved') ss(() => sessionStorage.setItem(store('spec:' + token), JSON.stringify(spec)))
}

export function specOf(token: string, data: Data): Spec | null {
  if (!token.startsWith('o-')) {
    const s = data.scripts.find((x) => x.id === token)
    return s ? { kind: 'saved', id: token } : null
  }
  let raw: string | null = null
  ss(() => { raw = sessionStorage.getItem(store('spec:' + token)) })
  return raw ? (JSON.parse(raw) as Spec) : null
}

// ---- 진행 상태 ----

const runs = new Map<string, RunState>()
const listeners = new Set<() => void>()

export function subscribe(fn: () => void) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getRun(token: string): RunState | undefined {
  if (!runs.has(token)) {
    let raw: string | null = null
    ss(() => { raw = sessionStorage.getItem(store('run:' + token)) })
    if (raw) runs.set(token, JSON.parse(raw))
  }
  return runs.get(token)
}

function set(token: string, st: RunState) {
  runs.set(token, st)
  if (st.final) ss(() => sessionStorage.setItem(store('run:' + token), JSON.stringify(st)))
  listeners.forEach((f) => f())
}

// ---- 대본 순서와 이름 ----

export const TYPE_ORDER = ['news', 'blog', 'community', 'product']

export function ordered(data: Data): Script[] {
  const rank = (t: string) => TYPE_ORDER.indexOf(t) + 1 || 99
  return [...data.scripts].sort((a, b) => rank(a.type) - rank(b.type) || a.id.localeCompare(b.id))
}

export const titleOf = (data: Data, s: Script) => data.sources[s.source_id]?.title || s.id

// ---- 진행 줄 ----

function lineState(r: CriterionResult): CheckLine['state'] {
  if (r.not_checked) return 'not_checked'
  if (r.error) return 'error'
  return r.flagged ? 'hit' : 'pass'
}

/** 기준 목록으로 진행 줄을 놓는다. 서버가 알려 준 목록이 있으면 그것 */
function blankChecks(data: Data): CheckLine[] {
  const list = getMeta()?.criteria?.length ? getMeta()!.criteria! : data.criteria
  return list.map((c) => ({ n: c.n, name: c.name, by: c.by, state: 'doing' }))
}

/** 끝난 결과로 줄을 모두 채운다 */
export function checksOf(data: Data, r: Result): CheckLine[] {
  return data.criteria.map((c) => {
    const cr = r.criteria[String(c.n)]
    return { n: c.n, name: c.name, by: c.by ?? cr?.by, state: cr ? lineState(cr) : 'doing', r: cr }
  })
}

/** 모아 둔 대본의 저장해 둔 결과 */
export function savedFinal(data: Data, s: Script, meta: string, notes: string[]): Final {
  const r = data.results[s.id]
  return {
    r, scenes: s.scenes, sourceText: data.sources[s.source_id]?.text ?? '', meta, notes,
    costLines: r ? [`이 결과를 저장할 때 ${r.elapsed_sec ?? '?'}초, 모델 호출 ${r.calls ?? '?'}번, $${r.cost_usd.toFixed(4)}(API 단가로 친 값)`] : [],
    savedId: s.id, sourceId: s.source_id,
    checks: r ? checksOf(data, r) : undefined, origin: savedOrigin(s), at: r?.judged_at,
  }
}

function savedOrigin(s: Script): Origin {
  return { kind: 'saved', scriptId: s.shortus?.script_id, textSourceId: s.shortus?.text_source_id, receivedAt: s.shortus?.collected_at, raw: s.shortus?.raw }
}

function judgedFinal(data: Data, res: ApiResult, sourceText: string, meta: string): Final {
  const notes: string[] = []
  if (res.input?.sec_estimated_scenes?.length)
    notes.push(`${res.input.sec_estimated_scenes.join(', ')}번 장면은 초가 없어 글자 수로 어림했습니다. 길이는 어림값입니다.`)
  const { input, request_id, ...r } = res
  return {
    r,
    scenes: (input?.scenes ?? []).map((s) => ({ n: s.n, role: '', sec: s.sec, text: s.text })),
    sourceText, meta, notes,
    costLines: [`판정 ${res.elapsed_sec}초 · 모델 호출 ${res.calls ?? '?'}번 · $${res.cost_usd.toFixed(4)}(API 단가로 친 값)`],
    estimated: input?.sec_estimated_scenes ?? [],
    requestId: request_id, checks: checksOf(data, r), at: res.judged_at ?? new Date().toISOString(),
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function sameFlags(a: number[], b: number[]) {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

const judgingText = () => '보는 중'
const judgedText = (data: Data) => `기준 ${data.criteria.length}개를 봤습니다`

/** 판정을 보내고 끝날 때까지 「보는 중」 줄을 둔다 */
async function judgeWithProgress(token: string, data: Data, payload: Parameters<typeof postJudge>[0]) {
  const step: Step = { text: judgingText(), done: false, startedAt: Date.now(), checks: blankChecks(data) }
  set(token, { steps: [step] })
  return postJudge(payload)
}

// ---- 차례 시작 ----

/** 「준비하는 중」에서 멈추지 않게 두는 시간 상한 */
export const PREPARE_MAX_MS = 15_000

const started = new Set<string>() // 같은 차례를 두 번 시작하지 않게(React 개발 모드는 effect를 두 번 부른다)

export async function start(token: string, spec: Spec, data: Data) {
  if (getRun(token)?.final || started.has(token)) return
  started.add(token)
  try {
    await run(token, spec, data)
  } catch {
    giveUp(token, spec, data, '지금은 판정하지 못했습니다. 잠시 뒤 다시 눌러 주세요.')
  }
}

/** 고장 났을 때: 모아 둔 대본이면 저장해 둔 결과로, 아니면 안내만 */
export function giveUp(token: string, spec: Spec, data: Data, note: string) {
  if (getRun(token)?.final) return
  const s = spec.kind === 'saved' ? data.scripts.find((x) => x.id === spec.id) : undefined
  const steps = (getRun(token)?.steps ?? []).map((x) => ({ ...x, done: true }))
  if (s) set(token, { steps, final: savedFinal(data, s, '저장해 둔 판정 결과', [note]) })
  else set(token, { steps, final: { scenes: [], sourceText: '', meta: '', notes: [], costLines: [], error: note } })
}

// ---- 연습 모드 (개발용, web/README.md) ----
// 주소에 demo=1이 있으면 모아 둔 대본을 판정 서버에 보내지 않고, 저장해 둔 결과를 기준 하나씩 1초 남짓 간격으로 채운다.
const DEMO_STEP_MS = 900
export const isDemo = () => parseHash(window.location.hash).query.get('demo') === '1'

async function demoRun(token: string, data: Data, s: Script) {
  const r = data.results[s.id]
  if (!r) return false
  const t0 = Date.now()
  const sec = () => Math.round((Date.now() - t0) / 100) / 10
  const step: Step = { text: judgingText(), done: false, startedAt: t0, checks: blankChecks(data) }
  set(token, { steps: [step] })
  const order = checksOf(data, r).sort((a, b) => Number((a.by ?? '').startsWith('model')) - Number((b.by ?? '').startsWith('model')))
  let seq = 0
  for (const c of order) {
    await sleep(DEMO_STEP_MS)
    step.checks = (step.checks ?? []).map((x) => (x.n === c.n ? { ...x, by: x.by ?? c.by, state: c.state, r: c.r, sec: sec(), seq: seq++ } : x))
    set(token, { steps: [{ ...step }] })
  }
  const f = savedFinal(data, s, `연습 모드 · 저장해 둔 결과를 채움 · ${sec()}초`, [])
  f.checks = f.checks?.map((c) => { const l = step.checks?.find((x) => x.n === c.n); return l?.seq != null ? { ...c, sec: l.sec, seq: l.seq } : c })
  set(token, { steps: [{ text: judgedText(data), done: true, sec: sec(), judge: true }], final: f })
  return true
}

function errorText(o: { status: number; error?: string }): string {
  if (o.status === 400 || o.status === 413) return o.error ?? '넣은 내용을 읽지 못했습니다.'
  if (o.status === 429) return o.error ?? '지금은 판정 요청이 많아 판정할 수 없습니다. 잠시 뒤 다시 눌러 주세요.'
  return '지금은 판정할 수 없습니다. 잠시 뒤 다시 눌러 주세요.'
}

async function run(token: string, spec: Spec, data: Data) {
  if (spec.kind === 'saved' && isDemo()) {
    const s = data.scripts.find((x) => x.id === spec.id)
    if (s && (await demoRun(token, data, s))) return
  }
  const live = await probeLive()

  if (spec.kind === 'saved') {
    const s = data.scripts.find((x) => x.id === spec.id)!
    if (!live) {
      set(token, { steps: [{ text: '저장해 둔 판정 결과를 불러왔습니다', done: true, judge: true }], final: savedFinal(data, s, '저장해 둔 판정 결과', []) })
      return
    }
    const o = await judgeWithProgress(token, data, {
      source: data.sources[s.source_id]?.text ?? '',
      scenes: s.scenes.map((sc) => (sc.sec != null ? { text: sc.text, sec: sc.sec } : { text: sc.text })),
      script_id: s.id,
    })
    if (!o.ok) {
      set(token, {
        steps: [{ text: '새로 판정하지 못했습니다', done: true }],
        final: savedFinal(data, s, '저장해 둔 판정 결과', [`${errorText(o)} 저장해 둔 결과를 보여 드립니다.`]),
      })
      return
    }
    const res = o.body
    const f = judgedFinal(data, res, data.sources[s.source_id]?.text ?? '', `방금 새로 판정함 · ${res.elapsed_sec}초`)
    const saved = data.results[s.id]
    if (saved && saved.verdict !== res.verdict)
      f.savedDiff = `저장해 둔 판정은 ${verdictWord(data, saved.verdict)}였습니다(걸린 기준 ${saved.flagged.join(', ') || '없음'}). 모델 답은 돌릴 때마다 달라질 수 있습니다.`
    else if (saved && !sameFlags(saved.flagged, res.flagged))
      f.savedDiff = `판정은 저장해 둔 것과 같고, 걸린 기준이 다릅니다(저장해 둔 것: ${saved.flagged.join(', ') || '없음'}). 모델 답은 돌릴 때마다 달라질 수 있습니다.`
    f.savedId = s.id
    f.sourceId = s.source_id
    f.origin = savedOrigin(s)
    set(token, { steps: [{ text: judgedText(data), done: true, sec: res.elapsed_sec ?? undefined, judge: true }], final: f })
    return
  }

  const o = await judgeWithProgress(token, data, { source: spec.source, scenes: spec.scenes })
  if (!o.ok) {
    set(token, { steps: [{ text: '판정하지 못했습니다', done: true }], final: { scenes: [], sourceText: spec.source, meta: '', notes: [], costLines: [], error: errorText(o) } })
    return
  }
  const res = o.body
  set(token, {
    steps: [{ text: judgedText(data), done: true, sec: res.elapsed_sec ?? undefined, judge: true }],
    final: judgedFinal(data, res, spec.source, `방금 새로 판정함 · ${res.elapsed_sec}초`),
  })
}
