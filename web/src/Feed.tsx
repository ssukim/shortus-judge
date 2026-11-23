import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Data, Script } from './types'
import { decisionWord, setQuery } from './common'
import { SCENES_MAX, SCENE_MAX, SOURCE_MAX, probeLive } from './judgeClient'
import {
  PREPARE_MAX_MS, type Spec, getRun, giveUp, newToken, ordered, saveSpec, specOf, start, subscribe, titleOf,
} from './runs'
import { Card } from './Card'
import { useFollow } from './follow'
import { addRecent } from './recent'

// 판정해 보기: 가운데 입력 하나와 눌러 볼 것 몇 개. 하나를 누르면 채팅처럼 차례가 아래로 쌓이고,
// 차례가 생긴 뒤에는 입력과 버튼이 화면 아래에 고정된다.
// 판정 서버가 있으면 모아 둔 대본도 새로 판정하고(모델 호출), 없으면 저장해 둔 결과를 보여 준다.

function useProbe(p: () => Promise<boolean>): boolean | undefined {
  const [v, setV] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    let on = true
    p().then((x) => on && setV(x))
    return () => {
      on = false
    }
  }, [])
  return v
}

function tokensOf(query: URLSearchParams): string[] {
  return (query.get('t') ?? '').split(',').filter(Boolean)
}

function addTurn(spec: Spec, query: URLSearchParams) {
  const token = spec.kind === 'saved' ? spec.id : newToken()
  saveSpec(token, spec)
  // 새 판정을 시작하면 열려 있던 앞 대본의 보고서를 닫는다(새 결과의 보고서로 잘못 보이지 않게)
  setQuery({ t: [...tokensOf(query), token].join(','), d: undefined, dt: undefined, dc: undefined })
}

// ---- 눌러 볼 것 ----

interface Pill { label: string; spec: Spec }

/** 첫 화면: 글 종류마다 하나. 결정이 서로 다르게 나온 대본을 고른다 */
function homePicks(data: Data): Script[] {
  const list = ordered(data)
  const used = new Set<string>()
  const out: Script[] = []
  for (const t of [...new Set(list.map((x) => x.type))]) {
    // 넣은 글이 너무 짧으면(300자 미만) 대본도 4장면쯤으로 짧아져 첫 예시로 맞지 않는다. 같은 종류에 긴 글이 있으면 그것만 고른다
    const all = list.filter((x) => x.type === t && data.results[x.id])
    const long = all.filter((x) => (data.sources[x.source_id]?.text?.length ?? 0) >= 300)
    const of = long.length ? long : all
    const s = of.find((x) => !used.has(decisionWord(data, data.results[x.id]))) ?? of[0]
    if (!s) continue
    used.add(decisionWord(data, data.results[s.id]))
    out.push(s)
  }
  return out
}

const TRY_WORD: Record<string, string> = { news: '뉴스', blog: '블로그', community: '커뮤니티', product: '제품 소개' }
const tryLabel = (s: Script) => TRY_WORD[s.type] ?? s.type_name

function Pills({ pills, onPick, disabled, row }: { pills: Pill[]; onPick: (p: Pill) => void; disabled?: boolean; row?: boolean }) {
  return (
    <div className={row ? 'pills pills-row' : 'pills'}>
      {pills.map((p, i) => <button key={i} type="button" className="pill" disabled={disabled} onClick={() => onPick(p)}>{p.label}</button>)}
    </div>
  )
}

// ---- 직접 넣기 ----
// 넣은 글과 대본(장면마다 한 줄)을 넣으면 판정 서버가 판정한다. 판정 서버가 있을 때만 그린다.

interface Preset { n: number; source: string; scenes: string }

function Composer({ onSubmit, disabled, compact, preset }: { onSubmit: (spec: Spec) => void; disabled?: boolean; compact?: boolean; preset?: Preset | null }) {
  const [open, setOpen] = useState(false)
  const [fill, setFill] = useState<Preset | null>(null)
  useEffect(() => {
    if (!preset) return
    setFill(preset)
    setOpen(true)
  }, [preset?.n])
  const close = () => {
    setOpen(false)
    setFill(null)
  }
  if (!open) {
    return (
      <button type="button" className={compact ? 'composer-closed composer-compact' : 'composer-closed'} onClick={() => setOpen(true)} aria-expanded={false} disabled={disabled}>
        {compact ? '대본 직접 넣기' : '넣은 글과 대본을 넣으면 판정합니다'}
      </button>
    )
  }
  return <OwnForm key={fill?.n ?? 0} preset={fill} onSubmit={(spec) => { onSubmit(spec); close() }} onClose={close} disabled={disabled} />
}

