// 고친 대본 (결과의 revision, revision_2 칸. judge/view.py의 model_revision_view, revision_view).
//   탈락·보류 대본: 걸린 곳을 판정봇이 고치고 처음부터 다시 판정한 것 (judge/revise.py, D35). 두 번까지
//   통과한 대본: 목소리가 잘못 읽을 표기와 숫자만 코드가 바로 읽히게 바꾼 것 (method reading_only)
// 다시 판정한 결과는 원래 대본에 딸린 칸으로 다룬다.

import type { CriterionResult, Data } from './types'

// reading: 목소리가 읽을 장면 전체 글. 고친 글자(after)의 표기와 숫자를 다시 판정에서 코드가 소리 나는 대로 바꾼 것
export interface RevScene { n: number; before: string; after: string; changed: boolean; why: string; reading?: string }
export interface Revision {
  scenes: RevScene[]
  flagged: number[]
  verdict?: string
  criteria?: Record<string, CriterionResult>
  new_numbers: { scene: number; number: string }[] // 고친 장면에 새로 들어간, 넣은 글에 없는 숫자
  error?: string
}

type Raw = Record<string, unknown>
const str = (x: unknown) => (typeof x === 'string' ? x : '')

export function revisionOf(raw: unknown): Revision | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Raw
  const error = str(o.error) || undefined
  const list = Array.isArray(o.scenes) ? (o.scenes as Raw[]) : []
  const scenes = list.map((s, i) => {
    const before = str(s.before)
    const after = str(s.after) || before
    const reading = str(s.reading) || undefined
    return { n: typeof s.n === 'number' ? s.n : i + 1, before, after,
      changed: typeof s.changed === 'boolean' ? s.changed : before !== after || !!reading, why: str(s.why), reading }
  })
  const nn = Array.isArray(o.new_numbers) ? (o.new_numbers as { scene: number; number: string }[]) : []
  const flagged = Array.isArray(o.flagged) ? (o.flagged as number[]) : []
  return { scenes, flagged, verdict: str(o.verdict) || undefined,
    criteria: (o.criteria as Revision['criteria']) ?? undefined, new_numbers: nn, error }
}

/** 짧은 이유가 명사형으로 끝나면 해요체로 바꾸는 정해 둔 꼴. 맞는 꼴이 없으면 null */
const ENDINGS: [string, string][] = [
  ['빠짐', '빠졌어요'], ['바꿈', '바꿨어요'], ['바뀜', '바뀌었어요'], ['없음', '없어요'], ['있음', '있어요'],
  ['벗어남', '벗어났어요'], ['늘어남', '늘어났어요'], ['줄어듦', '줄어들었어요'], ['남음', '남았어요'], ['달라짐', '달라졌어요'],
  ['길어짐', '길어졌어요'], ['짧아짐', '짧아졌어요'], ['더함', '더했어요'], ['넣음', '넣었어요'], ['붙임', '붙였어요'],
  ['됨', '됐어요'], ['함', '했어요'], ['모름', '몰라요'], ['않음', '않아요'], ['다름', '달라요'],
]
export function toHaeyo(short: string): string | null {
  const t = short.trim().replace(/[.。]+$/, '')
  if (/(요|다)$/.test(t)) return t.endsWith('다') ? null : `${t}.` // 이미 해요체면 그대로, 합니다·한다체는 쓰지 않음
  const e = ENDINGS.find(([from]) => t.endsWith(from))
  return e ? `${t.slice(0, -e[0].length)}${e[1]}.` : null
}

