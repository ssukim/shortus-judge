import { Fragment, useEffect, type ReactNode } from 'react'
import type { CriterionResult, Data, Result, Scene } from './types'
import type { Final } from './runs'
import { BY_LABEL, SHORT_NAME, verdictClass } from './common'
import { firstSentence, placesOf } from './places'
import { SceneText } from './Card'
import { OriginBox } from './Origin'

// 「자세히」 시트 안: 기준 10개 한눈에 → 걸린 기준 카드 → 안 걸린 기준 한 줄씩 → 소리 → 길이 → 출처.

const shortName = (n: string) => SHORT_NAME[n] ?? n

const SCENE_MAX_SEC = 10 // 기준 7: 장면 하나의 상한 (data/labels/rubric.md)

const norm = (t: string) => t.replace(/\s+/g, ' ').trim()
function sentencesOf(text: string): string[] {
  return text.split(/\n+/).flatMap((line) => line.split(/(?<=[.?!])\s+/)).map((s) => s.trim()).filter(Boolean)
}
const QUOTE_RE = /["“「']([^"”」'\n]{6,200})["”」']/g

/** 넣은 글과 견주는 기준(사실 묶음)의 넣은 글 문장: source_quote, 없으면 근거가 인용한 넣은 글 문장 */
function sourceSentence(cr: CriterionResult, sourceText: string, scenes: Scene[]): string | null {
  if (cr.source_quote?.trim()) return cr.source_quote.trim()
  if (!sourceText) return null
  const sents = sentencesOf(sourceText)
  for (const m of cr.reason.matchAll(QUOTE_RE)) {
    const q = norm(m[1])
    if (scenes.some((s) => norm(s.text).includes(q))) continue
    const hit = sents.find((s) => norm(s).includes(q))
    if (hit) return hit
  }
  return null
}

function fullReason(cr: CriterionResult): ReactNode {
  return (
    <>
      <p>{cr.reason}</p>
      <p className="muted">{BY_LABEL[cr.by] ?? cr.by}{cr.votes ? ` · 세 번 물어 ${cr.votes.split('/')[0]}번 걸림` : ''}</p>
    </>
  )
}

function unflaggedText(cr: CriterionResult): string {
  if (cr.not_checked) return '원래 글이 없어 보지 않음'
  if (cr.error) return '모델 답을 받지 못함'
  if (cr.votes && cr.votes[0] !== '0') return `걸리지 않음 · 세 번 물어 ${cr.votes.split('/')[0]}번만 걸림`
  return firstSentence(cr.reason) ?? '걸리지 않음'
}

export type DetailTab = 'criteria' | 'source' | 'sound' | 'revision'
export const TAB_LABEL: Record<DetailTab, string> = { criteria: '기준 10개', source: '넣은 글', sound: '표기·길이', revision: '고친 대본' }

