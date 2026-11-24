import { type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Data, Script } from './types'
import { decisionWord, setQuery, verdictWord } from './common'
import { FULL_NOTE, SCENES_MAX, SCENE_MAX, SOURCE_MAX, TEXT_MAX, TEXT_MIN, freshFull, freshLeft, pastedTitle, probeFresh, probeLive, subscribeFull } from './judgeClient'
import {
  PREPARE_MAX_MS, type Final, type Spec, getRun, giveUp, newToken, ordered, saveSpec, specOf, start, subscribe, titleOf,
} from './runs'
import { Card } from './Card'
import { useFollow } from './follow'
import { addRecent } from './recent'

// 판정해 보기: 가운데 입력 줄 하나와 눌러 볼 것 몇 개. 하나를 누르면 채팅처럼 차례가 아래로 쌓이고,
// 차례가 생긴 뒤에는 입력칸과 버튼이 화면 아래에 고정된다(머리줄은 위에 고정, App.tsx).

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
  const token = spec.kind === 'saved' ? spec.id : newToken(spec.kind)
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

/** 버튼 글자: 무엇을 하는지만 */
// 앞에 「예시 글 넣기:」나 「모아 둔 대본으로 바로 판정:」이 붙으므로 글 종류만 짧게
const TRY_WORD: Record<string, string> = { news: '뉴스', blog: '블로그', community: '커뮤니티', product: '제품 소개' }
const tryLabel = (s: Script) => TRY_WORD[s.type] ?? s.type_name

/** 쇼더스에서 새로 받기는 한 줄 위에 따로, 그 아래 나머지 */
function Pills({ pills, onPick, disabled, row }: { pills: Pill[]; onPick: (p: Pill) => void; disabled?: boolean; row?: boolean }) {
  // 아래 고정 영역: 한 줄로, 넘치면 가로 스크롤
  if (row) {
    return (
      <div className="pills pills-row">
        {pills.map((p, i) => <button key={i} type="button" className={p.spec.kind === 'fresh' || p.spec.kind === 'text' ? 'pill pill-main' : 'pill'} disabled={disabled} onClick={() => onPick(p)}>{p.label}</button>)}
      </div>
    )
  }
  const fresh = pills.filter((p) => p.spec.kind === 'fresh' || p.spec.kind === 'text')
  const rest = pills.filter((p) => p.spec.kind !== 'fresh' && p.spec.kind !== 'text')
  return (
    <div className="pill-area">
      {fresh.length > 0 && (
        <div className="pills">
          {fresh.map((p, i) => <button key={i} type="button" className="pill pill-main" disabled={disabled} onClick={() => onPick(p)}>{p.label}</button>)}
        </div>
      )}
      {rest.length > 0 && (
        <div className="pills">
          {rest.map((p, i) => <button key={i} type="button" className="pill" disabled={disabled} onClick={() => onPick(p)}>{p.label}</button>)}
        </div>
      )}
    </div>
  )
}

// ---- 입력 줄 ----

// 입력은 하나다: 글을 넣으면 쇼더스가 대본을 만들고 판정한다(spec.kind 'text').
// 쇼더스에서 받기를 쓸 수 없으면 입력 칸을 두지 않는다(Feed에서 freshOk일 때만 그린다).
// 대본을 직접 넣는 입력은 화면에서 뺐다. 최근 판정에 남은 예전 'own' 차례는 그리기와 판정 요청(runs.ts)이 그대로 받는다.

/** 첫 화면 「예시 글 넣기」가 입력 칸에 채울 글. n은 누를 때마다 늘어 같은 단추를 다시 눌러도 다시 채운다.
 * sourceId: 판정 서버가 source_id로 받을 수 있는 모아 둔 글일 때만 둔다 */
// scenes: 「가진 대본 넣기」에 채울 대본(장면마다 한 줄). text는 원래 글(두 탭이 같이 씀)
interface Preset { n: number; text: string; sourceId?: string; scenes?: string }

