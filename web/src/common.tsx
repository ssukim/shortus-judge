import type { Data, GoldKey, Label, Script } from './types'

// ---- 주소: #/경로?키=값 꼴. 새로고침해도 같은 화면이 열린다. ----

export interface Route {
  path: string[]
  query: URLSearchParams
}

export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  const [p, q = ''] = raw.split('?')
  return { path: p.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q) }
}

export function href(path: string[], query: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) if (v) q.set(k, v)
  const qs = q.toString()
  return '#/' + path.map(encodeURIComponent).join('/') + (qs ? '?' + qs : '')
}

/** 채점자 정답: all = 세 명의 다수결(기본), sure = 「애매」로 적지 않은 걸림만 센 확신 정답 */
export const consensusOf = (s: Script, gold: GoldKey = 'all'): Label | undefined => s.consensus?.[gold]

// ---- 이름 ----

export const BY_LABEL: Record<string, string> = {
  code: '코드가 봄',
  model: '모델이 봄',
  'code+listen': '코드가 보고 소리로 들어 봄',
}

/** 기준의 짧은 이름 (보고서 격자 칸, 모아 둔 대본 목록) */
export const SHORT_NAME: Record<string, string> = {
  '없는 내용, 바뀐 뜻': '없는 내용', '숫자·날짜·이름': '숫자·이름', '세게 바꿔 말함': '세게 말함', '빠진 내용': '빠진 내용',
  '잘못 읽을 표기': '표기', '말하듯 쓴 문장': '말투', '길이': '길이', '첫 장면': '첫 장면',
  '이어짐, 되풀이': '이어짐', '끝맺음': '끝맺음',
}

// ---- 판정 표시 ----
// 판정기가 내는 낱말(통과·보류·탈락)은 「얼마나 믿을 수 있나」처럼 판정기 숫자를 설명하는 곳에서 그대로 보인다.
// 결과 카드·목록·대본 화면은 결정(decision) 낱말을 쓴다: decisionWord, DecisionBadge.

/** 받침에 따라 「으로/로」 (ㄹ받침과 받침 없음은 「로」). 괄호로 끝나면 괄호 앞 글자로 본다 */
export function ro(word: string): string {
  const w = word.replace(/[)」』\s]+$/, '')
  const c = w.charCodeAt(w.length - 1)
  if (!(c >= 0xac00 && c <= 0xd7a3)) return '로'
  const jong = (c - 0xac00) % 28
  return jong === 0 || jong === 8 ? '로' : '으로'
}

export function verdictWord(data: Data, verdict: string): string {
  const [pass, hold, fail] = data.verdicts
  if (verdict === pass) return '통과'
  if (verdict === hold) return '보류'
  if (verdict === fail) return '탈락'
  return '판정 못 함'
}

export function verdictClass(data: Data, verdict: string): string {
  return ['pass', 'hold', 'fail'][data.verdicts.indexOf(verdict)] ?? 'none'
}

export function VerdictBadge({ data, verdict }: { data: Data; verdict?: string }) {
  if (!verdict) return <span className="muted">없음</span>
  return <span className={`vtext v-${verdictClass(data, verdict)}`}>{verdictWord(data, verdict)}</span>
}

// ---- 결정 표시 ----
// 통과 → 원래 대본 그대로(표기를 고쳤으면 고친 대본으로), 보류 → 사람이 보고 정함, 탈락 → 만들지 않음 (judge/view.py decision_of)
export type DecisionKind = 'original' | 'revised' | 'review' | 'none'
type WithDecision = { verdict: string; decision?: { action: string } }

export function decisionKind(r?: WithDecision): DecisionKind | null {
  const a = r?.decision?.action
  return a === 'render_original' ? 'original' : a === 'render_revised' ? 'revised' : a === 'review' ? 'review'
    : a === 'do_not_render' ? 'none' : null
}
export const DECISION_WORD: Record<DecisionKind, string> = {
  original: '그대로 만들어도 됨', revised: '고친 대본으로 만듦', review: '사람이 보고 정함', none: '만들지 않음 · 사실 틀림',
}
const DECISION_CLASS: Record<DecisionKind, string> = { original: 'pass', revised: 'pass', review: 'hold', none: 'fail' }

export function decisionWord(data: Data, r: WithDecision): string {
  const k = decisionKind(r)
  return k ? DECISION_WORD[k] : verdictWord(data, r.verdict)
}
export function decisionClass(data: Data, r: WithDecision): string {
  const k = decisionKind(r)
  return k ? DECISION_CLASS[k] : verdictClass(data, r.verdict)
}

export function DecisionBadge({ data, r }: { data: Data; r?: WithDecision }) {
  if (!r) return <span className="muted">없음</span>
  return (
    <span className="dbadge">
      <span className={`vtext v-${decisionClass(data, r)}`}>{decisionWord(data, r)}</span>
    </span>
  )
}

/** 채점자 정답(원래 대본을 본 것)을 결과 카드와 같은 쪽 낱말로: 그대로 / 고칠 곳 있음 / 사실 틀림 */
export function agentWord(data: Data, verdict: string): string {
  const [pass, hold, fail] = data.verdicts
  return verdict === pass ? '그대로' : verdict === hold ? '고칠 곳 있음' : verdict === fail ? '사실 틀림' : verdictWord(data, verdict)
}

/** 지금 주소의 쿼리 일부만 바꾼다. 빈 값은 지운다. */
export function setQuery(updates: Record<string, string | undefined>) {
  const { path, query } = parseHash(window.location.hash)
  for (const [k, val] of Object.entries(updates)) {
    if (val) query.set(k, val)
    else query.delete(k)
  }
  const qs = query.toString()
  window.location.hash = '/' + path.map(encodeURIComponent).join('/') + (qs ? '?' + qs : '')
}

/** 대본 이름: 넣은 글 제목을 크게, 몇 번째 대본을 작게. 목록·확인 화면이 같이 쓴다. */
export function ScriptName({ data, s, link }: { data: Data; s: Script; link?: boolean }) {
  const title = data.sources[s.source_id]?.title || s.id
  return (
    <span className="sname">
      {link ? <a className="sname-title" href={href(['script', s.id])}>{title}</a> : <span className="sname-title">{title}</span>}
      <span className="sname-sub">{s.nth} 대본{s.test ? ' · 시험용' : ''}</span>
    </span>
  )
}
