import { useState } from 'react'
import type { Check, Data, Frac, GoldKey, SetKey } from './types'
import { ScriptName, VerdictBadge, ro, verdictWord } from './common'
import { Panel, usePanel } from './Sheet'

// 「얼마나 믿을 수 있나」: 최종 판정기(5판)를 채점자 정답과 견준 숫자. 처음 보는 대본(시험용 50개)이 먼저다.
// 숫자는 모두 data.json(check)에서 읽는다. export_data.py가 tools/evaluate.py --redecide와 같은 셈으로 만들고 출력과 대조한다.

const SET_WORD: Record<SetKey, string> = { test: '시험용', dev: '개발용', all: '전체' }
const GOLD_WORD: Record<GoldKey, string> = { all: '다수결 정답', sure: '확신 정답' }
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
        {SET_WORD[set]} 대본 {c.n}개를 {GOLD_WORD[gold]}과 견줬어요. 막대는 같게 본 비율, 옅은 띠는 오차 범위입니다.
        대본이 적어 다른 대본으로 다시 재면 비율이 이 안에서 움직일 수 있다는 뜻입니다(95% Wilson 구간).
      </p>
      <h3>판정이 같은 대본</h3>
      <ul className="bars">
        <BarRow label="판정기" f={c.verdict} strong />
        <BarRow label={`모든 대본을 ${topW}${ro(topW)} 내기`} f={{ k: c.baseline.k, n: c.n, lo: pct(c.baseline.k), hi: pct(c.baseline.k) }} range={false} />
      </ul>

      <h3>정답과 판정기</h3>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="정답과 판정기 판정 표">
        <table className="metrics">
          <caption className="sr-only">행은 정답, 열은 판정기 판정</caption>
          <thead>
            <tr><th scope="col">정답 \ 판정기</th>{vs.map((v) => <th key={v} scope="col">{verdictWord(data, v)}</th>)}</tr>
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
        <li>정답이 {verdictWord(data, fail)}인 {c.fail_n}개: 판정기도 {verdictWord(data, fail)} {c.fail_as_fail}, {verdictWord(data, hold)} {c.fail_as_hold}, <b>{verdictWord(data, pass)}{ro(verdictWord(data, pass))} 샘 {c.leak.length}</b></li>
        <li>정답은 {verdictWord(data, pass)}·{verdictWord(data, hold)}인데 판정기가 {verdictWord(data, fail)}시킨 것: {c.not_fail_n}개 중 {c.false_fail.length}개</li>
      </ul>
      {c.leak.length > 0 && <><p className="small">통과로 샌 대본</p><Ids ids={c.leak} /></>}
      {c.false_fail.length > 0 && <><p className="small">잘못 탈락시킨 대본</p><Ids ids={c.false_fail} /></>}

      <h3>기준마다</h3>
      <div className="table-scroll" tabIndex={0} role="region" aria-label="기준마다 견준 표">
        <table className="metrics">
          <caption className="sr-only">기준마다 정답이 건 수와 판정기가 놓치거나 더 건 수</caption>
          <thead>
            <tr><th scope="col">기준</th><th scope="col">정답이 건 수</th><th scope="col">판정기도 걸음</th><th scope="col">놓침</th><th scope="col">더 걸음</th></tr>
          </thead>
          <tbody>
            {Object.entries(c.criteria).map(([n, x]) => (
              <tr key={n}><th scope="row">{n} {nameOf(n)}</th><td>{x.gold}</td><td>{x.both}</td><td>{x.miss}</td><td>{x.extra}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">기준 5(표기)는 정답도 판정기와 같은 표기 규칙에서 나와 견주지 않습니다. 기준 7(길이)과 10(끝맺음)은 진단만 냅니다.</p>

      <h3>판정이 다른 대본 {c.diffs.length}개</h3>
      <ul className="difflist" aria-label="판정기가 정답과 다르게 본 대본">
        {c.diffs.map((d) => {
          const sc = script(d.id)
          return (
            <li key={d.id} className="diff-item diff-verdict">
              {sc ? <ScriptName data={data} s={sc} link /> : d.id}
              <p className="diff-v">판정기 <VerdictBadge data={data} verdict={d.verdict} /> · 정답 <VerdictBadge data={data} verdict={d.gold} /></p>
            </li>
          )
        })}
      </ul>
    </>
  )
}

export default function CheckPage({ data }: { data: Data }) {
  const t = data.check.all.test
  const d = data.check.all.dev
  const sure = data.check.sure.all
  const all = data.check.all.all
  const [, , fail] = data.verdicts
  const failW = verdictWord(data, fail)
  const w = (v: string) => verdictWord(data, v)
  const sheet = usePanel('nums')
  const [set, setSet] = useState<SetKey>('test')
  const [gold, setGold] = useState<GoldKey>('all')

  return (
    <div className="wrap-narrow-in">
      <h1>이 판정기를 얼마나 믿을 수 있나</h1>
      <p className="muted">
        판정기의 판정(통과·보류·탈락)을 시청자 유형이 다른 채점자 세 명이 기준표로 따로 매긴 판정의 다수결과 견준 숫자입니다.
        정답도 채점 에이전트의 합의라 한계가 있고, 탈락으로 합의된 대본만 사람이 넣은 글과 대조해 확인했습니다.
      </p>
      <ol className="conclusions">
        <li>
          <b>처음 보는 대본 {t.n}개</b>(시험용, 판정기를 만드는 동안 판정하지 않음)에서 판정이 {t.verdict.k}개 같았습니다(95% 구간 {ci(t.verdict)}).
          모든 대본을 {w(t.baseline.top)}{ro(w(t.baseline.top))} 내면 {t.baseline.k}개가 같아, 기준선보다 조금 나을 뿐입니다.
        </li>
        <li>
          <b>사실 오류가 있는 {t.fail_n}개 중 {t.fail_n - t.leak.length}개를 통과시키지 않았습니다</b>({failW} {t.fail_as_fail}, 보류 {t.fail_as_hold}).
          통과로 샌 것은 {t.leak.length}개, 멀쩡한 대본을 {failW}시킨 것은 {t.not_fail_n}개 중 {t.false_fail.length}개입니다.
        </li>
        <li>
          개발용 {d.n}개에서는 {d.verdict.k}개가 같았습니다(기준선 {d.baseline.k}개). 98개 전체로는 {all.verdict.k}개입니다.
        </li>
        <li>
          채점자가 「애매」로 적지 않은 걸림만 센 확신 정답으로 보면 98개 중 {sure.verdict.k}개가 같고, 모두 {w(sure.baseline.top)}{ro(w(sure.baseline.top))} 내면 {sure.baseline.k}개입니다.
          판정기가 애매한 걸림까지 걸어 보류를 많이 내기 때문입니다. 이 판정기는 보류가 많은 대신 치명 오류는 적게 새는 쪽에 서 있습니다.
        </li>
      </ol>
      <button type="button" className="detail-btn" aria-expanded={sheet.open} onClick={(e) => sheet.show(e.currentTarget)}>숫자 보기</button>

      {sheet.open && (
        <Panel title="숫자로 본 판정기" sub={`최종 판정기 · 모델 ${data.model}`} onClose={sheet.hide}>
          <div className="detail">
            <Picker label="대본" words={SET_WORD} value={set} onPick={setSet} />
            <Picker label="정답" words={GOLD_WORD} value={gold} onPick={setGold} />
            <Numbers data={data} c={data.check[gold][set]} set={set} gold={gold} />
          </div>
        </Panel>
      )}
    </div>
  )
}
