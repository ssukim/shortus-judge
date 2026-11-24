import type { Data, Script } from './types'
import { VerdictBadge, consensusOf, href, setQuery, verdictWord } from './common'

// 모아 둔 대본 98개: 판정(통과·보류·탈락)으로 거른다. 줄마다 판정 하나만 보이고, 눌러 들어가면 어디가 왜 걸렸는지 나온다.
// 거르기는 주소의 f= (pass, hold, fail, test, diff). diff는 판정기가 채점자와 다르게 본 대본(「판정기를 믿을 근거」에서도 링크함).

type Filter = '' | 'pass' | 'hold' | 'fail' | 'diff' | 'test'

export default function ListPage({ data, query }: { data: Data; query: URLSearchParams }) {
  const results = data.results
  const f = (query.get('f') ?? '') as Filter

  const shown = data.scripts.filter((s) => results[s.id])
  const goldOf = (s: Script) => consensusOf(s)?.verdict
  // 채점자는 원래 대본을 봤으므로 판정기의 판정과 견준다
  const differs = (s: Script) => !!goldOf(s) && goldOf(s) !== results[s.id].verdict
  const [pass, hold, fail] = data.verdicts
  const match: Record<Filter, (s: Script) => boolean> = {
    '': () => true,
    pass: (s) => results[s.id].verdict === pass,
    hold: (s) => results[s.id].verdict === hold,
    fail: (s) => results[s.id].verdict === fail,
    diff: differs,
    test: (s) => s.test,
  }
  const buttons: { id: Filter; label: string }[] = [
    { id: '', label: '전체' },
    { id: 'pass', label: verdictWord(data, pass) },
    { id: 'hold', label: verdictWord(data, hold) },
    { id: 'fail', label: verdictWord(data, fail) },
    { id: 'test', label: '시험용' },
    { id: 'diff', label: '채점자와 다르게 본 대본' },
  ]
  const rows = shown.filter(match[f] ?? match[''])
  const siblings = (s: Script) => shown.filter((x) => x.source_id === s.source_id).length

  return (
    <>
      <section className="intro">
        <h1>모아 둔 대본</h1>
        <p className="muted">쇼더스에서 받은 대본 {shown.length}개를 판정기가 판정한 결과입니다. 대본을 누르면 어디가 왜 걸렸는지 볼 수 있어요.</p>
      </section>

      <div className="picker" role="group" aria-label="결정으로 거르기">
        {buttons.map((b) => (
          <button key={b.id || 'all'} type="button" className={b.id === f ? 'on' : ''} aria-pressed={b.id === f}
            onClick={() => setQuery({ f: b.id || undefined })}>
            {b.label} {shown.filter(match[b.id]).length}
          </button>
        ))}
      </div>

      <ul className="slist" aria-label="대본 목록">
        {rows.map((s) => {
          const r = results[s.id]
          const gold = goldOf(s)
          return (
            <li key={s.id} className="srow">
              <a className="srow-title" href={href(['script', s.id])}>
                {data.sources[s.source_id]?.title || s.id}
                {siblings(s) > 1 && <span className="srow-sub"> · {s.nth}</span>}
              </a>
              <span className="srow-meta">
                {f === 'diff' && gold && <span className="srow-flags">채점자 {verdictWord(data, gold)} · 판정기</span>}
                <VerdictBadge data={data} verdict={r.verdict} />
              </span>
            </li>
          )
        })}
      </ul>
      {rows.length === 0 && <p className="muted">고른 조건에 맞는 대본이 없습니다.</p>}
    </>
  )
}
