// 판정해 보기 화면의 한 차례(turn)마다 하는 일과 그 결과.
// 차례는 주소의 t 값에 쌓인다: 모아 둔 대본은 id, 직접 넣은 것과 쇼더스에서 받은 것은 "o-…", "f-…" 표.
// 표의 내용과 끝난 결과는 이 탭의 sessionStorage에 둔다. 새로고침해도 다시 부르지 않는다.
// 진행 줄(checks)은 서버가 실제로 끝냈다고 알려 준 기준만 바꾼다. 서버가 흘려보내지 않으면 끝날 때 한꺼번에 바뀐다.

import type { CriterionResult, Data, Result, Scene, Script } from './types'
import { parseHash, verdictWord } from './common'
import {
  FRESH_WAIT_MAX_MS, FULL_NOTE, freshFull, freshPoll, freshStart, getMeta, markFull, postJudgeStream, probeFresh, probeLive,
  type ApiResult, type ShortusTime,
} from './judgeClient'

export type Spec =
  | { kind: 'saved'; id: string }
  | { kind: 'fresh'; sourceId: string }
  | { kind: 'text'; text: string; title: string } // 붙여 넣은 글을 쇼더스에 보내 받은 대본. text가 비면(최근 판정에서 되돌린 것) 다시 받을 수 없다
  | { kind: 'own'; source: string; scenes: { text: string; sec?: number }[] }

/** 기준 하나의 진행 줄 */
export interface CheckLine {
  n: number
  name: string
  what?: string // 무엇을 보는지 (서버가 알려 준 기준 목록)
  by?: string // code / model / code+model
  state: 'doing' | 'pass' | 'hit' | 'error' | 'not_checked'
  r?: CriterionResult
  sec?: number // 판정을 보낸 뒤 이 기준이 끝났다고 서버가 알려 온 때 (흘려보낼 때만)
  seq?: number // 끝난 차례 (흘려보낼 때만)
}

export interface Step {
  text: string
  done: boolean
  startedAt?: number
  sec?: number
  scenes?: Scene[] // 대본을 받은 줄에 접어서 붙이는 장면
  checks?: CheckLine[] // 판정 줄: 기준마다 진행
  stages?: { text: string; sec: number }[] // 서버가 알려 온 단계 (고친 대본 만들기 등), 들어온 차례대로
  judge?: boolean // 판정을 끝낸 줄 (「확인하는 중」 묶음에는 기준 줄로 대신 보임)
}

/** 대본이 어디서 왔는지. 평가자가 쇼더스 서버 기록에서 id로 찾아볼 수 있게 줄이지 않고 둔다 */
export interface Origin {
  kind: 'fresh' | 'saved'
  scriptId: string
  textSourceId?: string
  createdAt?: ShortusTime | null // 쇼더스 응답에 만든 시각 칸이 있을 때만
  receivedAt?: string | null // 받은 시각 (방금 받은 것은 판정 서버 시각, 모아 둔 것은 받아 둔 시각)
  raw?: unknown // 쇼더스 응답 그대로(민감한 칸만 가림)
}

export interface Final {
  r?: Result
  scenes: Scene[]
  sourceText: string
  meta: string // 결과 위 한 줄: 새로 판정함 / 저장해 둔 결과
  notes: string[]
  costLines: string[] // 「든 비용과 시간」에 들어갈 줄
  estimated?: number[] // 초를 어림한 장면
  savedId?: string // 결과가 모아 둔 대본의 것일 때
  sourceId?: string
  error?: string // 결과 없이 끝났을 때
  requestId?: string // 새로 판정했을 때 서버가 준 기록 번호
  version?: string // 판정기 판
  checks?: CheckLine[] // 「어떻게 봤는지」
  origin?: Origin
  at?: string | null // 판정한 때 (판정봇 말풍선의 시각)
  stages?: { text: string; sec: number }[] // 흘려보낼 때 들어온 단계 (고친 대본 만들기 등)
  // 결론은 나왔고 고친 대본을 아직 만드는 중 (판정 서버의 judged 줄, D37). 끝나면 지운다
  revising?: { since: number; text: string }
  // 쇼더스에서 새 대본을 받지 못해 모아 둔 대본의 저장해 둔 결과를 대신 보일 때, 판정봇이 맨 먼저 말할 까닭
  notice?: string
  savedDiff?: string // 새로 판정한 것이 저장해 둔 판정과 다를 때 (같으면 없음)
}