// 입력은 두 갈래다(D38).
//   쇼더스로 대본 만들기: 원래 글을 넣으면 쇼더스가 대본을 만들고 판정한다(spec.kind 'text'). 쇼더스 키가 없거나 하루 한도를 다 썼으면 끈다
//   가진 대본 넣기: 가진 대본(장면마다 한 줄)을 넣는다. 원래 글은 넣어도 되고 안 넣어도 된다(spec.kind 'own')
type Mode = 'fresh' | 'own'
function Composer({ onSubmit, disabled, compact, preset, full, canFresh }: {
  onSubmit: (spec: Spec) => void; disabled?: boolean; compact?: boolean; preset?: Preset | null; full?: boolean; canFresh?: boolean
}) {
  const freshOn = !!canFresh && !full
  const [mode, setMode] = useState<Mode>(freshOn ? 'fresh' : 'own')
  const [open, setOpen] = useState(false)
  const [fill, setFill] = useState<Preset | null>(null) // 접으면 비운다(다시 열면 빈 칸)
  // 쇼더스를 쓸 수 있는지는 화면을 그린 뒤에 알게 된다. 칸을 열기 전이면 그에 맞춰 기본 탭을 바꾼다
  useEffect(() => { if (!open || !freshOn) setMode(freshOn ? 'fresh' : 'own') }, [freshOn])
  // 예시 단추: 지금 탭의 칸을 채운다(쇼더스 탭은 원래 글, 가진 대본 탭은 대본과 원래 글).
  // 칸이 처음 그려질 때 이미 있던 예시(첫 화면에서 채우고 판정한 것)는 다시 열지 않는다
  const seenPreset = useRef(preset?.n)
  useEffect(() => {
    if (!preset || preset.n === seenPreset.current) return
    seenPreset.current = preset.n
    setFill(preset)
    setOpen(true)
  }, [preset?.n])
  const close = () => {
    setOpen(false)
    setFill(null)
  }
  const pick = (m: Mode) => { setMode(m); setOpen(true) }
  const label = mode === 'fresh'
    ? (compact ? '원래 글 넣기' : '원래 글을 넣으면 쇼더스가 대본을 만들고 판정합니다')
    : (compact ? '가진 대본 넣기' : '가진 대본을 넣어 판정합니다')
  const why = !canFresh ? '' : full ? FULL_NOTE : ''
  const tabs = (
    <div className="mode-tabs" role="tablist" aria-label="무엇을 넣을지">
      <button type="button" role="tab" aria-selected={mode === 'fresh'} className={mode === 'fresh' ? 'on' : ''}
        disabled={!freshOn || disabled} onClick={() => pick('fresh')} aria-describedby={why ? 'full-note' : undefined}>쇼더스로 대본 만들기</button>
      <button type="button" role="tab" aria-selected={mode === 'own'} className={mode === 'own' ? 'on' : ''}
        disabled={disabled} onClick={() => pick('own')}>가진 대본 넣기</button>
    </div>
  )
  const left = useSyncExternalStore(subscribeFull, freshLeft)
  const note = why && !compact ? <p id="full-note" className="hint">{why}</p>
    : freshOn && mode === 'fresh' && left ? <p className="hint">오늘 쇼더스로 {left.left}번 더 만들 수 있어요 (하루 {left.limit}번)</p> : null
  if (!open) {
    return (
      <div className="composer-wrap">
        {tabs}
        <button type="button" className={compact ? 'composer-closed composer-compact' : 'composer-closed'} onClick={() => setOpen(true)} aria-expanded={false} disabled={disabled}>
          {label}
        </button>
        {note}
      </div>
    )
  }
  return (
    <div className="composer-wrap">
      {tabs}
      {mode === 'own'
        ? <OwnForm key={`own-${fill?.n ?? 0}`} preset={fill} onSubmit={(spec) => { onSubmit(spec); close() }} onClose={close} disabled={disabled} />
        : <TextForm key={fill?.n ?? 0} preset={fill} onSubmit={(spec) => { onSubmit(spec); close() }} onClose={close} disabled={disabled} />}
      {note}
    </div>
  )
}

