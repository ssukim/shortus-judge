import { useEffect, useState, type ReactNode } from 'react'
import type { CriterionResult, Data, Scene } from './types'
import type { CheckLine, Final, Step } from './runs'
import { SHORT_NAME, decisionClass, decisionWord, factMark, verdictClass, verdictWord } from './common'
import { circled, placesOf, type Spot } from './places'
import { Panel, usePanel } from './Sheet'
import { Detail, TAB_LABEL, type DetailTab } from './Detail'
import { Checklist } from './Trace'
import { decisionSay, revWhy, shownRevision, type Revision, type RevScene } from './revision'
import { PlayButton, usePlaying, useTtsReady, type Clip } from './audio'

// 판정봇의 보고: 말풍선(무엇을 확인했고 결론) → 고칠 곳마다 한 문장 → 고칠 곳이 표시된 대본 → 체크 목록 → 「자세히」 시트.
// 판정하는 동안에는 「확인하는 중」과 대본이 먼저 보이고, 기준이 끝나는 대로 체크 목록과 대본 표시가 붙는다.

const LOOSE_SKIP = /[\s.,!?·…'"“”‘’「」『』()\[\]~\-]/

/** 인용을 장면 글에서 찾는다. 그대로 없으면 띄어쓰기·문장부호를 빼고 다시 맞춘다. → [시작, 끝] 또는 null */
function findQuote(text: string, quote: string, from = 0): [number, number] | null {
  const at = text.indexOf(quote, from)
  if (at >= 0) return [at, at + quote.length]
  const idx: number[] = []
  let flat = ''
  for (let i = 0; i < text.length; i++) if (!LOOSE_SKIP.test(text[i])) { flat += text[i]; idx.push(i) }
  const q = [...quote].filter((ch) => !LOOSE_SKIP.test(ch)).join('')
  if (q.length < 2) return null
  const k = flat.indexOf(q)
  if (k < 0 || idx[k] < from) return null
  return [idx[k], idx[k + q.length - 1] + 1]
}

interface Placed { at: number; end: number; fix: string | null; nos: number[] }

/** 장면 하나에 고칠 곳을 놓는다. 같은 구절(겹치는 구절)에 걸린 기준은 번호를 한 묶음으로. 못 맞춘 인용의 번호는 따로 돌려준다 */
export function placeSpots(text: string, spots: Spot[]): { placed: Placed[]; loose: number[] } {
  const placed: Placed[] = []
  const loose: number[] = []
  const add = (n: number | null, arr: number[]) => n != null && !arr.includes(n) && arr.push(n)
  for (const s of [...spots].sort((a, b) => b.quote.length - a.quote.length)) {
    const r = s.quote ? findQuote(text, s.quote) : null
    if (!r) { add(s.no, loose); continue }
    const [at, end] = r
    const hit = placed.find((p) => at < p.end && end > p.at)
    if (hit) { add(s.no, hit.nos); continue }
    const p: Placed = { at, end, fix: s.fix, nos: [] }
    add(s.no, p.nos)
    placed.push(p)
  }
  placed.sort((a, b) => a.at - b.at)
  for (const p of placed) p.nos.sort((a, b) => a - b)
  return { placed, loose: loose.filter((n) => !placed.some((p) => p.nos.includes(n))).sort((a, b) => a - b) }
}

/** 장면 문장 위에 고칠 곳을 얹는다. 바꿀 말이 있으면 지우는 줄 + 바꿀 말, 없으면 밑줄 + 번호 묶음(마침표 앞).
 *  못 맞춘 인용의 번호는 여기 붙이지 않는다(ScriptView가 장면 번호 옆에 모음) */
export function SceneText({ text, spots, numbers = true, onNo }: { text: string; spots: Spot[]; numbers?: boolean; onNo?: (no: number) => void }) {
  const No = ({ no }: { no: number }) => onNo
    ? <button type="button" className="no no-btn" onClick={() => onNo(no)} aria-label={`${circled(no)} 고칠 곳 자세히 보기`}>{circled(no)}</button>
    : <sup className="no">{circled(no)}</sup>
  const Nos = ({ nos }: { nos: number[] }) => (numbers && nos.length ? <span className="nos">{nos.map((n) => <No key={n} no={n} />)}</span> : null)
  const { placed } = placeSpots(text, spots)
  const out: ReactNode[] = []
  let i = 0
  placed.forEach((p, k) => {
    if (p.at > i) out.push(text.slice(i, p.at))
    let q = text.slice(p.at, p.end)
    // 구절이 문장부호로 끝나면 번호를 그 앞에
    const tail = q.match(/[.?!。]+$/)?.[0] ?? ''
    if (tail && !p.fix) q = q.slice(0, -tail.length)
    // 밑줄 친 구절도 번호와 같이 누를 수 있다(그 구절의 첫 번호 기준을 연다). 화면 읽기에는 번호 단추만 읽히게 둔다
    const open = onNo && p.nos.length ? () => onNo(p.nos[0]) : undefined
    const hit = (body: ReactNode) => open
      ? <span className="hit-click" onClick={open} title="자세히 보기">{body}</span>
      : body
    if (p.fix) {
      out.push(<span key={k} className="swap">{hit(<><del>{q}</del><span className="sr-only">를 이렇게 바꿈:</span> <ins>{p.fix}</ins></>)}<Nos nos={p.nos} /></span>)
    } else {
      out.push(<span key={k}>{hit(<u className="hit-u">{q}</u>)}<Nos nos={p.nos} />{tail}</span>)
    }
    i = p.end
  })
  if (i < text.length) out.push(text.slice(i))
  return <>{out}</>
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(t)
  }, [])
  return <>{Math.max(0, Math.floor((now - since) / 1000))}초</>
}

