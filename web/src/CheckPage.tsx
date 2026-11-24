import { useState } from 'react'
import type { Check, Data, Frac, GoldKey, SetKey } from './types'
import { ScriptName, VerdictBadge, href, ro, verdictWord } from './common'
import { Panel, usePanel } from './Sheet'

// 「얼마나 믿을 수 있나」: 최종 판정기(5판)를 채점자 정답과 견준 숫자. 처음 보는 대본(시험용 50개)이 먼저다.
// 숫자는 모두 data.json(check)에서 읽는다. export_data.py가 tools/evaluate.py --redecide와 같은 셈으로 만들고 출력과 대조한다.

const SET_WORD: Record<SetKey, string> = { test: '시험용', dev: '개발용', all: '전체' }
const GOLD_WORD: Record<GoldKey, string> = { all: '채점자 다수결', sure: '확신한 걸림만' }
const ci = (f: Frac) => `${f.lo}~${f.hi}%`

/** 막대 한 줄: 이름, 막대, 숫자. 오차 범위(range)가 없으면 막대만 */
function BarRow({ label, f, strong, range = true }: { label: string; f: Frac; strong?: boolean; range?: boolean }) {
  return (
    <li className={strong ? 'barrow barrow-strong' : 'barrow'}>
      <span className="barrow-label">{label}</span>
      <span className="barrow-bar" aria-hidden="true">
        {range && <span className="barrow-range" style={{ left: `${f.lo}%`, width: `${Math.max(1, f.hi - f.lo)}%` }} />}
        <span className="barrow-fill" style={{ width: `${f.n ? (f.k / f.n) * 100 : 0}%` }} />
      </span>
      <span className="barrow-num">{f.k}/{f.n}{range && <span className="muted"> ({ci(f)})</span>}</span>
    </li>
  )
}

function Picker<T extends string>({ label, words, value, onPick }: { label: string; words: Record<T, string>; value: T; onPick: (x: T) => void }) {
  return (
    <div className="picker" role="group" aria-label={label}>
      <span className="picker-label">{label}</span>
      {(Object.keys(words) as T[]).map((k) => (
        <button key={k} type="button" className={k === value ? 'on' : ''} aria-pressed={k === value} onClick={() => onPick(k)}>{words[k]}</button>
      ))}
    </div>
  )
}