/** 가진 대본 넣기: 대본(장면마다 한 줄)은 꼭, 원래 글은 넣으면 대본이 원래 글과 같은 말을 하는지(기준 1~4)까지 본다 */
function OwnForm({ onSubmit, onClose, disabled, preset }: { onSubmit: (spec: Spec) => void; onClose: () => void; disabled?: boolean; preset?: Preset | null }) {
  const [source, setSource] = useState(preset?.text ?? '')
  const [lines, setLines] = useState(preset?.scenes ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const scenes = lines.split('\n').map((l) => l.trim()).filter(Boolean)
  const src = source.trim()
  const long = scenes.findIndex((l) => l.length > SCENE_MAX)
  // 판정 서버(judge/serve.py)와 같은 한도. 비어 있을 때는 빨간 글을 보이지 않는다
  const why = !scenes.length ? ''
    : src.length > SOURCE_MAX ? `원래 글이 ${src.length.toLocaleString()}자입니다. ${SOURCE_MAX.toLocaleString()}자 이하로 줄여 주세요.`
      : scenes.length > SCENES_MAX ? `장면이 ${scenes.length}개입니다. ${SCENES_MAX}개 이하로 넣어 주세요.`
        : long >= 0 ? `${long + 1}번 장면이 ${scenes[long].length}자입니다. 장면 하나는 ${SCENE_MAX}자 이하로 넣어 주세요.` : ''
  return (
    <form
      className="composer composer-own"
      onSubmit={(e) => {
        e.preventDefault()
        if (!scenes.length || why) return
        onSubmit({ kind: 'own', source: src, scenes: scenes.map((text) => ({ text })) })
      }}
    >
      {/* 넓은 화면에서는 대본과 원래 글을 좌우로 나란히 둔다(style.css .own-grid) */}
      <div className="own-grid">
      <div className="own-col">
      <label htmlFor="own-scenes">대본</label>
      <textarea id="own-scenes" ref={ref} rows={10} value={lines} onChange={(e) => setLines(e.target.value)} aria-describedby="own-hint"
        placeholder="장면마다 한 줄씩 넣어 주세요." />
      <p id="own-hint" className="hint">장면 {SCENES_MAX}개, 장면 하나 {SCENE_MAX}자까지{scenes.length ? ` · 지금 장면 ${scenes.length}개` : ''}. 장면 길이는 글자 수로 어림합니다.</p>
      </div>
      <div className="own-col">
      <label htmlFor="own-source">원래 글 <span className="muted">(선택 · 대본을 만들 때 쓴 기사나 블로그 글)</span></label>
      <textarea id="own-source" rows={10} value={source} onChange={(e) => setSource(e.target.value)} aria-describedby="own-source-hint"
        placeholder="넣으면 대본이 원래 글과 같은 말을 하는지(틀린 내용이 없는지)도 봅니다." />
      <p id="own-source-hint" className="hint">{src ? '원래 글과 견주어 틀린 내용까지 봅니다.' : '비워 두면 말투·길이·흐름만 보고, 내용이 맞는지는 보지 않습니다.'}</p>
      </div>
      </div>
      <p className="hint">판정에는 30초쯤, 보류·탈락이면 고친 대본까지 1분쯤 걸립니다.</p>
      <div className="composer-actions">
        <button type="submit" className="primary" disabled={!scenes.length || !!why || disabled} aria-describedby={why ? 'own-why' : undefined}>판정하기</button>
        <button type="button" className="ghost" onClick={onClose}>접기</button>
        {why && <span id="own-why" className="hint hint-error">{why}</span>}
      </div>
    </form>
  )
}


function TextForm({ onSubmit, onClose, disabled, preset }: { onSubmit: (spec: Spec) => void; onClose: () => void; disabled?: boolean; preset?: Preset | null }) {
  const [text, setText] = useState(preset?.text ?? '')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => ref.current?.focus(), [])
  const n = text.trim().length
  // 서버(judge/fresh.py)와 같은 길이 규칙. 비어 있을 때는 빨간 글을 보이지 않는다
  const why = n === 0 ? '' : n < TEXT_MIN ? `글이 ${n}자입니다. ${TEXT_MIN}자 이상 넣어 주세요.`
    : n > TEXT_MAX ? `글이 ${n.toLocaleString()}자입니다. ${TEXT_MAX.toLocaleString()}자 이하로 줄여 주세요.` : ''
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault()
        if (n === 0 || why) return
        // 예시 글을 하나도 고치지 않았으면 모아 둔 글 받기 길(fresh)로 보낸다. 차례 이름도 모아 둔 글 제목이 된다
        if (preset?.sourceId && text === preset.text) onSubmit({ kind: 'fresh', sourceId: preset.sourceId })
        else onSubmit({ kind: 'text', text: text.trim(), title: pastedTitle(text) })
      }}
    >
      <label htmlFor="paste-text">원래 글 <span className="muted">(쇼더스에 보낼 기사나 블로그 글)</span></label>
      <textarea id="paste-text" ref={ref} rows={8} value={text} onChange={(e) => setText(e.target.value)} aria-describedby="paste-text-hint"
        placeholder="기사나 블로그 글을 그대로 붙여 넣어 주세요. 첫 줄을 제목으로 씁니다." />
      <p id="paste-text-hint" className="hint">{TEXT_MIN}자 이상, {TEXT_MAX.toLocaleString()}자 이하{n ? ` · 지금 ${n.toLocaleString()}자` : ''}. 쇼더스가 대본을 만들면 이 글과 견주어 틀린 내용까지 확인합니다.</p>
      <div className="composer-actions">
        <button type="submit" className="primary" disabled={n === 0 || !!why || disabled} aria-describedby={why ? 'paste-why' : undefined}>대본 받아 판정하기</button>
        <button type="button" className="ghost" onClick={onClose}>접기</button>
        {why && <span id="paste-why" className="hint hint-error">{why}</span>}
      </div>
    </form>
  )
}