/** 「보류」 → 「보류예요」, 「탈락」 → 「탈락이에요」 (받침에 따라) */
const copula = (w: string) => {
  const c = w.charCodeAt(w.length - 1)
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 === 0 ? `${w}예요` : `${w}이에요`
}

/** 판정봇 얼굴 (단색) */
export function BotFace() {
  return (
    <svg className="bot-face" viewBox="0 0 24 24" width="28" height="28" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="currentColor" />
      <rect x="7.5" y="8" width="3" height="7" rx="1.5" className="bot-eye" />
      <rect x="13.5" y="8" width="3" height="7" rx="1.5" className="bot-eye" />
    </svg>
  )
}

const hm = (iso?: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(+d)) return ''
  const t = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return d.toDateString() === new Date().toDateString() ? t : `${d.getMonth() + 1}월 ${d.getDate()}일 ${t}`
}

/** 판정봇 말풍선 하나 */
export function Bubble({ at, tag, children, report }: { at?: string | null; tag?: ReactNode; children: ReactNode; report?: boolean }) {
  return (
    <div className={report ? 'bot bot-report' : 'bot'}>
      <BotFace />
      <div className="bot-body">
        <p className="bot-name">판정봇{at ? <span className="bot-at"> {hm(at)}</span> : null}{tag}</p>
        <div className="bubble">{children}</div>
      </div>
    </div>
  )
}

/** 일하는 중: 얼굴 + 한 낱말과 초 */
export function Working({ text, since }: { text: string; since?: number }) {
  return (
    <div className="bot bot-working" role="status">
      <BotFace />
      <p className="working">
        <span className="dots" aria-hidden="true"><i /><i /><i /></span> {text}{since ? <> · <Elapsed since={since} /></> : null}
      </p>
    </div>
  )
}

/** 판정해 보기 차례의 판정봇 머리줄 하나: 얼굴 + 이름 (+ 끝나면 시각과 꼬리표). 꼬리표가 붙어도 높이가 그대로다 */
function BotHead({ at, tag }: { at?: string | null; tag?: ReactNode }) {
  return (
    <div className="bot-head">
      <BotFace />
      <p className="bot-name">판정봇{at ? <span className="bot-at"> {hm(at)}</span> : null}{tag}</p>
    </div>
  )
}

/** 판정해 보기 덩어리 안의 진행 줄: 얼굴 없이 점 세 개 + 한 낱말과 초 */
function WorkLine({ text, since }: { text: string; since?: number }) {
  return (
    <p className="working work-line" role="status">
      <span className="dots" aria-hidden="true"><i /><i /><i /></span> {text}{since ? <> · <Elapsed since={since} /></> : null}
    </p>
  )
}