export interface RunState {
  steps: Step[]
  final?: Final
}

// ---- 표 ----

const store = (k: string) => `judge-feed:${k}`

export function newToken(kind: 'fresh' | 'own' | 'text'): string {
  return (kind === 'fresh' ? 'f-' : kind === 'text' ? 'p-' : 'o-') + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

export function saveSpec(token: string, spec: Spec) {
  if (spec.kind !== 'saved') sessionStorage.setItem(store('spec:' + token), JSON.stringify(spec))
}

export function specOf(token: string, data: Data): Spec | null {
  if (!token.startsWith('f-') && !token.startsWith('o-') && !token.startsWith('p-')) {
    const s = data.scripts.find((x) => x.id === token)
    return s ? { kind: 'saved', id: token } : null
  }
  const raw = sessionStorage.getItem(store('spec:' + token))
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
    const raw = sessionStorage.getItem(store('run:' + token))
    if (raw) runs.set(token, JSON.parse(raw))
  }
  return runs.get(token)
}

function set(token: string, st: RunState) {
  runs.set(token, st)
  if (st.final && !st.final.revising) sessionStorage.setItem(store('run:' + token), JSON.stringify(st))
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


const liveChecks = (token: string) => getRun(token)?.steps.at(-1)

/** 흘려보낼 때 잰 기준별 끝난 때를 마지막 줄에 옮긴다 */
function keepTiming(f: Final, step?: Step): Final {
  if (step?.stages?.length) f.stages = step.stages
  const live = step?.checks
  if (!live || !f.checks) return f
  f.checks = f.checks.map((c) => {
    const l = live.find((x) => x.n === c.n)
    return l?.seq != null ? { ...c, sec: l.sec, seq: l.seq } : c
  })
  return f
}

function judgedFinal(data: Data, res: ApiResult, sourceText: string, meta: string, extraCost: string[] = []): Final {
  const notes: string[] = []
  if (res.input?.sec_estimated_scenes?.length)
    notes.push(`${res.input.sec_estimated_scenes.join(', ')}번 장면은 초가 없어 글자 수로 어림했습니다. 길이는 어림값입니다.`)
  const { input, request_id, ...r } = res
  return {
    r,
    scenes: (input?.scenes ?? []).map((s) => ({ n: s.n, role: '', sec: s.sec, text: s.text })),
    sourceText, meta, notes,
    costLines: [...extraCost, `판정 ${res.elapsed_sec}초 · 모델 호출 ${res.calls ?? '?'}번 · $${res.cost_usd.toFixed(4)}(API 단가로 친 값)`],
    estimated: input?.sec_estimated_scenes ?? [],
    requestId: request_id, checks: checksOf(data, r), at: res.judged_at ?? new Date().toISOString(),
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function sameFlags(a: number[], b: number[]) {
  return a.length === b.length && a.every((x, i) => x === b[i])
}

/** 판정하는 동안 카드 맨 위 한 줄 */
const judgingText = () => '보는 중'
const judgedText = (data: Data) => `기준 ${data.criteria.length}개를 봤습니다`

/** 판정을 보내고, 기준이 끝날 때마다 마지막 줄(판정 줄)의 진행을 바꾼다 */
async function judgeWithProgress(token: string, data: Data, before: Step[], payload: Parameters<typeof postJudgeStream>[0], meta = '방금 새로 판정함') {
  const t0 = Date.now()
  const step: Step = { text: judgingText(), done: false, startedAt: t0, checks: blankChecks(data) }
  set(token, { steps: [...before, step] })
  let seq = 0
  return postJudgeStream(payload, (n, c) => {
    const r = c
    const sec = Math.round((Date.now() - t0) / 100) / 10
    step.checks = (step.checks ?? []).map((x) => (x.n === n ? { ...x, by: x.by ?? r.by, state: lineState(r), r, sec, seq: seq++ } : x))
    set(token, { steps: [...before, { ...step }] })
  }, (stage) => {
    step.stages = [...(step.stages ?? []), { text: stage, sec: Math.round((Date.now() - t0) / 100) / 10 }]
    const f = getRun(token)?.final
    // 결론을 먼저 보인 뒤면 결론 아래 줄만 바꾼다
    set(token, { steps: [...before, { ...step }], ...(f?.revising ? { final: { ...f, stages: step.stages, revising: { ...f.revising, text: stage } } } : {}) })
  }, (body) => {
    // 기준 10개가 끝남: 고칠 것이 있으면(결정이 아직 없음) 결론을 먼저 보이고 고친 대본은 끝날 때 이어 붙인다
    if (body.decision) return
    const f = keepTiming(judgedFinal(data, body, payload.source, `${meta} · 고친 대본을 만드는 중`), step)
    f.revising = { since: Date.now(), text: '고칠 곳을 정리하고 있어요' }
    set(token, { steps: [...before, { ...step }], final: f })
  })
}

// ---- 차례 시작 ----

/** 「준비하는 중」에서 멈추지 않게 두는 시간 상한. 이 안에 첫 줄이 서지 않으면 실패로 바꾼다 */
export const PREPARE_MAX_MS = 15_000

const started = new Set<string>() // 같은 차례를 두 번 시작하지 않게(React 개발 모드는 effect를 두 번 부른다)

/** 차례 하나를 시작한다. 이미 끝난 것은 다시 하지 않는다. 어디서 고장 나도 실패 안내로 끝낸다. */
export async function start(token: string, spec: Spec, data: Data) {
  if (getRun(token)?.final || started.has(token)) return
  started.add(token)
  try {
    await run(token, spec, data)
  } catch {
    giveUp(token, spec, data, '지금은 판정하지 못했습니다. 잠시 뒤 다시 눌러 주세요.')
  }
}

/** 시간 상한에 닿았거나 고장 났을 때: 모아 둔 대본이 있으면 그 저장해 둔 결과로, 없으면 안내만 */
export function giveUp(token: string, spec: Spec, data: Data, note: string) {
  if (getRun(token)?.final) return
  const s = spec.kind === 'saved' ? data.scripts.find((x) => x.id === spec.id)
    : spec.kind === 'fresh' ? ordered(data).find((x) => x.source_id === spec.sourceId) : undefined
  const steps = (getRun(token)?.steps ?? []).map((x) => ({ ...x, done: true }))
  if (s) set(token, { steps, final: savedFinal(data, s, spec.kind === 'fresh' ? `모아 둔 ${s.nth} 대본의 저장해 둔 판정 결과` : '저장해 둔 판정 결과', [note]) })
  else set(token, { steps, final: { scenes: [], sourceText: '', meta: '', notes: [], costLines: [], error: note } })
}

// ---- 연습 모드 (개발용, web/README.md) ----
// 주소에 demo=1이 있으면 모아 둔 대본을 판정 서버에 보내지 않고, 저장해 둔 결과를 실제 판정과 같은 단계 순서
// (기준 줄 → 고친 대본 만들기 → 다시 판정 → 끝)로 1~2초 간격에 흘려보낸다. 화면 배치·따라가기 확인용이다.
const DEMO_STEP_MS = 1200
const DEMO_STAGE_MS = 1800
export const isDemo = () => parseHash(window.location.hash).query.get('demo') === '1'

async function demoRun(token: string, data: Data, s: Script) {
  const r = data.results[s.id]
  if (!r) return false
  const t0 = Date.now()
  const sec = () => Math.round((Date.now() - t0) / 100) / 10
  const step: Step = { text: judgingText(), done: false, startedAt: t0, checks: blankChecks(data) }
  set(token, { steps: [step] })
  // 코드가 보는 기준 먼저, 그다음 모델 기준 (실제로 먼저 끝나는 차례)
  const order = checksOf(data, r).sort((a, b) => Number((a.by ?? a.r?.by ?? '').startsWith('model')) - Number((b.by ?? b.r?.by ?? '').startsWith('model')))
  let seq = 0
  for (const c of order) {
    await sleep(DEMO_STEP_MS)
    step.checks = (step.checks ?? []).map((x) => (x.n === c.n ? { ...x, by: x.by ?? c.by, state: c.state, r: c.r, sec: sec(), seq: seq++ } : x))
    set(token, { steps: [{ ...step }] })
  }
  const stages = r.revision && r.verdict !== data.verdicts[0] ? [r.verdict === data.verdicts[1] ? '보류라 고친 대본을 만들고 있어요' : '탈락이라 고친 대본을 만들고 있어요', '고친 대본을 다시 판정하고 있어요'] : []
  if (r.revision_2) stages.push('남은 곳을 한 번 더 고치고 있어요', '두 번째 고친 대본을 다시 판정하고 있어요')
  for (const text of stages) {
    step.stages = [...(step.stages ?? []), { text, sec: sec() }]
    set(token, { steps: [{ ...step }] })
    await sleep(DEMO_STAGE_MS)
  }
  const f = keepTiming(savedFinal(data, s, `연습 모드 · 저장해 둔 결과를 흘려보냄 · ${sec()}초`, []), step)
  set(token, { steps: [{ text: judgedText(data), done: true, sec: sec(), judge: true }], final: f })
  return true
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
    const o = await judgeWithProgress(token, data, [], {
      source: data.sources[s.source_id]?.text ?? '',
      scenes: s.scenes.map((sc) => (sc.sec != null ? { text: sc.text, sec: sc.sec } : { text: sc.text })),
      script_id: s.id,
    })
    if (!o.ok) {
      set(token, {
        steps: [{ text: '새로 판정하지 못했습니다', done: true }],
        final: savedFinal(data, s, '저장해 둔 판정 결과', ['지금은 새로 판정할 수 없어 저장해 둔 결과를 보여 드립니다.']),
      })
      return
    }
    const res = o.body
    const f = keepTiming(judgedFinal(data, res, data.sources[s.source_id]?.text ?? '', `방금 새로 판정함 · ${res.elapsed_sec}초`), liveChecks(token))
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

  if (spec.kind === 'own') {
    const o = await judgeWithProgress(token, data, [], { source: spec.source, scenes: spec.scenes })
    if (!o.ok) {
      const error = o.status === 400 || o.status === 413
        ? o.error ?? '넣은 내용을 읽지 못했습니다.'
        : o.status === 429 ? '지금은 판정 요청이 많아 판정할 수 없습니다. 잠시 뒤 다시 눌러 주세요.' : '지금은 판정할 수 없습니다. 잠시 뒤 다시 눌러 주세요.'
      set(token, { steps: [{ text: '판정하지 못했습니다', done: true }], final: { scenes: [], sourceText: spec.source, meta: '', notes: [], costLines: [], error } })
      return
    }
    const res = o.body
    set(token, {
      steps: [{ text: judgedText(data), done: true, sec: res.elapsed_sec ?? undefined, judge: true }],
      final: keepTiming(judgedFinal(data, res, spec.source, `방금 새로 판정함 · ${res.elapsed_sec}초`), liveChecks(token)),
    })
    return
  }

  // ---- 쇼더스에서 새 대본 받기 (모아 둔 글: fresh, 붙여 넣은 글: text) ----
  const pastedText = spec.kind === 'text' ? spec.text.trim() : ''
  const sourceId = spec.kind === 'fresh' ? spec.sourceId : undefined
  const t0 = Date.now()
  let steps: Step[] = [{ text: '쇼더스에 글을 보내는 중', done: false, startedAt: t0 }]
  set(token, { steps })
  const fallback = (done: Step[], why = '지금은 새 대본을 받을 수 없어 모아 둔 대본으로 보여 드립니다.', textError?: string) => {
    // 붙여 넣은 글은 대신 보여 줄 모아 둔 대본이 없어 안내만
    const s = sourceId ? ordered(data).find((x) => x.source_id === sourceId) : undefined
    if (!s) return set(token, { steps: done, final: { scenes: [], sourceText: pastedText, meta: '', notes: [], costLines: [], error: textError ?? '지금은 새 대본을 받을 수 없어요. 잠시 뒤 다시 눌러 주세요.' } })
    set(token, { steps: done, final: { ...savedFinal(data, s, `모아 둔 ${s.nth} 대본의 저장해 둔 판정 결과`, [why]), notice: why } })
  }
  const busy = (status: number) => status === 429
    ? '요청이 많아 지금은 새 대본을 받을 수 없습니다. 잠시 뒤 다시 눌러 주세요. 아래는 모아 둔 대본의 결과입니다.'
    : undefined
  if (spec.kind === 'text' && !pastedText) return fallback([], undefined, '이 글은 이 브라우저에 남아 있지 않아 다시 받을 수 없습니다. 글을 다시 붙여 넣어 주세요.')
  if (!(await probeFresh())) return fallback([])
  if (freshFull()) return fallback([], `${FULL_NOTE} 아래는 모아 둔 대본의 결과예요.`, FULL_NOTE)
  const st = await freshStart(sourceId ? { sourceId } : { text: pastedText, title: spec.kind === 'text' ? spec.title : undefined })
  if (!st.ok) {
    if (st.full) markFull()
    const textError = st.status === 400 ? st.error : st.status === 429 ? st.error ?? '요청이 많아 지금은 새 대본을 받을 수 없습니다. 잠시 뒤 다시 눌러 주세요.' : undefined
    // 쇼더스 하루 한도처럼 서버가 까닭을 적어 보내면 모아 둔 대본으로 대신 보일 때도 그 까닭을 적는다
    const why = st.status === 429 && st.error ? `${st.error} 아래는 모아 둔 대본의 결과입니다.` : busy(st.status)
    return fallback([{ text: '쇼더스에 글을 보내지 못했습니다', done: true }], why, textError)
  }
  const t1 = Date.now()
  steps = [{ text: '쇼더스에 글을 보냈습니다', done: true, sec: st.body.send_sec }, { text: '쇼더스가 대본을 만드는 중', done: false, startedAt: t1 }]
  set(token, { steps })
  let got: { text: string; sec: number | null }[] | undefined
  let polled: Awaited<ReturnType<typeof freshPoll>> | undefined
  let wait = st.body.poll_after_sec
  while (!got) {
    if (Date.now() - t0 + wait * 1000 > FRESH_WAIT_MAX_MS) return fallback([steps[0], { text: '쇼더스가 시간 안에 대본을 만들지 못했습니다', done: true }])
    await sleep(wait * 1000)
    polled = await freshPoll(st.body.script_id)
    if (!polled.ok) return fallback([steps[0], { text: '쇼더스에서 대본을 받지 못했습니다', done: true }], busy(polled.status))
    if (polled.body.done) got = polled.body.scenes ?? []
    else wait = polled.body.poll_after_sec ?? 3
  }
  const pb = polled!.ok ? polled!.body : undefined
  const makeSec = Math.round((Date.now() - t1) / 100) / 10
  const scenes: Scene[] = got.map((x, i) => ({ n: i + 1, role: '', sec: x.sec, text: x.text }))
  steps = [
    steps[0],
    { text: '쇼더스가 대본을 만들었습니다', done: true, sec: makeSec },
    { text: `대본을 받았습니다 · 장면 ${scenes.length}개`, done: true, scenes },
  ]
  // 판정에 넣는 글: 쇼더스에 보낸 글과 같은 것(붙여 넣은 글이면 그 글). 사실 기준(1~4)이 이 글과 견준다
  const sourceText = sourceId ? data.sources[sourceId]?.text ?? '' : pastedText
  const o = await judgeWithProgress(token, data, steps, {
    source: sourceText, scenes: got.map((x) => (x.sec ? { text: x.text, sec: x.sec } : { text: x.text })),
  })
  if (!o.ok) return fallback([...steps, { text: '판정하지 못했습니다', done: true }], undefined, '대본은 받았지만 지금은 판정할 수 없습니다. 잠시 뒤 다시 눌러 주세요.')
  const res = o.body
  const fetchSec = Math.round((st.body.send_sec + makeSec) * 10) / 10
  const f = keepTiming(judgedFinal(data, res, sourceText, `대본 받기 ${fetchSec}초 · 판정 ${res.elapsed_sec}초`,
    [`쇼더스 대본 받기 ${fetchSec}초(보내기 ${st.body.send_sec}초, 만들기 ${makeSec}초)`]), liveChecks(token))
  f.sourceId = sourceId
  f.origin = {
    kind: 'fresh', scriptId: st.body.script_id, textSourceId: pb?.text_source_id ?? st.body.text_source_id,
    createdAt: pb?.created_at ?? null, receivedAt: pb?.received_at ?? null, raw: pb?.raw,
  }
  set(token, { steps: [...steps, { text: judgedText(data), done: true, sec: res.elapsed_sec ?? undefined, judge: true }], final: f })
}