/** 기준 이름으로 쓰는 해요체 한 문장 (정해 둔 꼴이 맞지 않을 때) */
const BY_NAME: Record<string, string> = {
  '없는 내용, 바뀐 뜻': '넣은 글에 없는 내용이 있어요.', '숫자·날짜·이름': '넣은 글과 다른 숫자·날짜·이름이 있어요.',
  '세게 바꿔 말함': '넣은 글보다 세게 말한 곳이 있어요.', '빠진 내용': '빠진 내용이 있어요.',
  '잘못 읽을 표기': '목소리가 잘못 읽을 표기가 있어요.', '말하듯 쓴 문장': '말하듯 쓰지 않은 문장이 있어요.',
  '첫 장면': '첫 장면만으로는 무슨 얘기인지 알기 어려워요.', '이어짐, 되풀이': '장면이 잘 안 이어지거나 같은 말을 되풀이해요.',
  '끝맺음': '마지막 장면이 이야기를 끝맺지 않아요.',
}

/** 고친 대본도 통과가 아닐 때 까닭: 다시 판정한 결과에서 가장 무거운 걸린 기준 하나로 해요체 한 문장 */
export function revWhy(rev: Revision, data: Data): string {
  const crit = (rev.criteria ?? {}) as Record<string, CriterionResult & { detail?: { total_sec?: number } }>
  const rule = data.verdict_rule
  const heavy = [...rule.fail, ...rule.hold]
  const ns = (rev.flagged.length ? rev.flagged : Object.keys(crit).filter((k) => crit[k]?.flagged).map(Number))
    .sort((a, b) => (heavy.includes(a) ? heavy.indexOf(a) : 99 + a) - (heavy.includes(b) ? heavy.indexOf(b) : 99 + b))
  const n = ns[0]
  if (n == null) return ''
  const c = crit[String(n)]
  const name = data.criteria.find((x) => x.n === n)?.name ?? ''
  const total = c?.detail?.total_sec ?? c?.total_sec
  if (name === '길이' && total != null) {
    const t = Math.round(total)
    return ' ' + (t > 45 ? `전체가 ${t}초로 길어졌어요.` : t < 30 ? `전체가 ${t}초로 짧아졌어요.` : '길이가 기준을 벗어났어요.')
  }
  const said = c?.short ? toHaeyo(c.short) : null
  return ' ' + (said ?? BY_NAME[name] ?? '걸린 기준이 있어요.')
}

/** 화면에 보일 고친 대본: 결정이 고른 판, 고른 판이 원래 대본이거나 없으면 마지막으로 고친 판.
 *  두 번째 판은 첫 번째 판을 이어 고친 것이라, 원래 문장(before)은 첫 번째 판에서 가져와 원래 대본과 견준다. */
/** shownRevision이 고르는 판 번호 (1 또는 2) */
export function shownRound(r: { revision?: unknown; revision_2?: unknown; decision?: { round: number | null } }): 1 | 2 {
  const r1 = revisionOf(r.revision)
  const r2 = revisionOf(r.revision_2)
  const ok = (x: Revision | null) => !!x && !x.error && x.scenes.length > 0
  const round = r.decision?.round
  const pick = round === 1 ? 1 : round === 2 || (ok(r2) && round !== 1) ? 2 : 1
  return pick === 1 || !ok(r2) || !ok(r1) ? 1 : 2
}

export function shownRevision(r: { revision?: unknown; revision_2?: unknown; decision?: { round: number | null } }): Revision | null {
  const r1 = revisionOf(r.revision)
  const r2 = revisionOf(r.revision_2)
  const ok = (x: Revision | null) => !!x && !x.error && x.scenes.length > 0
  const round = r.decision?.round
  const pick = round === 1 ? 1 : round === 2 || (ok(r2) && round !== 1) ? 2 : 1
  if (pick === 1 || !ok(r2) || !ok(r1)) return r1
  const scenes = r2!.scenes.map((s, i) => {
    const first = r1!.scenes[i]
    const before = first?.before ?? s.before
    const reading = s.reading
    return { n: s.n, before, after: s.after, changed: before !== s.after || !!reading,
      why: s.why || first?.why || '', reading }
  })
  const seen = new Set<string>()
  const nn = [...r1!.new_numbers, ...r2!.new_numbers].filter((x) => { const k = `${x.scene}-${x.number}`; if (seen.has(k)) return false; seen.add(k); return true })
  return { ...r2!, scenes, new_numbers: nn }
}