export function Card({ data, scenes, final, running, checks = [], pre = [], sheetKey, extra, emptyNote, title, flow }: {
  title?: string // 대본 제목 (보고서 패널 위)
  // 판정해 보기(Feed): 판정봇 머리줄 하나 아래로 흐르는 순서. (받은 대본 한 줄) → 대본 → 진행 줄 → 확인 목록 → (끝나면) 결론 말풍선 → 보고서 카드 → 만들 대본 견주기.
  // 없으면(모아 둔 대본 화면) 판정봇 보고가 먼저 나온다
  flow?: boolean
  data: Data
  scenes: Scene[]
  final?: Final
  running?: { criteria: Record<string, CriterionResult>; since?: number; text: string; stages?: { text: string; sec: number }[] } // 판정하는 동안
  checks?: CheckLine[]
  pre?: Step[] // 쇼더스에서 받기 (판정 앞 단계)
  sheetKey: string
  extra?: ReactNode // 시트에 더 넣을 것 (모아 둔 대본 화면)
  emptyNote?: string
}) {
  const panel = usePanel(sheetKey)
  const ttsOk = useTtsReady()
  // 판정봇 말의 「고친 대본 보기」: 펼쳐 둔 만들 대본 견주기로 옮긴다 (머리줄 아래로는 html의 scroll-padding-top).
  // 휴대폰 폭에서는 이미 보이는 자리라 옮겨 가지 않을 수 있어, 잠깐 테두리와 바탕색(flash)을 주어 눌렀다는 것이 보이게 한다
  const showRevised = () => {
    const open = document.querySelector<HTMLElement>(`#turn-${CSS.escape(sheetKey)} .rev-open`) ?? document.querySelector<HTMLElement>('.rev-open')
    if (!open) return
    open.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    open.classList.remove('flash')
    void open.offsetWidth
    open.classList.add('flash')
    window.setTimeout(() => open.classList.remove('flash'), 1600)
  }
  const r = final?.r
  const criteria = r?.criteria ?? running?.criteria ?? {}
  const shownScenes = final?.scenes.length ? final.scenes : scenes
  // 들어 보기: 판정 서버의 api/tts(쇼더스 목소리 미리 듣기)로 받는다. 서버나 쇼더스 키가 없으면 단추를 보이지 않는다
  const origClip = (n: number, key = `${sheetKey}-o${n}`): Clip | null => {
    const sc = shownScenes.find((x) => x.n === n)
    return ttsOk && sc ? { key, text: sc.text } : null
  }
  const p = placesOf(data, { criteria }, shownScenes, { sourceText: final?.sourceText })
  const nos = Object.fromEntries(p.problems.map((x) => [x.n, circled(x.no)]))
  const got = pre.find((s) => s.scenes && s.done)

  const freshBubble = got && (
    <Bubble at={final?.origin?.receivedAt ?? undefined}>
      <p>쇼더스에서 대본을 받아 왔어요 · 장면 {got.scenes!.length}개</p>
    </Bubble>
  )
  const preWorking = !got && pre.some((s) => !s.done) && <Working text="대본 받는 중" since={pre.find((s) => s.startedAt)?.startedAt} />

  if (final && !r) {
    if (flow) {
      return (
        <section className="result" aria-label="판정 결과">
          <BotHead at={final.at} />
          <div className="bot-flow">
            {got && <p className="bot-line">쇼더스에서 대본을 받아 왔어요 · 장면 {got.scenes!.length}개</p>}
            <div className="bubble bot-report"><p role="alert">{final.error ?? emptyNote ?? '판정 결과가 없어요.'}</p></div>
            {shownScenes.length > 0 && <ScriptView scenes={shownScenes} spots={[]} />}
          </div>
        </section>
      )
    }
    return (
      <section className="result" aria-label="판정 결과">
        {freshBubble}
        <Bubble><p role="alert">{final.error ?? emptyNote ?? '판정 결과가 없어요.'}</p></Bubble>
        {shownScenes.length > 0 && <ScriptView scenes={shownScenes} spots={[]} />}
      </section>
    )
  }

  const [pass, hold, fail] = data.verdicts
  const v = r?.verdict
  const notChecked = r ? r.source_given === false || Object.values(r.criteria).some((c) => c.not_checked) : false
  const n = shownScenes.length
  const lead = notChecked ? `대본 ${n}장면을 봤어요. 원래 글이 없어서 내용이 맞는지는 보지 않았어요.` : `대본 ${n}장면을 넣은 글과 맞춰 봤어요.`
  const end = !v ? '' : v === pass ? (notChecked ? '말투·길이·흐름에는 걸린 곳이 없어요. 내용이 맞는지는 원래 글을 넣어야 볼 수 있어요.'
      : r!.decision?.action === 'render_revised' ? '표기만 고친 대본으로 만들어요.' : r!.flagged.length ? '이 대본 그대로 만들어요.' : '고칠 곳이 없어요. 이 대본 그대로 만들어요.')
    : v === hold ? (p.count ? `${p.count}곳이 걸렸어요.` : '걸린 곳이 있어요.')
      : v === fail ? '넣은 글과 다른 내용이 있어 이대로는 안 돼요.'
        : '몇 가지를 판정하지 못했어요.'
  const pick = (n: number) => panel.show(null, { tab: 'criteria', crit: n })
  const onNo = (no: number) => {
    const n = p.problems.find((x) => x.no === no)?.n
    if (n != null) panel.show(document.activeElement as HTMLElement, { tab: 'criteria', crit: n })
  }
  // 통과면 대본을 다시 보이지 않는다(할 일이 없음)
  const showScript = !!running || (!!v && v !== pass)
  const judgedAt = final?.at
  // 고친 대본: 탈락·보류면 판정봇이 고치고 다시 판정한 것(두 번 고쳤으면 결정이 고른 판), 통과면 표기만 고친 것.
  // 없거나 실패면 견주기를 숨긴다 (revision.ts)
  const act = r?.decision?.action
  const readingOnly = !!v && v === pass && act === 'render_revised'
  // 탈락·보류는 판정봇이 실제로 고쳐 다시 판정한 것(method model)만. 고치기 전에 저장한 결과의 표기만 고친 대본은 보이지 않는다
  const byModel = (r?.revision as { method?: string } | null | undefined)?.method === 'model'
  const rev = r && (((v === fail || v === hold) && byModel) || readingOnly) && (r.revision_2 || r.revision) ? shownRevision(r) : null
  const revOk = rev && !rev.error && rev.scenes.some((x) => x.changed) ? rev : null
  const revClip = (x: RevScene): Clip | null => {
    const key = `${sheetKey}-r${x.n}`
    if (!x.changed) return origClip(x.n, key)
    return ttsOk ? { key, text: x.reading || x.after } : null
  }
  // 판정해 보기 차례 끝에 펼쳐 둘 견주기 (결정이 고친 대본이거나, 고쳐 봤지만 만들지 않거나 사람이 볼 때). 원래 대본으로 만들면 붙이지 않는다
  const lastRound = r?.revision_2 ? 2 : 1
  const times = (r?.decision?.round ?? lastRound) === 2 ? '두 번' : '한 번'
  const revTitle = readingOnly ? '영상으로 만들 대본 · 표기를 고친 대본'
    : act === 'render_revised' ? `영상으로 만들 대본 · ${times} 고친 대본`
      : act === 'review' && r?.decision?.round ? `${times} 고친 대본 · 사람이 보고 정함`
        : act === 'do_not_render' ? '고쳐 봤지만 사실 틀림이 남은 대본' : null
  const shortName = (n: number) => { const nm = data.criteria.find((c) => c.n === n)?.name ?? ''; return SHORT_NAME[nm] ?? nm }
  const decided = r ? decisionSay(data, r, shortName) : null
  const left = (r?.decision as { remaining?: unknown } | undefined)?.remaining // decision.remaining: [{criterion, name}]
  const remaining = Array.isArray(left) && left.length ? left.map((x) => (typeof x === 'number' ? shortName(x)
    : x && typeof x === 'object' && typeof (x as { criterion?: unknown }).criterion === 'number' ? shortName((x as { criterion: number }).criterion)
      : String(x))).join('·')
    : typeof left === 'string' && left ? left : null
  // 결정이 없는 결과(결정을 넣기 전에 저장한 것)는 고친 대본의 판정만 말한다
  const againSay = (again?: string) => !again ? ''
    : again === pass ? '고친 대본은 통과예요.'
      : again === hold || again === fail ? `고친 대본${again === v ? '도' : '은'} ${copula(verdictWord(data, again))}.`
        : '고친 대본은 판정하지 못했어요.'
  const revSay = r?.decision ? decided && (decided
      + (revOk?.new_numbers.length ? ` 고친 대본에 넣은 글에 없는 숫자 ${[...new Set(revOk.new_numbers.map((x) => x.number))].join(', ')}이 들어갔어요.` : ''))
    : !rev ? null : rev.error || !revOk ? '고친 대본을 만들지 못했어요.'
      : `고친 대본을 만들어 다시 판정했어요. ${againSay(revOk.verdict)}`
        + (revOk.verdict && revOk.verdict !== pass ? revWhy(revOk, data) : '')

  // 보고서 패널 탭 (고친 대본이 있으면 하나 더)
  const tabIds: DetailTab[] = ['criteria', 'source', 'sound', ...(revOk ? ['revision' as const] : [])]
  const tabs = tabIds.map((t) => ({ id: t, label: TAB_LABEL[t] }))
  const tab: DetailTab = tabIds.includes(panel.tab as DetailTab) ? (panel.tab as DetailTab) : 'criteria'
  // 보고서 카드의 작은 줄: 넣은 글과 소리 (실제로 한 것만)
  const c5 = data.criteria.find((c) => c.name === '잘못 읽을 표기')
  const c5r = c5 ? criteria[String(c5.n)] : undefined
  const soundWord = c5r?.listen && !c5r.listen.skipped ? '소리로 들어 봄' : ''
  const flaggedN = r ? data.criteria.filter((c) => r.criteria[String(c.n)]?.flagged).length : 0

  const working = running && (got || !pre.length) && <Working text={running.text} since={running.since} />
  const tags = !running && v && <span className="vtags"><span className={`vtag vtag-${verdictClass(data, r!.verdict)}`}>{verdictWord(data, r!.verdict)}</span><span className={`vtag vtag-${decisionClass(data, r!)}`}>{decisionWord(data, r!)}</span>{factMark(data, r!) && <span className="fact-mark">사실 틀림</span>}</span>
  const reportBody = !running && v && (
    <>
      <p className="lead-say">{lead} <b>{end}</b></p>
      {v !== pass && p.says.length > 0 && (
        <ul className="says">
          {p.says.map((s) => <li key={s.n}>{s.no != null && <span className="no">{circled(s.no)}</span>} {s.text}</li>)}
        </ul>
      )}
      {revSay && <p className="rev-say">{revSay}{revOk && revTitle && <> <button type="button" className="inline-link" onClick={showRevised}>고친 대본 보기</button></>}</p>}
    </>
  )
  const report = reportBody && <Bubble report at={judgedAt} tag={tags}>{reportBody}</Bubble>
  const reportCard = !running && final && r && (
    <div className="report-card">
      <ReportIcon />
      <div className="rc-text">
        <p className="rc-title">판정 보고서 · 기준 {data.criteria.length}개 중 {flaggedN}개 걸림</p>
        <p className="rc-sub">{[final.sourceText ? '넣은 글 1개' : '넣은 글 없음', soundWord].filter(Boolean).join(' · ')}</p>
      </div>
      <button type="button" className="rc-btn" aria-expanded={panel.open}
        onClick={(e) => panel.show(e.currentTarget, { tab: 'criteria' })}>세부정보 보기</button>
    </div>
  )
  const original = <ScriptView scenes={shownScenes} spots={p.spots} onNo={final ? onNo : undefined} clip={final && r ? origClip : undefined} />
  const checklist = checks.length > 0 && (running || r) && (
    <Checklist checks={checks} running={!!running} elapsed={final?.requestId ? r?.elapsed_sec ?? undefined : undefined} scenes={shownScenes} nos={showScript ? nos : {}}
      stages={final?.stages ?? running?.stages} onPick={final && r ? pick : undefined} folded={flow && !running} />
  )
  const panelEl = final && r && panel.open && (
    <Panel title="판정 보고서" sub={title} onClose={panel.hide} tabs={tabs} tab={tab} onTab={panel.setTab}>
      <Detail data={data} r={r} final={final} scenes={shownScenes} sheetKey={sheetKey} extra={extra}
        tab={tab} crit={panel.crit} onPick={pick} revision={revOk ? <RevisionChanges rev={revOk} say={revSay} hits={c5r?.hits} clip={revClip} origClip={origClip} /> : undefined} />
    </Panel>
  )

  // 만들 대본 견주기: 결정이 고친 대본이거나 고쳐 봤지만 만들지 않을 때 판정 보고서 카드 아래에 펼쳐 둔다 (두 화면 같음)
  const revOpen = revOk && !running && revTitle && (
    <section className="rev rev-open" aria-label={revTitle}>
      <h3 className="rev-title">{revTitle}{remaining && <span className="rev-left"> 남은 곳: {remaining}</span>}</h3>
      <RevisionChanges rev={revOk} hits={c5r?.hits} clip={revClip} origClip={origClip} />
    </section>
  )

  // 통과한 대본도 쇼더스로 넘길 대본이므로 다른 판정과 같은 자리에 「만들 대본 · 원래 대본」으로 전체와 듣기 단추를 둔다
  const passOpen = !running && !!v && v === pass && !readingOnly && shownScenes.length > 0 && (
    <section className="rev rev-open" aria-label="영상으로 만들 대본 · 원래 대본">
      <h3 className="rev-title">영상으로 만들 대본 · 원래 대본</h3>
      {original}
    </section>
  )

  if (flow) {
    // 판정해 보기: 한 차례의 판정봇은 하나. 머리줄(얼굴·이름, 끝나면 시각과 꼬리표)을 처음부터 맨 위에 두고, 그 아래 한 덩어리에 위에서 아래로 쌓는다.
    // 끝날 때 위쪽에는 머리줄 안의 꼬리표만 붙고(높이 고정) 끼어드는 것이 없어 화면이 위아래로 놀지 않는다
    return (
      <section className="result" aria-label="판정 결과" aria-busy={!!running}>
        <BotHead at={!running && v ? judgedAt : undefined} tag={tags} />
        <div className="bot-flow">
          {final?.notice && <p className="bot-line bot-notice" role="alert">{final.notice}</p>}
          {got && <p className="bot-line">쇼더스에서 대본을 받아 왔어요 · 장면 {got.scenes!.length}개</p>}
          {!got && pre.some((s) => !s.done) && <WorkLine text="대본 받는 중" since={pre.find((s) => s.startedAt)?.startedAt} />}
          {showScript && shownScenes.length > 0 && original}
          {running && (got || !pre.length) && <WorkLine text={running.text} since={running.since} />}
          {checklist}
          {reportBody && <div className="bubble bot-report">{reportBody}</div>}
          {reportCard}
          {final?.revising && <WorkLine text={final.revising.text} since={final.revising.since} />}
          {revOpen}
          {passOpen}
        </div>
        {panelEl}
      </section>
    )
  }

  return (
    <section className="result" aria-label="판정 결과" aria-busy={!!running}>
      {preWorking}
      {final?.notice && <Bubble><p role="alert">{final.notice}</p></Bubble>}
      {freshBubble}
      {working}
      {report}
      {reportCard}
      {revOpen}
      {passOpen}

      {showScript && shownScenes.length > 0 && (revOpen ? <section className="rev"><h3 className="rev-title">원래 대본</h3>{original}</section> : original)}

      {revOpen && <p className="cl-about">아래는 원래 대본을 확인한 결과예요.</p>}
      {checklist}
      {panelEl}
    </section>
  )
}