export function Detail({ data, r, final, scenes, sheetKey, extra, tab, crit, onPick, revision }: {
  data: Data; r: Result; final: Final; scenes: Scene[]; sheetKey: string; extra?: ReactNode
  tab: DetailTab; crit: number | null; onPick: (n: number) => void; revision?: ReactNode
}) {
  const id = (n: number) => `${sheetKey}-c${n}`
  const vcls = verdictClass(data, r.verdict)
  const groups = [...new Set(data.criteria.map((c) => c.group ?? ''))]
  const rule = data.verdict_rule
  const heavy = [...rule.fail, ...rule.hold]
  const flagged = [...data.criteria].filter((c) => r.criteria[String(c.n)]?.flagged)
    .sort((a, b) => (heavy.includes(a.n) ? heavy.indexOf(a.n) : 99 + a.n) - (heavy.includes(b.n) ? heavy.indexOf(b.n) : 99 + b.n))
  const rest = data.criteria.filter((c) => !r.criteria[String(c.n)]?.flagged)
  const sourceGroup = (n: number) => {
    const g = data.criteria.find((c) => c.n === n)?.group
    return g ? g === '사실' : n <= 4
  }
  const c5 = data.criteria.find((c) => c.name === '잘못 읽을 표기')
  const c5r = c5 ? r.criteria[String(c5.n)] : undefined
  const hits = c5r?.hits ?? []
  const c7 = data.criteria.find((c) => c.name === '길이')
  const len = c7 ? r.criteria[String(c7.n)] : undefined
  const sum = Math.round(scenes.reduce((a, s) => a + (s.sec ?? 0), 0) * 10) / 10
  const srcMeta = final.sourceId ? data.sources[final.sourceId] : undefined
  const srcQuotes = flagged.filter((c) => sourceGroup(c.n)).map((c) => sourceSentence(r.criteria[String(c.n)], final.sourceText, scenes)).filter((x): x is string => !!x)

  // 기준으로 열렸으면 그 자리로 옮기고 잠깐 강조
  useEffect(() => {
    if (tab !== 'criteria' || crit == null) return
    const el = document.getElementById(id(crit))
    if (!el) return
    el.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
    el.classList.remove('flash')
    void el.offsetWidth
    el.classList.add('flash')
    const t = setTimeout(() => el.classList.remove('flash'), 1600)
    return () => clearTimeout(t)
  }, [tab, crit])

  if (tab === 'revision') return <div className="detail">{revision}</div>

  if (tab === 'source') {
    return (
      <div className="detail">
        <section>
          <h3>넣은 글</h3>
          {srcMeta?.origin?.title && (
            <p className="muted">
              {srcMeta.origin.publisher ?? ''} 「{srcMeta.origin.title}」 {srcMeta.origin.published ?? ''}
              {srcMeta.origin.url && <> · <a href={srcMeta.origin.url} target="_blank" rel="noreferrer">원문</a></>}
            </p>
          )}
          {final.sourceText
            ? <div className="source-text" tabIndex={0} role="region" aria-label="넣은 글 전문"><SourceMarked text={final.sourceText} quotes={srcQuotes} /></div>
            : <p className="muted">넣은 글 없이 판정했어요.</p>}
          {srcQuotes.length > 0 && <p className="muted">밑줄은 걸린 기준이 견준 문장이에요.</p>}
        </section>
        {extra}
        <section>
          <h3>출처</h3>
          {final.origin && <OriginBox o={final.origin} />}
          <dl className="kv">
            {final.meta && <><dt>판정</dt><dd>{final.meta}</dd></>}
            {r.model && <><dt>판정기</dt><dd>5판 · 모델 {r.model}</dd></>}
            {final.costLines.map((l, i) => <Fragment key={i}><dt>{i === 0 ? '시간과 비용' : ''}</dt><dd>{l}</dd></Fragment>)}
          </dl>
          {final.notes.map((n, i) => <p key={i} className="why">{n}</p>)}
          {final.savedDiff && (
            <details className="fold">
              <summary>저장해 둔 판정과 다름</summary>
              <p>{final.savedDiff}</p>
            </details>
          )}
        </section>
      </div>
    )
  }

  if (tab === 'sound') {
    return (
      <div className="detail">
        <section>
          <h3>목소리가 잘못 읽을 표기</h3>
          {hits.length === 0 ? <p className="muted">목소리가 잘못 읽을 표기를 찾지 못했어요.</p> : (
            <ul className="chips">
              {hits.map((h, i) => (
                <li key={i} className="chip-s">
                  {h.scene}번 장면 <b>{h.text}</b>
                  {h.heard != null ? <> → 들어 보니 ‘{h.heard}’로 들림</> : <> → 고친 대본 {h.fix ? <b>{h.fix}</b> : '자동으로 못 고침'}</>}
                </li>
              ))}
            </ul>
          )}
          {(c5r?.vague?.length ?? 0) > 0 && (
            <p className="why">애매해서 걸지 않음 · {c5r!.vague!.map((v) => `${v.scene}번 장면 「${v.text}」`).join(', ')}</p>
          )}
          {c5r?.listen && (
            <p className="why">
              듣기 검사 · {c5r.listen.skipped ? `건너뜀: ${c5r.listen.skipped}` : `숫자가 든 장면 ${c5r.listen.heard}개를 쇼더스 목소리로 들어 봄, 다르게 들린 장면 ${c5r.listen.different}개`}
            </p>
          )}
          <p className="muted">표기는 코드가 규칙으로 찾고, 고친 대본은 그 표기와 읽을 때마다 틀리게 읽는 숫자를 한글로 풀어 씁니다. 문장 내용은 바꾸지 않습니다.</p>
        </section>
        {len?.scene_sec && len.scene_sec.length > 0 && (
          <section>
            <h3>길이</h3>
            <p className="muted">막대 한 칸이 장면 하나입니다(칸 안 숫자는 장면 번호, 폭은 그 장면의 초).</p>
            <div className="secbar" role="img"
              aria-label={`장면별 초: ${len.scene_sec.map((x, i) => `${i + 1}번 ${x.toFixed(1)}초`).join(', ')}`}>
              {len.scene_sec.map((x, i) => (
                <span key={i} className={x > SCENE_MAX_SEC ? 'seg seg-over' : 'seg'} style={{ flexGrow: x }}>{i + 1}</span>
              ))}
            </div>
            <p className="why">
              전체 {Math.round((len.total_sec ?? 0) * 10) / 10}초
              {len.sec_factor && sum ? ` (쇼더스 예상 ${sum}초 × 실제 목소리 비율 ${len.sec_factor})` : ''}
              {len.scene_sec.some((x) => x > SCENE_MAX_SEC) ? ` · ${SCENE_MAX_SEC}초 넘는 장면은 색으로 표시` : ''}
            </p>
            {(r.notices ?? []).map((t, i) => <p key={i} className="why">{t}</p>)}
          </section>
        )}
      </div>
    )
  }

  return (
    <div className="detail">
      <section aria-label={`기준 ${data.criteria.length}개 한눈에`}>
        <div className="grid-groups">
          {groups.map((g) => (
            <div key={g} className="grid-group">
              {g && <span className="grid-label">{g}</span>}
              <div className="grid">
                {data.criteria.filter((c) => (c.group ?? '') === g).map((c) => {
                  const cr = r.criteria[String(c.n)]
                  const st = !cr ? 'none' : cr.not_checked ? 'skip' : cr.error ? 'error' : cr.flagged ? 'hit' : 'ok'
                  const word = { none: '없음', skip: '안 봄', error: '답 없음', hit: '걸림', ok: '안 걸림' }[st]
                  return (
                    <button key={c.n} type="button" className={`cell cell-${st} ${st === 'hit' ? `cell-${vcls}` : ''}`}
                      aria-label={`${c.n} ${c.name}: ${word}`} onClick={() => onPick(c.n)}>
                      <span className="cell-name">{shortName(c.name)}</span>
                      <span className="cell-state" aria-hidden="true">{st === 'hit' ? '걸림' : st === 'ok' ? '✓' : word}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <p className="why">판정 · {r.summary}</p>
        {r.diagnostics.length > 0 && (
          <p className="muted">판정에 넣지 않은 진단: {r.diagnostics.map((n) => `${n} ${data.criteria.find((c) => c.n === n)?.name ?? ''}`).join(', ')}</p>
        )}
      </section>

      {flagged.length > 0 && (
        <section>
          <h3>걸린 기준</h3>
          {flagged.map((c) => {
            const cr = r.criteria[String(c.n)]
            const own = placesOf(data, { criteria: { [c.n]: cr } }, scenes)
            const sc = [...new Set([...cr.scenes, ...own.spots.map((s) => s.scene)])].sort((a, b) => a - b)
              .map((n) => scenes.find((s) => s.n === n)).filter((s): s is Scene => !!s)
            const src = sourceGroup(c.n) ? sourceSentence(cr, final.sourceText, scenes) : null
            const short = own.problems[0]?.text
            const fixes = (cr.hits ?? []).filter((h) => h.fix)
            return (
              <article key={c.n} id={id(c.n)} tabIndex={-1} className="hitcard">
                <h4><span className={`dot v-${vcls}`} aria-hidden="true">●</span> {c.name}</h4>
                {sc.length === 0 && <p className="line"><span className="lbl">대본</span> 대본 전체</p>}
                {sc.map((s) => (
                  <p key={s.n} className="line">
                    <span className="lbl">대본 {s.n}번</span>
                    <SceneText text={s.text} spots={own.spots.filter((x) => x.scene === s.n)} numbers={false} />
                  </p>
                ))}
                {src && <p className="line"><span className="lbl">넣은 글</span>{src}</p>}
                {short && <p className="why">→ {short}</p>}
                {fixes.length > 0 && <p className="why">고친 대본: {fixes.map((h) => `${h.text} → ${h.fix}`).join(', ')}</p>}
                <details className="fold">
                  <summary>전문 보기</summary>
                  <div className="full">
                    {fullReason(cr)}
                  </div>
                </details>
              </article>
            )
          })}
        </section>
      )}

      {rest.length > 0 && (
        <section>
          <h3>안 걸린 기준</h3>
          <ul className="oklist">
            {rest.map((c) => {
              const cr = r.criteria[String(c.n)]
              return (
                <li key={c.n} id={id(c.n)} tabIndex={-1}>
                  <span aria-hidden="true">{cr?.not_checked ? '–' : cr?.error ? '?' : '✓'}</span> {c.name} · {cr ? unflaggedText(cr) : '결과 없음'}
                </li>
              )
            })}
          </ul>
        </section>
      )}

    </div>
  )
}

/** 넣은 글 전문에서 견준 문장에 밑줄 */
function SourceMarked({ text, quotes }: { text: string; quotes: string[] }) {
  const qs = [...new Set(quotes.map((q) => q.trim()).filter((q) => q.length >= 4 && text.includes(q)))]
  if (!qs.length) return <>{text}</>
  const esc = qs.map((q) => q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const parts = text.split(new RegExp(`(${esc.join('|')})`))
  return <>{parts.map((p, i) => (qs.includes(p) ? <u key={i} className="hit-u">{p}</u> : p))}</>
}
