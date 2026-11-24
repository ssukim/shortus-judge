import { useState } from 'react'
import type { Scene } from './types'
import type { CheckLine } from './runs'

// 체크 목록 카드: 기준마다 한 줄. 판정 서버는 한 번에 답하므로 판정이 끝날 때 한꺼번에 채워진다(runs.ts의 checks).
// 지어낸 진행 줄은 없다(연습 모드만 저장해 둔 결과를 한 줄씩 채움).
// 끝나면 걸린 줄은 펼친 채 두고, 안 걸린 줄은 「그 밖에 N가지는 문제없어요」로 접는다.
// 저장해 둔 결과는 쌓이는 흉내 없이 처음부터 끝난 모양이다.

/** 안 걸린 기준의 한 줄 (판정기가 짧은 이유를 주면 그것) */
const OK: Record<string, string> = {
  '없는 내용, 바뀐 뜻': '넣은 글에 없는 내용이 없어요',
  '숫자·날짜·이름': '넣은 글과 같아요',
  '세게 바꿔 말함': '넣은 글보다 세게 말한 곳이 없어요',
  '빠진 내용': '중요한 내용이 다 들어 있어요',
  '잘못 읽을 표기': '잘못 읽을 표기가 없어요',
  '말하듯 쓴 문장': '말하듯 썼어요',
  '길이': '45초 안이에요',
  '첫 장면': '첫 장면만 들어도 무슨 얘기인지 알아요',
  '이어짐, 되풀이': '장면이 잘 이어져요',
  '끝맺음': '마지막 장면이 끝맺어요',
}

const where = (ns: number[], scenes: Scene[]) => {
  const u = [...new Set(ns)].filter((n) => scenes.some((s) => s.n === n)).sort((a, b) => a - b)
  return u.length === 0 || (u.length === scenes.length && scenes.length > 1) ? '대본 전체' : `${u.join('·')}번 장면`
}

function okText(l: CheckLine, scenes: Scene[]): string {
  const r = l.r!
  if (l.name === '길이' && r.total_sec != null) {
    // 숫자 옆에 어떻게 셌는지. 30초 미만은 걸지 않고 알리기만 한다(기준표 「가정한 값」)
    const t = Math.round(r.total_sec * 10) / 10
    const sum = Math.round(scenes.reduce((a, s) => a + (s.sec ?? 0), 0) * 10) / 10
    const how = r.sec_factor && sum ? `(쇼더스 예상 ${sum}초 × 실제 목소리 비율 ${r.sec_factor})` : ''
    return t < 30 ? `전체 ${t}초${how} · 짧은 편이지만 걸지 않아요` : `전체 ${t}초${how}로 45초 안이에요`
  }
  if (r.short?.trim()) return r.short.trim()
  return OK[l.name] ?? '문제없어요'
}

function Line({ l, scenes, nos, onPick }: { l: CheckLine; scenes: Scene[]; nos: Record<number, string>; onPick?: (n: number) => void }) {
  const r = l.r!
  if (l.state === 'error') return <li className="tl tl-error"><span className="tl-mark" aria-hidden="true">?</span><span className="tl-text">{l.name} — 답을 받지 못했어요</span><Sec l={l} /></li>
  if (l.state === 'pass') return <li className="tl tl-ok"><span className="tl-mark" aria-hidden="true">✓</span><span className="tl-text">{l.name} — {okText(l, scenes)}</span><Sec l={l} /></li>
  const ns = [...r.scenes, ...(r.hits ?? []).map((h) => h.scene), ...(r.marks ?? []).map((m) => m.scene)]
  const text = <>{l.name} — {where(ns, scenes)}{nos[l.n] ? ` ${nos[l.n]}` : ''}</>
  return (
    <li className="tl tl-hit">
      <span className="tl-mark" aria-hidden="true">!</span>
      {onPick ? <button type="button" className="tl-text tl-link" onClick={() => onPick(l.n)}>{text}</button> : <span className="tl-text">{text}</span>}
      <Sec l={l} />
    </li>
  )
}