export function ScriptView({ scenes, spots, onNo, clip }: { scenes: Scene[]; spots: Spot[]; onNo?: (no: number) => void; clip?: (n: number) => Clip | null }) {
  const now = usePlaying()
  const clips = clip ? scenes.map((sc) => clip(sc.n)).filter((c): c is Clip => !!c) : []
  return (
    <>
      {clips.length > 1 && <div className="listen-all"><PlayButton clips={clips} label="원래 대본 전체 듣기" text="전체 듣기" /></div>}
      <ol className="script" aria-label="장면별 대본">
        {scenes.map((sc) => {
          const c = clip?.(sc.n)
          return (
            <li key={sc.n} className={c && now === c.key ? 'playing' : undefined}>
              <SceneNo n={sc.n} loose={placeSpots(sc.text, spots.filter((s) => s.scene === sc.n)).loose} onNo={onNo} />
              <p><SceneText text={sc.text} spots={spots.filter((s) => s.scene === sc.n)} onNo={onNo} /></p>
              {c && <PlayButton clips={[c]} label={`${sc.n}번 장면 듣기`} />}
            </li>
          )
        })}
      </ol>
    </>
  )
}

/** 만들 대본: 장면 1~n을 순서대로. 바뀐 장면(글자를 고쳤거나 읽는 법만 고친 장면)은 모두 같은 틀로 그린다:
 *  고친 문장 → 원래(글자를 고쳤으면 줄 그음, 아니면 「글자는 그대로」) → 읽는 법(글자도 고친 장면만. 읽는 법만 고친 장면은
 *  까닭 줄에 바꾼 표기가 이미 있음) → 고친 까닭 → 원래 소리 단추. */
