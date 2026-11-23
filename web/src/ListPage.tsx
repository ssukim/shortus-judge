import type { Data, Script } from './types'
import { DECISION_WORD, DecisionBadge, SHORT_NAME, agentWord, consensusOf, decisionKind, href, setQuery } from './common'

// 모아 둔 대본 98개: 결정(그대로 · 고친 대본 · 사람이 봄 · 만들지 않음)으로 거르거나, 판정기가 채점자 정답과 다르게 본 대본을 찾는다.
// 거르기는 주소의 f= (original, revised, review, none, diff, test).

type Filter = '' | 'original' | 'revised' | 'review' | 'none' | 'diff' | 'test'

export default function ListPage({ data, query }: { data: Data; query: URLSearchParams }) {
  const results = data.results
  const f = (query.get('f') ?? '') as Filter

  const shown = data.scripts.filter((s) => results[s.id])
  const goldOf = (s: Script) => consensusOf(s)?.verdict
  // 채점자는 원래 대본을 봤으므로 판정기의 판정과 견준다
  const differs = (s: Script) => !!goldOf(s) && goldOf(s) !== results[s.id].verdict
  const match: Record<Filter, (s: Script) => boolean> = {
    '': () => true,
    original: (s) => decisionKind(results[s.id]) === 'original',
    revised: (s) => decisionKind(results[s.id]) === 'revised',
    review: (s) => decisionKind(results[s.id]) === 'review',
    none: (s) => decisionKind(results[s.id]) === 'none',
    diff: differs,
    test: (s) => s.test,
  }
  const buttons: { id: Filter; label: string }[] = [
    { id: '', label: '전체' },
    { id: 'original', label: DECISION_WORD.original },
    { id: 'revised', label: DECISION_WORD.revised },
    { id: 'review', label: DECISION_WORD.review },
    { id: 'none', label: '만들지 않음' },
    { id: 'diff', label: '채점자와 판정 다름' },
    { id: 'test', label: '시험용' },
  ]
  const rows = shown.filter(match[f] ?? match[''])
  const siblings = (s: Script) => shown.filter((x) => x.source_id === s.source_id).length
  const nameOf = (n: number) => data.criteria.find((c) => c.n === n)?.name ?? ''

  return (
    <>
      <section className="intro">
        <h1>모아 둔 대본</h1>
        <p className="muted">쇼더스에서 받은 대본 {shown.length}개(시험용 {shown.filter((s) => s.test).length}개)와 최종 판정기의 결과입니다.</p>
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
          const flags = r.flagged.map((n) => SHORT_NAME[nameOf(n)] ?? nameOf(n)).join(' · ')
          return (
            <li key={s.id} className="srow">
              <a className="srow-title" href={href(['script', s.id])}>
                {data.sources[s.source_id]?.title || s.id}
                {siblings(s) > 1 && <span className="srow-sub"> · {s.nth}</span>}
              </a>
              <span className="srow-meta">
                <DecisionBadge data={data} r={r} />
                {flags && <span className="srow-flags">{flags}</span>}
                {differs(s) && <span className="tag">채점자: {agentWord(data, gold!)}</span>}
                {s.test && <span className="tag">시험용</span>}
              </span>
            </li>
          )
        })}
      </ul>
      {rows.length === 0 && <p className="muted">고른 조건에 맞는 대본이 없습니다.</p>}
    </>
  )
}