function Numbers({ data, c, set, gold }: { data: Data; c: Check; set: SetKey; gold: GoldKey }) {
  const vs = data.verdicts
  const [pass, hold, fail] = vs
  const topW = verdictWord(data, c.baseline.top)
  const script = (id: string) => data.scripts.find((s) => s.id === id)
  const nameOf = (n: string) => data.criteria.find((x) => String(x.n) === n)?.name ?? ''
  const pct = (k: number) => Math.round((k / c.n) * 100)
  const Ids = ({ ids }: { ids: string[] }) => (
    <ul className="plain">{ids.map((id) => { const s = script(id); return <li key={id}>{s ? <ScriptName data={data} s={s} link /> : id}</li> })}</ul>
  )
  return (
    <>
      <p className="muted">
        {SET_WORD[set]} 대본 {c.n}개를 {GOLD_WORD[gold]}({gold === 'sure' ? '채점자가 「애매」로 적지 않은 걸림만 센 다수결' : 'AI 채점 에이전트 세 명의 다수결'})과 견줬어요. 막대는 같게 본 비율, 옅은 띠는 오차 범위입니다.
        대본이 적어 다른 대본으로 다시 재면 비율이 이 안에서 움직일 수 있다는 뜻입니다(95% Wilson 구간).
      </p>
      <h3>판정이 같은 대본</h3>
      <ul className="bars">
        <BarRow label="판정기" f={c.verdict} strong />
        <BarRow label={`모든 대본을 ${topW}${ro(topW)} 내기`} f={{ k: c.baseline.k, n: c.n, lo: pct(c.baseline.k), hi: pct(c.baseline.k) }} range={false} />
      </ul>

      <h3>채점자와 판정기</h3>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="채점자와 판정기 판정 표">
        <table className="metrics">
          <caption className="sr-only">행은 채점자, 열은 판정기 판정</caption>
          <thead>
            <tr><th scope="col">채점자 \ 판정기</th>{vs.map((v) => <th key={v} scope="col">{verdictWord(data, v)}</th>)}</tr>
          </thead>
          <tbody>
            {vs.map((g) => (
              <tr key={g}>
                <th scope="row">{verdictWord(data, g)} {Object.values(c.confusion[g] ?? {}).reduce((a, b) => a + b, 0)}</th>
                {vs.map((p) => <td key={p} className={g === p ? 'sum' : undefined}>{c.confusion[g]?.[p] ?? 0}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>치명 오류</h3>
      <ul className="muted defs">
        <li>채점자가 {verdictWord(data, fail)}으로 본 {c.fail_n}개: 판정기도 {verdictWord(data, fail)} {c.fail_as_fail}, {verdictWord(data, hold)} {c.fail_as_hold}, <b>{verdictWord(data, pass)} {c.leak.length}</b></li>
        <li>채점자가 {verdictWord(data, pass)}·{verdictWord(data, hold)}로 봤는데 판정기가 {verdictWord(data, fail)}시킨 것: {c.not_fail_n}개 중 {c.false_fail.length}개</li>
      </ul>
      {c.leak.length > 0 && <><p className="small">탈락인데 통과시킨 대본</p><Ids ids={c.leak} /></>}
      {c.false_fail.length > 0 && <><p className="small">멀쩡한데 탈락시킨 대본</p><Ids ids={c.false_fail} /></>}

      <h3>기준마다</h3>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="기준마다 견준 표">
        <table className="metrics">
          <caption className="sr-only">기준마다 채점자가 건 수와 판정기가 놓치거나 더 건 수</caption>
          <thead>
            <tr><th scope="col">기준</th><th scope="col">채점자가 건 수</th><th scope="col">판정기도 걸음</th><th scope="col">놓침</th><th scope="col">더 걸음</th></tr>
          </thead>
          <tbody>
            {Object.entries(c.criteria).map(([n, x]) => (
              <tr key={n}><th scope="row">{n} {nameOf(n)}</th><td>{x.gold}</td><td>{x.both}</td><td>{x.miss}</td><td>{x.extra}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">기준 5(표기)는 채점자 쪽도 판정기와 같은 표기 규칙에서 나와 견주지 않습니다. 기준 7(길이)과 10(끝맺음)은 진단만 냅니다.</p>

      <h3>채점자와 다르게 본 대본 {c.diffs.length}개</h3>
      <ul className="difflist" aria-label="판정기가 정답과 다르게 본 대본">
        {c.diffs.map((d) => {
          const sc = script(d.id)
          return (
            <li key={d.id} className="diff-item diff-verdict">
              {sc ? <ScriptName data={data} s={sc} link /> : d.id}
              <p className="diff-v">채점자 <VerdictBadge data={data} verdict={d.gold} /> · 판정기 <VerdictBadge data={data} verdict={d.verdict} /></p>
            </li>
          )
        })}
      </ul>
    </>
  )
}

export default function CheckPage({ data }: { data: Data }) {
  const t = data.check.all.test
  const all = data.check.all.all
  const [pass, , fail] = data.verdicts
  const w = (v: string) => verdictWord(data, v)
  const sheet = usePanel('nums')
  const [set, setSet] = useState<SetKey>('test')
  const [gold, setGold] = useState<GoldKey>('all')
  const script = (id: string) => data.scripts.find((s) => s.id === id)
  // 채점자와 판정기의 판정은 시험용 견주기(diffs)에서 그대로 읽는다
  const Wrong = ({ ids }: { ids: string[] }) => (
    <ul className="difflist">
      {ids.map((id) => {
        const s = script(id)
        const d = t.diffs.find((x) => x.id === id)
        return (
          <li key={id} className="diff-item diff-verdict">
            {s ? <ScriptName data={data} s={s} link /> : id}
            {d && <p className="diff-v">채점자 <VerdictBadge data={data} verdict={d.gold} /> · 판정기 <VerdictBadge data={data} verdict={d.verdict} /></p>}
          </li>
        )
      })}
    </ul>
  )

  return (
    <div className="wrap-narrow-in">
      <h1>판정기를 믿을 근거</h1>
      <p className="muted">
        판정기를 만들 때 한 번도 보지 않은 대본 {t.n}개(시험용)를 판정기로 판정해, AI 채점 에이전트 세 명(시청자 20·40·60대 역할)이 따로 내린 판정의 다수결과 견줬습니다. 탈락으로 본 대본은 사람이 원래 글과 대조해 확인했습니다.
      </p>
      <div className="stat-row">
        <div className="stat"><b>{t.verdict.k}/{t.n}</b><span>판정이 같음</span><small>모두 {w(t.baseline.top)}{ro(w(t.baseline.top))} 내면 {t.baseline.k}</small></div>
        <div className="stat"><b>{t.fail_n - t.leak.length}/{t.fail_n}</b><span>사실 틀린 대본을 걸러냄</span><small>채점자가 {w(fail)}으로 본 대본</small></div>
        <div className="stat"><b>{t.false_fail.length}/{t.not_fail_n}</b><span>멀쩡한데 {w(fail)}시킴</span><small>채점자가 {w(pass)}·보류로 본 대본</small></div>
      </div>

      <h2>판정기가 틀린 대본</h2>
      <h3>{w(fail)}인데 {w(pass)}시킨 대본 {t.leak.length}개</h3>
      <Wrong ids={t.leak} />
      <h3>멀쩡한데 {w(fail)}시킨 대본 {t.false_fail.length}개</h3>
      <Wrong ids={t.false_fail} />
      <p className="muted small">
        통과와 보류 사이에서 다르게 본 대본까지 모두 보려면 <a href={href(['list'], { f: 'diff' })}>채점자와 다르게 본 대본 {all.diffs.length}개(98개 중)</a>를 여세요.
      </p>
      <button type="button" className="detail-btn" aria-expanded={sheet.open} onClick={(e) => sheet.show(e.currentTarget)}>숫자 자세히 보기</button>

      {sheet.open && (
        <Panel title="숫자로 본 판정기" sub={`최종 판정기 · 모델 ${data.model}`} onClose={sheet.hide}>
          <div className="detail">
            <Picker label="대본" words={SET_WORD} value={set} onPick={setSet} />
            <Picker label="채점자" words={GOLD_WORD} value={gold} onPick={setGold} />
            <Numbers data={data} c={data.check[gold][set]} set={set} gold={gold} />
          </div>
        </Panel>
      )}
    </div>
  )
}