// ---- 한 차례 ----

/** 그 차례의 글로 쇼더스에서 대본을 받을 spec. 받을 글이 없으면 null
 * - 모아 둔 대본·모아 둔 글로 받은 대본: 같은 source_id. 판정 서버의 받기 목록(judge/fresh.py source_ids, data/sources)은
 *   모아 둔 대본의 글(data/sources)과 같다
 * - 붙여 넣은 글로 받은 대본: 같은 글
 * - 직접 넣은 대본(예전 기록의 'own'): 두지 않는다 */
function againOf(data: Data, spec: Spec): Spec | null {
  const freshable = new Set(ordered(data).map((x) => x.source_id))
  const src = spec.kind === 'saved' ? data.scripts.find((x) => x.id === spec.id)?.source_id : spec.kind === 'fresh' ? spec.sourceId : undefined
  if (src) return freshable.has(src) ? { kind: 'fresh', sourceId: src } : null
  if (spec.kind === 'text') return spec.text ? { kind: 'text', text: spec.text, title: spec.title } : null
  return null
}

const sameAgain = (a: Spec, b: Spec) =>
  (a.kind === 'fresh' && b.kind === 'fresh' && a.sourceId === b.sourceId) ||
  (a.kind === 'text' && b.kind === 'text' && a.text === b.text)

// 이름 틀(최근 판정도 같은 이름): 모아 둔 대본 · 제목 / 쇼더스에서 새로 받은 대본 · 제목 / 가진 대본 · 장면 n개
function turnLabel(data: Data, spec: Spec, freshNo: number): string {
  if (spec.kind === 'saved') {
    // 같은 글로 만든 대본이 여럿이면 몇 개 중 몇 번째인지 (가려 둔 대본도 쇼더스가 만든 것이라 센다)
    const s = data.scripts.find((x) => x.id === spec.id)!
    const same = data.scripts.filter((x) => x.source_id === s.source_id)
    return `모아 둔 대본 · ${titleOf(data, s)}${same.length > 1 ? ` · ${same.length}개 중 ${same.indexOf(s) + 1}번째` : ''}`
  }
  if (spec.kind === 'fresh' || spec.kind === 'text') {
    // 모아 둔 글이든 붙여 넣은 글이든 같은 틀. 같은 글로 두 번째부터 몇 번째인지
    const title = spec.kind === 'text' ? spec.title : data.sources[spec.sourceId]?.title ?? ''
    return `쇼더스에서 새로 받은 대본 · ${freshNo > 1 ? `같은 글 ${freshNo}번째 · ` : ''}${title}`
  }
  return `가진 대본 · 장면 ${spec.scenes.length}개`
}

