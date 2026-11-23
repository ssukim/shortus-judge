import { useState } from 'react'
import type { Origin } from './runs'

// 대본이 쇼더스에서 왔다는 근거: 대본 id(줄이지 않음), 받은 때, 쇼더스 원본. 「자세히」 시트 맨 아래에 둔다.

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false)
  return (
    <button type="button" className="copy" aria-label={`${text} 복사`}
      onClick={() => navigator.clipboard?.writeText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1500) })}>
      <code>{text}</code> <span className="copy-word">{done ? '복사함' : '복사'}</span>
    </button>
  )
}

const day = (iso?: string | null) => (iso ? iso.slice(0, 10) : '')
const when = (iso?: string | null) => (iso ? iso.replace('T', ' ').replace(/(\d\d:\d\d):\d\d.*$/, '$1') : '')

interface RawSection { role?: string; text?: string; estimated_sec?: number }
function sectionsOf(raw: unknown): RawSection[] {
  const o = raw as { sections?: unknown } | null
  return o && Array.isArray(o.sections) ? (o.sections as RawSection[]) : []
}

export function OriginBox({ o }: { o: Origin }) {
  const raw = o.raw as { status?: string } | null | undefined
  const secs = sectionsOf(o.raw)
  return (
    <div className="origin">
      <dl className="kv">
        <dt>대본</dt>
        <dd>{day(o.receivedAt)}에 쇼더스에서 받아 둔 대본</dd>
        <dt>쇼더스 대본 id</dt>
        <dd><Copy text={o.scriptId} /></dd>
        {o.textSourceId && <><dt>쇼더스 글 id</dt><dd><Copy text={o.textSourceId} /></dd></>}
        {o.receivedAt && <><dt>받은 때</dt><dd>{when(o.receivedAt)}</dd></>}
      </dl>
      {o.raw != null && (
        <details className="fold">
          <summary>쇼더스 원본 보기</summary>
          <div className="table-scroll" tabIndex={0} role="region" aria-label="쇼더스 원본 장면 표">
            <table className="raw-table">
              <caption>대본 id {o.scriptId}{raw?.status ? ` · 상태 ${raw.status}` : ''}</caption>
              <thead><tr><th scope="col">장면</th><th scope="col">역할</th><th scope="col">문장</th><th scope="col">예상 초</th></tr></thead>
              <tbody>
                {secs.map((s, i) => (
                  <tr key={i}><td data-label="장면">{i + 1}</td><td data-label="역할">{s.role ?? ''}</td><td data-label="문장">{s.text ?? ''}</td><td data-label="예상 초">{s.estimated_sec ?? ''}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="fold">
            <summary>전체 JSON</summary>
            <p className="hint">쇼더스에서 받아 둔 대본을 고치지 않고 보여 줍니다.</p>
            <pre tabIndex={0}>{JSON.stringify(o.raw, null, 2)}</pre>
          </details>
        </details>
      )}
    </div>
  )
}