const Sec = ({ l }: { l: CheckLine }) => <span className="tl-sec">{l.sec != null ? `${l.sec}초` : ''}</span>

export function Checklist({ checks, running, elapsed, scenes, nos = {}, stages = [], onPick, folded }: {
  onPick?: (n: number) => void // 걸린 줄을 누르면 보고서 패널을 그 기준으로
  folded?: boolean // 끝난 뒤 「10가지를 확인했어요 · 26초」 한 줄로 접음 (판정해 보기). 누르면 펼침
  checks: CheckLine[]
  stages?: { text: string; sec: number }[] // 판정 앞뒤의 단계 줄 (들어온 차례대로)
  running: boolean
  elapsed?: number // 끝난 판정의 걸린 초 (저장해 둔 결과는 없음)
  scenes: Scene[]
  nos?: Record<number, string> // 기준 번호 → 대본에 붙은 동그라미 번호 (①)
}) {
  const [okOpen, setOkOpen] = useState(false)
  const done = checks.filter((c) => c.state !== 'doing')
  const streamed = done.some((c) => c.seq != null)
  // 끝난 차례대로. 흘려보내지 않은 결과는 코드가 보는 기준 먼저
  const sorted = streamed
    ? [...done].sort((a, b) => (a.seq ?? 99) - (b.seq ?? 99))
    : [...done].sort((a, b) => Number((a.by ?? a.r?.by ?? '').startsWith('model')) - Number((b.by ?? b.r?.by ?? '').startsWith('model')) || a.n - b.n)
  const skipped = sorted.filter((c) => c.state === 'not_checked')
  const hits = sorted.filter((c) => c.state === 'hit' || c.state === 'error')
  const oks = sorted.filter((c) => c.state === 'pass')
  const total = checks.length
  const head = running ? `확인한 것 ${done.length}/${total}` : `${total}가지를 확인했어요${elapsed != null ? ` · ${Math.round(elapsed)}초` : ''}`

  const body = (
    <>
      <ol className="tlines">
        {running ? sorted.filter((c) => c.state !== 'not_checked').map((l) => <Line key={l.n} l={l} scenes={scenes} nos={nos} onPick={onPick} />)
          : hits.map((l) => <Line key={l.n} l={l} scenes={scenes} nos={nos} onPick={onPick} />)}
        {skipped.length > 0 && (
          <li className="tl tl-skip"><span className="tl-mark" aria-hidden="true">–</span><span className="tl-text">원래 글이 없어 내용 대조({skipped.length}가지)는 건너뛰었어요</span><span className="tl-sec" /></li>
        )}
        {stages.map((g, i) => {
          const doing = running && i === stages.length - 1
          return (
            <li key={`g${i}`} className={doing ? 'tl tl-doing' : 'tl tl-ok'}>
              <span className="tl-mark" aria-hidden="true">{doing ? '…' : '✓'}</span>
              <span className="tl-text">{g.text}</span>
              <span className="tl-sec">{g.sec}초</span>
            </li>
          )
        })}
        {running && done.length < total && (
          <li className="tl tl-doing"><span className="tl-mark" aria-hidden="true">…</span><span className="tl-text">{total - done.length}가지 보는 중</span><span className="tl-sec" /></li>
        )}
      </ol>
      {!running && oks.length > 0 && (
        <details className="fold cl-ok" open={okOpen} onToggle={(e) => setOkOpen((e.target as HTMLDetailsElement).open)}>
          <summary>{hits.length ? `그 밖에 ${oks.length}가지는 문제없어요` : `${oks.length}가지 모두 문제없어요`}</summary>
          <ol className="tlines">{oks.map((l) => <Line key={l.n} l={l} scenes={scenes} nos={nos} onPick={onPick} />)}</ol>
        </details>
      )}
    </>
  )
  if (folded && !running) {
    return (
      <details className="checklist fold cl-folded" aria-label="확인한 것">
        <summary className="cl-head">{head}</summary>
        {body}
      </details>
    )
  }
  return (
    <section className="checklist" aria-label="확인한 것">
      <p className="cl-head">{head}</p>
      {body}
    </section>
  )
}