/** 판정 전에 보일 장면 (서버에 보낸 것과 같음) */
function scenesOf(data: Data, spec: Spec, steps: { scenes?: Final['scenes'] }[] = []): Final['scenes'] {
  if (spec.kind === 'own') return spec.scenes.map((x, i) => ({ n: i + 1, role: '', sec: x.sec ?? null, text: x.text }))
  if (spec.kind === 'saved') return data.scripts.find((x) => x.id === spec.id)?.scenes ?? []
  return steps.find((x) => x.scenes)?.scenes ?? []
}

// again: 이 차례 글로 쇼더스에서 받기 (차례 안에 둔다. 한 번 눌러 아래에 받으면 Feed가 null로 넘겨 사라진다)
function Turn({ data, token, spec, freshNo, onPaint, again, onAgain, busy, full }: {
  data: Data; token: string; spec: Spec; freshNo: number; onPaint?: () => void; again?: Spec | null; onAgain?: (s: Spec) => void; busy?: boolean; full?: boolean
}) {
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
    if (st?.final?.r && !st.final.revising) addRecent({ token, spec, label: turnLabel(data, spec, freshNo), verdict: `${verdictWord(data, st.final.r.verdict)} · ${decisionWord(data, st.final.r)}`, run: st })
  }, [!!f && !f.revising])
  const steps = st?.steps ?? [{ text: '준비하는 중', done: false }]
  const judging = steps.find((s) => s.checks)
  const scenes = f?.scenes.length ? f.scenes : scenesOf(data, spec, steps)
  const running = !f
  const criteria = Object.fromEntries((judging?.checks ?? []).filter((c) => c.r).map((c) => [String(c.n), c.r!]))
  const checks = f?.checks ?? judging?.checks ?? []
  const since = judging?.startedAt
  return (
    <article className="turn" id={`turn-${token}`}>
      <p className="ask">{turnLabel(data, spec, freshNo)}</p>
      {/* 판정기에 실제로 들어간 것: 넣은 글 전체와 대본 장면. 판정이 끝나면 눌러서 보고서의 「넣은 글」 탭을 연다 */}
      {(() => {
        const src = f?.sourceText || (spec.kind === 'saved' ? data.sources[data.scripts.find((x) => x.id === spec.id)?.source_id ?? '']?.text
          : spec.kind === 'fresh' ? data.sources[spec.sourceId]?.text : spec.kind === 'text' ? spec.text : spec.source) || ''
        const what = [src ? `넣은 글 ${src.trim().length.toLocaleString()}자` : '', scenes.length ? `대본 ${scenes.length}장면` : ''].filter(Boolean).join(' · ')
        if (!what) return null
        return f?.r && src
          ? <button type="button" className="ask-input" onClick={() => setQuery({ d: token, dt: 'source', dc: undefined })}>판정기에 넣은 것: {what} · 넣은 글 보기</button>
          : <p className="ask-input">판정기에 넣은 것: {what}</p>
      })()}
      <p className="sr-only" role="status">{f ? (f.revising ? '결론이 나왔습니다. 고친 대본을 만드는 중입니다.' : f.r ? '판정이 끝났습니다.' : f.error ?? '') : ''}</p>
      <Card title={spec.kind === 'own' ? '가진 대본' : spec.kind === 'text' ? spec.title : spec.kind === 'saved' ? titleOf(data, data.scripts.find((x) => x.id === spec.id)!) : data.sources[spec.sourceId]?.title}
        data={data} scenes={scenes} final={f} checks={checks} pre={steps.filter((s) => !s.judge && !s.checks)}
        running={running ? { criteria, since, text: '확인하는 중', stages: judging?.stages } : undefined} sheetKey={token} flow />
      {f && !f.revising && again && onAgain && (
        <div className="pills turn-again">
          <button type="button" className="pill pill-main" disabled={busy || full} onClick={() => onAgain(again)} aria-describedby={full ? `full-${token}` : undefined}>
            {spec.kind === 'fresh' || spec.kind === 'text' ? '같은 글로 쇼더스 대본 한 번 더 받기' : '이 글로 쇼더스 대본 받기'}
          </button>
          {full && <span id={`full-${token}`} className="hint">{FULL_NOTE}</span>}
        </div>
      )}
    </article>
  )
}

// ---- 화면 ----