function OwnForm({ onSubmit, onClose, disabled, preset }: { onSubmit: (spec: Spec) => void; onClose: () => void; disabled?: boolean; preset?: Preset | null }) {
  const [source, setSource] = useState(preset?.source ?? '')
  const [lines, setLines] = useState(preset?.scenes ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const scenes = lines.split('\n').map((l) => l.trim()).filter(Boolean)
  const src = source.trim()
  const long = scenes.findIndex((l) => l.length > SCENE_MAX)
  // 판정 서버(judge/serve.py)와 같은 한도. 비어 있을 때는 빨간 글을 보이지 않는다
  const why = !src || !scenes.length ? ''
    : src.length > SOURCE_MAX ? `넣은 글이 ${src.length.toLocaleString()}자입니다. ${SOURCE_MAX.toLocaleString()}자 이하로 줄여 주세요.`
      : scenes.length > SCENES_MAX ? `장면이 ${scenes.length}개입니다. ${SCENES_MAX}개 이하로 넣어 주세요.`
        : long >= 0 ? `${long + 1}번 장면이 ${scenes[long].length}자입니다. 장면 하나는 ${SCENE_MAX}자 이하로 넣어 주세요.` : ''
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault()
        if (!src || !scenes.length || why) return
        onSubmit({ kind: 'own', source: src, scenes: scenes.map((text) => ({ text })) })
      }}
    >
      <label htmlFor="own-source">넣은 글</label>
      <textarea id="own-source" ref={ref} rows={6} value={source} onChange={(e) => setSource(e.target.value)}
        placeholder="쇼더스에 넣은 기사나 블로그 글을 그대로 붙여 넣어 주세요. 대본의 사실을 이 글과 견줍니다." />
      <label htmlFor="own-scenes">대본</label>
      <textarea id="own-scenes" rows={6} value={lines} onChange={(e) => setLines(e.target.value)} aria-describedby="own-hint"
        placeholder="장면마다 한 줄씩 넣어 주세요." />
      <p id="own-hint" className="hint">장면 {SCENES_MAX}개, 장면 하나 {SCENE_MAX}자까지{scenes.length ? ` · 지금 장면 ${scenes.length}개` : ''}. 장면 길이는 글자 수로 어림합니다. 판정에는 30초쯤 걸리고 모델을 부릅니다.</p>
      <div className="composer-actions">
        <button type="submit" className="primary" disabled={!src || !scenes.length || !!why || disabled} aria-describedby={why ? 'own-why' : undefined}>판정하기</button>
        <button type="button" className="ghost" onClick={onClose}>접기</button>
        {why && <span id="own-why" className="hint hint-error">{why}</span>}
      </div>
    </form>
  )
}

// ---- 한 차례 ----

function turnLabel(data: Data, spec: Spec): string {
  if (spec.kind === 'saved') {
    const s = data.scripts.find((x) => x.id === spec.id)!
    const same = data.scripts.filter((x) => x.source_id === s.source_id)
    return `모아 둔 대본 · ${titleOf(data, s)}${same.length > 1 ? ` · ${same.length}개 중 ${same.indexOf(s) + 1}번째` : ''}`
  }
  return `직접 넣은 대본 · 장면 ${spec.scenes.length}개`
}

function scenesOf(data: Data, spec: Spec) {
  if (spec.kind === 'own') return spec.scenes.map((x, i) => ({ n: i + 1, role: '', sec: x.sec ?? null, text: x.text }))
  return data.scripts.find((x) => x.id === spec.id)?.scenes ?? []
}