const hasBatchim = (w: string) => {
  const t = w.replace(/[)」』\s]+$/, '')
  const c = t.charCodeAt(t.length - 1)
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0
}
const iga = (w: string) => `${w}${hasBatchim(w) ? '이' : '가'}`
const TIMES = ['', '한 번', '두 번', '세 번']
const ROUND_WORD = ['원래 대본', '첫 번째 고친 대본', '두 번째 고친 대본']

/** 판정봇의 끝 문장: 어느 대본으로 만드는지. 결정이 없으면 null */
export function decisionSay(data: Data, r: { verdict: string; flagged: number[]; revision?: unknown; revision_2?: unknown;
  decision?: { action: string; round: number | null } }, shortName: (n: number) => string): string | null {
  const d = r.decision
  if (!d) return null
  const [pass] = data.verdicts
  const revs = [revisionOf(r.revision), revisionOf(r.revision_2)].filter((x): x is Revision => !!x && !!x.verdict || !!x?.error)
  const judged = revs.filter((x) => !x.error && !!x.verdict)
  const tried = TIMES[judged.length] ?? `${judged.length}번`
  const names = (ns: number[]) => ns.map(shortName).join('·')
  const facts = (ns: number[]) => ns.filter((n) => data.verdict_rule.fail.includes(n))
  if (d.action === 'render_original' && r.verdict === pass) return null
  // 통과한 대본의 표기만 고친 것
  if (d.action === 'render_revised' && r.verdict === pass)
    return '목소리가 잘못 읽을 표기와 숫자만 바로 읽히게 바꾼 고친 대본으로 만들어요. 문장 내용은 그대로예요.'
  if (d.action === 'do_not_render') {
    if (!data.verdicts.includes(r.verdict)) return '몇 가지를 판정하지 못해 만들지 않아요.'
    if (!revs.length) return `넣은 글과 다른 내용${facts(r.flagged).length ? `(${names(facts(r.flagged))})` : ''}이 있어 만들지 않아요.`
    if (!judged.length) return `고친 대본을 만들지 못했고 원래 대본에 사실 틀림(${names(facts(r.flagged))})이 있어 만들지 않아요.`
    const last = judged[judged.length - 1]
    return `${tried} 고쳐도 사실 틀림${facts(last.flagged).length ? `(${names(facts(last.flagged))})` : ''}이 남아 만들지 않아요.`
  }
  const k = d.round ?? 0
  const chosen = k === 0 ? { verdict: r.verdict, flagged: r.flagged } : judged[k - 1]
  if (d.action === 'render_revised' && chosen && chosen.verdict === pass) return `${TIMES[k]} 고친 대본이 통과해 그 대본으로 만들어요.`
  // 보류는 사람이 본다 (고친 대본도 보류면 저절로 만들지 않음)
  const left = chosen ? names(chosen.flagged.filter((n) => !data.verdict_rule.diag?.includes(n))) : ''
  if (!judged.length) return `${left ? iga(left) + ' 걸려 ' : ''}사람이 보고 정해요.`
  if (k === 0) return `${tried} 고쳐 봤지만 나아지지 않아, 원래 대본을 사람이 보고 정해요.`
  return `${tried} 고쳐도 ${left ? iga(left) + ' ' : ''}남아, 걸린 곳이 가장 적은 ${ROUND_WORD[k]}을 사람이 보고 정해요.`
}

/** 읽는 법만 바꾼 표기: 원래 판정의 기준 5 고칠 말 가운데 그 장면 reading에 들어간 것 */
export function readingFixes(scene: RevScene, hits: { scene: number; text: string; fix: string | null }[]): { text: string; fix: string }[] {
  if (!scene.reading) return []
  return hits.filter((h): h is { scene: number; text: string; fix: string } =>
    h.scene === scene.n && !!h.fix && scene.reading!.includes(h.fix) && scene.after.includes(h.text))
    .map((h) => ({ text: h.text, fix: h.fix }))
}