/** 첫 화면 틀. 자료를 받기 전(App)과 받은 뒤(Feed)에 제목이 같은 자리에 있게 위에서부터 놓는다 */
/** 첫 화면을 준비하는 동안 입력 칸 자리에 보이는 뼈대(자료·판정 서버 확인을 기다리는 동안) */
function HeroLoading() {
  return (
    <div className="hero-skel" aria-busy="true">
      <span className="sr-only" role="status">판정기를 준비하고 있어요</span>
      <div className="skel-tabs"><span className="skel skel-tab" /><span className="skel skel-tab" /></div>
      <div className="skel skel-input" />
      <div className="skel-pills"><span className="skel skel-pill" /><span className="skel skel-pill" /><span className="skel skel-pill" /><span className="skel skel-pill" /></div>
    </div>
  )
}

export function HeroShell({ children }: { children?: ReactNode }) {
  return (
    <div className="hero">
      <div className="hero-main">
        <h1 className="hero-title">쇼츠 대본을 영상으로 만들기 전에 판정합니다</h1>
        {children ?? <HeroLoading />}
      </div>
    </div>
  )
}

export default function Feed({ data, query }: { data: Data; query: URLSearchParams }) {
  const live = useProbe(probeLive)
  const freshOk = useProbe(probeFresh)
  const full = useSyncExternalStore(subscribeFull, freshFull)
  const tokens = tokensOf(query)
  const turns = tokens.map((t) => ({ token: t, spec: specOf(t, data) })).filter((x): x is { token: string; spec: Spec } => !!x.spec)
  const list = ordered(data)
  const lastToken = turns.at(-1)?.token ?? ''
  // 마지막 차례가 끝나기 전에는 아래 버튼을 그 자리에 둔 채 누를 수 없게
  // 결론이 나왔어도 고친 대본을 만드는 동안은 아래 단추를 누를 수 없게 둔다
  const busy = useSyncExternalStore(subscribe, () => !!lastToken && (!getRun(lastToken)?.final || !!getRun(lastToken)?.final?.revising))
  // 채팅처럼 따라가기 (follow.ts)
  const { newBelow, jump, nudge } = useFollow(lastToken, !busy)

  const submit = (spec: Spec) => addTurn(spec, query)
  // 첫 화면에서 입력 칸이 보이면(쇼더스 받기를 쓸 수 있으면) 단추는 그 대본의 원래 글을 칸에 채우기만 한다
  // 첫 화면에서 입력 칸이 있으면(판정 서버가 있으면) 예시 단추는 칸을 채우기만 한다. 판정은 「판정하기」를 눌러야 시작한다
  // 판정 서버가 있으면 예시 단추는 첫 화면이든 아래 고정 영역이든 입력 칸을 채우기만 한다. 판정은 「판정하기」를 눌러야 시작한다
  const withFill = !!live
  // 확인이 끝났는지: 서버가 없다고 나왔거나, 쇼더스 받기 확인까지 끝났을 때
  const decided = live === false || (live !== undefined && freshOk !== undefined)
  const [preset, setPreset] = useState<Preset | null>(null)
  const fillFrom = (scriptId: string) => {
    const sid = data.scripts.find((x) => x.id === scriptId)?.source_id
    const src = sid ? data.sources[sid] : undefined
    if (!sid || !src?.text) return
    // 입력 칸은 첫 줄을 제목으로 쓴다. 모아 둔 글은 이미 「제목, 빈 줄, 본문」 꼴이라 그대로 넣고, 첫 줄에 제목이 없을 때만 앞에 붙인다
    const body = src.text.trim()
    const firstLine = body.split('\n')[0] ?? ''
    // 모아 둔 제목은 첫 문장을 잘라 「…」을 붙인 것이 있어, 「…」을 떼고 첫 줄의 앞부분인지 본다
    const head = (src.title ?? '').replace(/…$/, '').trim()
    const text = !head || firstLine.includes(head) ? body : `${src.title}\n\n${body}`
    // 판정 서버의 받기 목록(judge/fresh.py source_ids)은 모아 둔 대본(ordered)의 글과 같다(againOf 주석 참고)
    const freshable = list.some((x) => x.source_id === sid)
    const scenes = data.scripts.find((x) => x.id === scriptId)?.scenes.map((x) => x.text).join('\n') ?? ''
    setPreset((p) => ({ n: (p?.n ?? 0) + 1, text, sourceId: freshable ? sid : undefined, scenes }))
    setLastFilled(scriptId)
  }
  // 아래 「다음 예시 넣기」가 마지막으로 채운 대본. 누를 때마다 그다음 예시로 넘어간다
  const [lastFilled, setLastFilled] = useState<string | null>(null)
  const pick = (p: Pill) => (withFill && p.spec.kind === 'saved' ? fillFrom(p.spec.id) : addTurn(p.spec, query))
  let pills: Pill[]
  if (turns.length === 0) {
    pills = [
      ...homePicks(data).map((s) => ({ label: tryLabel(s), spec: { kind: 'saved', id: s.id } as Spec })),
    ]
  } else {
    const last = turns[turns.length - 1].spec
    // 기준: 마지막으로 채운 예시, 없으면 마지막 차례
    const lastSaved = lastFilled ?? (last.kind === 'saved' ? last.id : undefined)
    const lastSource = lastSaved ? data.scripts.find((x) => x.id === lastSaved)?.source_id : last.kind === 'fresh' ? last.sourceId : undefined
    const i = lastSaved ? list.findIndex((x) => x.id === lastSaved) : -1
    // 다음 대본: 다른 글로 만든 것. 같은 글의 다른 대본은 차례 아래 「같은 글로 쇼더스 대본 한 번 더 받기」가 맡는다
    const next = [...list.slice(i + 1), ...list.slice(0, i + 1)].find((x) => x.source_id !== lastSource) ?? list[(i + 1) % list.length]
    pills = [{ label: `${withFill ? '다음 예시 넣기' : '모아 둔 다음 대본'}: ${titleOf(data, next)}`, spec: { kind: 'saved', id: next.id } }]
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
    return (
      <HeroShell>
        {/* 판정 서버 확인(probeLive, probeFresh)이 끝나기 전에는 입력 칸과 단추 줄을 같이 숨긴다.
            어느 단추 줄인지(예시 글 넣기 / 바로 판정)가 확인 결과로 정해지기 때문. 끝나면 둘이 한 번에 나타난다 */}
        {!decided && <HeroLoading />}
        <div className={decided ? 'hero-below on' : 'hero-below hero-below-wait'} aria-hidden={!decided} inert={!decided}>
          {live && <Composer onSubmit={submit} preset={preset} full={full} canFresh={!!freshOk} />}
          <div className="saved-picks">
            <p className="hint">{withFill ? '예시 넣기:' : '모아 둔 대본으로 바로 판정:'}</p>
            <Pills pills={pills} onPick={pick} disabled={!decided} />
          </div>
        </div>
      </HeroShell>
    )
  }

  // 몇 번째인지: 쇼더스에서 받은 차례를 같은 글끼리 센다(예시 글은 글 id, 붙여 넣은 글은 제목과 본문)
  const textNo = new Map<string, number>()
  const noOf = (spec: Spec) => {
    if (spec.kind !== 'text' && spec.kind !== 'fresh') return 0
    const k = spec.kind === 'fresh' ? `id:${spec.sourceId}` : `${spec.title}\n${spec.text}`
    textNo.set(k, (textNo.get(k) ?? 0) + 1)
    return textNo.get(k)!
  }
  return (
    <div className="feed">
      {turns.map(({ token, spec }, i) => {
        // 이 차례 글로 이미 아래에 받았으면 단추를 거둔다
        const again = freshOk ? againOf(data, spec) : null
        const used = !!again && turns.slice(i + 1).some((x) => sameAgain(x.spec, again))
        return <Turn key={token} data={data} token={token} spec={spec} freshNo={noOf(spec)} onPaint={token === lastToken ? nudge : undefined}
          again={used ? null : again} onAgain={submit} busy={busy} full={full} />
      })}
      <div className="feed-bottom" ref={bottom}>
        <div className="feed-bottom-in">
          {live && <Composer onSubmit={submit} disabled={busy} compact preset={preset} full={full} canFresh={!!freshOk} />}
          <Pills pills={pills} onPick={pick} disabled={busy} row />
        </div>
      </div>
      {newBelow && <button type="button" className="new-below" onClick={jump}>판정 결과 보기 ↓</button>}
    </div>
  )
}