function Turn({ data, token, spec, onPaint }: { data: Data; token: string; spec: Spec; onPaint?: () => void }) {
  const st = useSyncExternalStore(subscribe, () => getRun(token))
  useLayoutEffect(() => onPaint?.()) // 따라가기: 그리기 전에 차례 끝을 고정 영역 위로
  useEffect(() => {
    start(token, spec, data)
    // 어떤 경우에도 「준비하는 중」에 머물지 않게: 상한 안에 첫 줄이 서지 않으면 실패 안내로 바꾼다
    const t = setTimeout(() => {
      if (!getRun(token)) giveUp(token, spec, data, '판정을 시작하지 못했습니다. 잠시 뒤 다시 눌러 주세요.')
    }, PREPARE_MAX_MS)
    return () => clearTimeout(t)
  }, [token])
  const f = st?.final
  // 끝난 판정은 왼쪽 메뉴 「최근 판정」에 적는다(recent.ts). 결과 없이 끝난 것은 다시 열어 볼 것이 없어 적지 않는다
  useEffect(() => {
    if (st?.final?.r) addRecent({ token, spec, label: turnLabel(data, spec), verdict: decisionWord(data, st.final.r), run: st })
  }, [!!f])
  const steps = st?.steps ?? [{ text: '준비하는 중', done: false }]
  const judging = steps.find((s) => s.checks)
  const scenes = f?.scenes.length ? f.scenes : scenesOf(data, spec)
  const running = !f
  const criteria = Object.fromEntries((judging?.checks ?? []).filter((c) => c.r).map((c) => [String(c.n), c.r!]))
  const checks = f?.checks ?? judging?.checks ?? []
  return (
    <article className="turn" id={`turn-${token}`}>
      <p className="ask">{turnLabel(data, spec)}</p>
      <p className="sr-only" role="status">{f ? (f.r ? '판정이 끝났습니다.' : f.error ?? '') : ''}</p>
      <Card title={spec.kind === 'own' ? '직접 넣은 대본' : titleOf(data, data.scripts.find((x) => x.id === spec.id)!)}
        data={data} scenes={scenes} final={f} checks={checks}
        running={running ? { criteria, since: judging?.startedAt, text: '확인하는 중', stages: judging?.stages } : undefined} sheetKey={token} flow />
    </article>
  )
}

// ---- 화면 ----

export default function Feed({ data, query }: { data: Data; query: URLSearchParams }) {
  const live = useProbe(probeLive)
  const tokens = tokensOf(query)
  const turns = tokens.map((t) => ({ token: t, spec: specOf(t, data) })).filter((x): x is { token: string; spec: Spec } => !!x.spec)
  const list = ordered(data)
  const lastToken = turns.at(-1)?.token ?? ''
  const busy = useSyncExternalStore(subscribe, () => !!lastToken && !getRun(lastToken)?.final)
  const { newBelow, jump, nudge } = useFollow(lastToken, !busy)

  const submit = (spec: Spec) => addTurn(spec, query)
  let pills: Pill[]
  if (turns.length === 0) {
    pills = homePicks(data).map((s) => ({ label: tryLabel(s), spec: { kind: 'saved', id: s.id } }))
  } else {
    const last = turns[turns.length - 1].spec
    const lastSaved = last.kind === 'saved' ? last.id : undefined
    const lastSource = lastSaved ? data.scripts.find((x) => x.id === lastSaved)?.source_id : undefined
    const i = lastSaved ? list.findIndex((x) => x.id === lastSaved) : -1
    const next = [...list.slice(i + 1), ...list.slice(0, i + 1)].find((x) => x.source_id !== lastSource) ?? list[(i + 1) % list.length]
    pills = [{ label: `모아 둔 다음 대본: ${titleOf(data, next)}`, spec: { kind: 'saved', id: next.id } }]
  }

  // 아래 고정 영역의 실제 높이: feed 아래 여백과 따라가기(follow.ts)가 쓴다
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = bottom.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const set = () => document.documentElement.style.setProperty('--fb-h', `${el.offsetHeight}px`)
    set()
    const ro = new ResizeObserver(set)
    ro.observe(el)
    return () => {
      ro.disconnect()
      document.documentElement.style.removeProperty('--fb-h')
    }
  }, [turns.length > 0])

  if (turns.length === 0) {
    const decided = live !== undefined
    return (
      <div className="hero">
        <div className="hero-main">
          <h1 className="hero-title">쇼츠 대본을 영상으로 만들기 전에 판정합니다</h1>
          {live && <Composer onSubmit={submit} />}
          {/* 판정 서버 확인이 끝나기 전에는 단추 줄을 보이지 않고 누를 수도 없게 둔다. 자리는 같은 높이로 잡아 둔다 */}
          <div className="saved-picks" style={decided ? undefined : { visibility: 'hidden' }} aria-hidden={!decided} inert={!decided}>
            <p className="hint">{live ? '모아 둔 대본을 새로 판정:' : '모아 둔 대본의 판정 결과 보기:'}</p>
            <Pills pills={pills} onPick={(p) => addTurn(p.spec, query)} disabled={!decided} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="feed">
      {turns.map(({ token, spec }) => <Turn key={token} data={data} token={token} spec={spec} onPaint={token === lastToken ? nudge : undefined} />)}
      <div className="feed-bottom" ref={bottom}>
        <div className="feed-bottom-in">
          {live && <Composer onSubmit={submit} disabled={busy} compact />}
          <Pills pills={pills} onPick={(p) => addTurn(p.spec, query)} disabled={busy} row />
        </div>
      </div>
      {newBelow && <button type="button" className="new-below" onClick={jump}>판정 결과 보기 ↓</button>}
    </div>
  )
}