function RevisionChanges({ rev, say, clip, origClip }: {
  rev: Revision; say?: string | null; hits?: Hits; clip?: (x: RevScene) => Clip | null; origClip?: (n: number, key?: string) => Clip | null
}) {
  const now = usePlaying()
  const clips = clip ? rev.scenes.map(clip).filter((c): c is Clip => !!c) : []
  return (
    <>
      {say && <p className="muted">{say}</p>}
      {clips.length > 1 && <div className="listen-all"><PlayButton clips={clips} label="영상으로 만들 대본 전체 듣기" text="전체 듣기" /></div>}
      <ol className="rev-list" aria-label="영상으로 만들 대본">
        {rev.scenes.map((x) => {
          const textChanged = x.after !== x.before
          const changed = x.changed || textChanged
          const c = clip?.(x)
          const before = changed ? origClip?.(x.n, `rev-orig-${x.n}-${x.before.length}`) : null
          const cls = [changed ? 'rev-changed' : '', c && now === c.key ? 'playing' : ''].filter(Boolean).join(' ')
          return (
            <li key={x.n} className={cls || undefined}>
              <span className="sn" aria-label={`${x.n}번 장면`}>{x.n}</span>
              <div className="rev-body">
                <p className="rev-after">{changed && <span className="sr-only">고친 문장: </span>}{x.after}</p>
                {changed && (
                  <p className="rev-orig"><span>원래:</span> {textChanged ? <del>{x.before}</del> : '글자는 그대로'}</p>
                )}
                {textChanged && x.reading && <p className="rev-reading"><span>읽는 법:</span> {x.reading}</p>}
                {changed && x.why && <p className="rev-why">→ {x.why}</p>}
                {before && <PlayButton clips={[before]} label={`${x.n}번 장면 원래 소리 듣기`} small text="원래 소리" />}
              </div>
              {c && <PlayButton clips={[c]} label={`${x.n}번 장면 듣기`} />}
            </li>
          )
        })}
      </ol>
    </>
  )
}

