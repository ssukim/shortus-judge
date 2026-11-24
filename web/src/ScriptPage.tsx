import type { Data } from './types'
import { DecisionBadge, agentWord, consensusOf, href } from './common'
import { Card, ScriptView } from './Card'
import { savedFinal } from './runs'

// 모아 둔 대본 한 편: 판정해 보기와 같은 카드. 채점자 정답과 견주기, 넣은 글 전문은 「자세히」 시트에.

function Word({ data, verdict }: { data: Data; verdict?: string }) {
  if (!verdict) return <span className="muted">없음</span>
  const cls = ['pass', 'hold', 'fail'][data.verdicts.indexOf(verdict)] ?? 'none'
  return <span className={`vtext v-${cls}`}>{agentWord(data, verdict)}</span>
}

export default function ScriptPage({ data, id }: { data: Data; id: string }) {
  const s = data.scripts.find((x) => x.id === id)
  if (!s) {
    return (
      <p className="notice">
        없는 대본입니다. <a href={href(['list'])}>모아 둔 대본</a>으로 갑니다.
      </p>
    )
  }
  const src = data.sources[s.source_id]
  const title = src?.title || s.id
  const f = savedFinal(data, s, '저장해 둔 판정 결과', [])
  const cons = consensusOf(s)
  const sure = consensusOf(s, 'sure')
  const nameOf = (n: number) => data.criteria.find((c) => c.n === n)?.name ?? ''
  // 채점자는 기준 7(길이)을 매기지 않았다
  const graded = data.criteria.filter((c) => c.n !== 7)
  const diff = f.r && cons?.flags
    ? graded.filter((c) => !!f.r!.criteria[String(c.n)]?.flagged !== cons.flags!.includes(c.n)).map((c) => c.n)
    : []

  const extra = (
    <section>
      <h3>채점 에이전트와 견줌</h3>
      <dl className="kv">
        <dt>판정기 결정</dt><dd><DecisionBadge data={data} r={f.r} /></dd>
        <dt>판정기 판정</dt><dd><Word data={data} verdict={f.r?.verdict} /></dd>
        <dt>채점 에이전트 다수결</dt><dd><Word data={data} verdict={cons?.verdict} /> <span className="muted">(AI 채점 에이전트 세 명이 시청자 20·40·60대 역할로 판정기와 따로 매긴 것의 다수결)</span></dd>
        <dt>확신한 걸림만</dt><dd><Word data={data} verdict={sure?.verdict} /> <span className="muted">(채점 에이전트가 「애매」로 적지 않은 걸림만 센 것)</span></dd>
        {cons?.flags && <><dt>다르게 본 기준</dt><dd>{diff.length ? diff.map((n) => `${n} ${nameOf(n)}`).join(', ') : '없음'}</dd></>}
        <dt>쓰임</dt><dd>{s.test ? '시험용(판정기를 만들 때 한 번도 보지 않은 대본)' : '개발용(판정기의 오답을 읽고 지시문을 고칠 때 쓴 대본)'}</dd>
      </dl>
    </section>
  )

  return (
    <div className="wrap-narrow-in">
      <p className="crumbs"><a href={href(['list'])}>모아 둔 대본</a></p>
      <h1>{title}</h1>
      <p className="muted">{s.nth} 대본 · {s.type_name}{s.test ? ' · 시험용' : ''}</p>

      {!f.r ? (
        <section className="result">
          <p className="todo">아직 판정 결과가 없습니다.</p>
          <ScriptView scenes={s.scenes} spots={[]} />
        </section>
      ) : (
        <Card title={title} data={data} scenes={s.scenes} final={f} checks={f.checks} sheetKey="detail" extra={extra} />
      )}
    </div>
  )
}