type Hits = { scene: number; text: string; fix: string | null }[]

function ReportIcon() {
  return (
    <svg className="rc-icon" viewBox="0 0 40 44" width="40" height="44" aria-hidden="true">
      <rect x="1" y="1" width="38" height="42" rx="7" className="rc-paper" />
      <rect x="8" y="9" width="20" height="3" rx="1.5" className="rc-line" />
      <rect x="8" y="15" width="13" height="3" rx="1.5" className="rc-line" />
      <rect x="8" y="27" width="4" height="9" rx="1" className="rc-bar" />
      <rect x="15" y="23" width="4" height="13" rx="1" className="rc-bar" />
      <rect x="22" y="29" width="4" height="7" rx="1" className="rc-bar" />
      <rect x="29" y="20" width="4" height="16" rx="1" className="rc-bar" />
    </svg>
  )
}

/** 장면 번호. 구절을 장면 글에서 맞추지 못한 기준의 번호는 밑줄 없이 여기 곁에 작게 모은다 */
function SceneNo({ n, loose, onNo }: { n: number; loose: number[]; onNo?: (no: number) => void }) {
  return (
    <span className="sn" aria-label={`${n}번 장면`}>
      {n}
      {loose.length > 0 && (
        <span className="sn-nos">
          {loose.map((no) => onNo
            ? <button key={no} type="button" className="no-btn sn-no" onClick={() => onNo(no)} aria-label={`${circled(no)} 고칠 곳 자세히 보기`}>{circled(no)}</button>
            : <span key={no} className="sn-no">{circled(no)}</span>)}
        </span>
      )}
    </span>
  )
}
