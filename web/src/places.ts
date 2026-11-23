// 결과 카드의 대본 위에 놓을 것: 바꿀 말이 있는 곳(지우는 줄 + 바꿀 말)과 번호 붙은 곳(밑줄 + 번호 + 짧은 이유).
// 모두 판정기 결과(judge/view.py의 criterion_view: short, marks, source_quote, hits)에서 꺼낸다.

import type { CriterionResult, Data, Result, Scene } from './types'
import { ro } from './common'   // 고칠 말 뒤 「로/으로」 (십오 킬로그램으로, 오 점 오 리터로)

/** 대본 안에서 고칠 자리 하나 */
export interface Spot {
  scene: number
  quote: string // 장면 문장에 그대로 있는 글. 빈 글이면 장면 끝에 번호만
  fix: string | null // 바꿀 말. 있으면 지우는 줄 + 바꿀 말, 없으면 밑줄 + 번호
  no: number | null // 번호 (말풍선의 번호와 같음)
}

/** 번호 하나 = 걸린 기준 하나. 대본 아래 한 줄 */
export interface Problem {
  no: number
  n: number // 기준 번호 (화면에는 안 보임)
  text: string // 짧은 이유 (40자 안)
  whole: boolean // 장면을 짚지 못함 → 대본 맨 아래에
}

/** 판정봇이 고칠 곳마다 하는 말 한 문장. 어긋난 두 쪽(넣은 글과 대본, 표기와 들린 소리)을 나란히 */
export interface Say { n: number; no: number | null; text: string }

export interface Places {
  spots: Spot[]
  problems: Problem[]
  says: Say[]
  count: number // 「N곳」: 번호 수 (걸린 기준마다 하나)
}

/** 말풍선에 넣는 인용은 짧을 때만 (긴 문장을 통째로 옮기지 않음) */
const QUOTE_MAX = 70
const VERB: Record<string, string> = {
  '없는 내용, 바뀐 뜻': '라고 해요', '숫자·날짜·이름': '라고 해요', '세게 바꿔 말함': '라고 더 세게 말해요',
}

const where = (ns: number[]) => `${[...new Set(ns)].sort((a, b) => a - b).join('·')}번 장면`

function sayOf(name: string, cr: CriterionResult, short: string, marks: { scene: number; quote: string; fix: string | null }[],
  whole: boolean, ctx: { sourceText?: string }, scenes: Scene[]): string {
  const end = (t: string) => (/[.?!]$/.test(t) ? t : t + '.')
  if (cr.hits?.length) {
    const out = cr.hits.slice(0, 2).map((h) => {
      if (h.heard != null) return `대본 ${h.scene}번 장면을 들어 보니 목소리가 「${h.heard}」로 읽어 숫자가 다르게 들렸어요.`
      const fix = h.fix ? ` 고친 대본에서는 「${h.fix}」${ro(h.fix)} 바꿨어요.` : ' 자동으로 고치지 못한 표기예요.'
      return `대본 ${h.scene}번 장면의 「${h.text}」는 목소리가 잘못 읽을 수 있어요.${fix}`
    })
    if (cr.hits.length > 2) out.push(`그 밖에 표기 ${cr.hits.length - 2}곳이 더 있어요.`)
    return out.join(' ')
  }
  // 넣은 글과 견주는 기준: 넣은 글 문장과 대본 구절을 한 문장에
  const src = cr.source_quote?.trim() || (ctx.sourceText
    ? quotesIn(cr.reason).find((q) => !scenes.some((s) => s.text.includes(q)) && ctx.sourceText!.replace(/\s+/g, ' ').includes(q.replace(/\s+/g, ' ')))
    : undefined)
  const trim = (q: string) => q.replace(/[.。,]+$/, '')
  if (src && trim(src).length <= QUOTE_MAX && name === '빠진 내용') return `넣은 글의 「${trim(src)}」가 대본에 없어요.`
  if (VERB[name]) {
    // 표시(대본 구절)마다 견준 넣은 글 문장을 따로 짝짓는다. 한 기준이 여러 장면을 걸어도 장면과 넣은 글 문장이 엇갈리지 않게
    const pairs = pairsOf(cr, marks, ctx, scenes).filter((x) => trim(x.src).length <= QUOTE_MAX && trim(x.m.quote).length <= QUOTE_MAX)
    if (pairs.length) {
      const out = pairs.slice(0, 2).map(({ m, src: s0 }) => {
        const q = trim(m.quote), s = trim(s0)
        // 인용 뒤 「라고」: 받침 있는 글자로 끝나면 「이라고」
        const verb = iga(q) === '이' ? '이' + VERB[name] : VERB[name]
        return `넣은 글은 「${s}」인데, 대본 ${m.scene}번 장면은 「${q}」${verb}.`
      })
      const rest = new Set(marks.map((x) => x.scene).filter((sc) => !pairs.slice(0, 2).some((p) => p.m.scene === sc))).size
      if (rest) out.push(`그 밖에 ${rest}곳이 더 있어요.`)
      return out.join(' ')
    }
  }
  if (whole) return `대본 전체: ${end(short)}`
  return `대본 ${where(marks.map((x) => x.scene).concat(cr.scenes))}: ${end(short)}`
}

/** 대본 구절 하나마다 견준 넣은 글 문장.
 * source_quote는 기준 하나에 문장 하나라, 여러 장면을 걸면 어느 장면의 것인지 모른다. 그래서
 * ① 근거 글을 「N번 장면」마다 나눠, 그 장면 몫에서 인용한 넣은 글 문장을 그 장면 표시에 붙이고
 *    (그 인용이 source_quote의 일부면 source_quote 전체를 쓴다),
 * ② 근거 글로 못 정하면 표시가 하나일 때만 source_quote를 붙이거나, 여럿이면 source_quote와 글자가 가장 많이 겹치는 표시에 붙인다.
 * 짝을 못 찾은 표시는 빼고 돌려준다(엉뚱한 짝을 내지 않음). */
function pairsOf(cr: CriterionResult, marks: { scene: number; quote: string; fix: string | null }[],
  ctx: { sourceText?: string }, scenes: Scene[]): { m: { scene: number; quote: string }; src: string }[] {
  const sq = norm(cr.source_quote ?? '')
  const ms = marks.filter((x, i) => x.quote.length >= 2 && marks.findIndex((y) => y.scene === x.scene) === i) // 장면마다 첫 구절 하나
  if (!ms.length) return []
  const source = norm(ctx.sourceText ?? '')
  const inScene = (q: string) => scenes.some((s) => norm(s.text).includes(q))
  const reason = cr.reason
  // 근거 글을 「N번 장면」이 나오는 자리마다 자른다
  const cuts = [...reason.matchAll(/(\d+)번 장면/g)].map((x) => ({ scene: Number(x[1]), at: x.index ?? 0 }))
  const segOf = (sc: number) => cuts.flatMap((c, i) => (c.scene === sc ? [reason.slice(c.at, cuts[i + 1]?.at ?? reason.length)] : [])).join(' ')
  const byReason = (sc: number): string | undefined => {
    for (const q0 of quotesIn(segOf(sc))) {
      const q = norm(q0)
      if (q.length < 4 || inScene(q)) continue
      if (sq && (sq.includes(q) || q.includes(sq))) return cr.source_quote!.trim()
      if (source && source.includes(q)) return q0
    }
    return undefined
  }
  const out = ms.flatMap((m) => {
    const src = byReason(m.scene)
    return src ? [{ m, src }] : []
  })
  if (out.length || !sq) return out
  if (ms.length === 1) return [{ m: ms[0], src: cr.source_quote!.trim() }]
  const best = ms.map((m) => ({ m, k: overlap(m.quote, sq) })).sort((a, b) => b.k - a.k)[0]
  return best.k > 0 ? [{ m: best.m, src: cr.source_quote!.trim() }] : []
}

const norm = (t: string) => t.replace(/\s+/g, ' ').trim()
/** 두 글이 함께 가진 두 글자 묶음 수 (띄어쓰기 뺌) */
function overlap(a: string, b: string): number {
  const bi = (t: string) => { const s = t.replace(/\s+/g, ''); return new Set([...s].slice(0, -1).map((c, i) => c + s[i + 1])) }
  const x = bi(a), y = bi(b)
  return [...x].filter((g) => y.has(g)).length
}

const SHORT_MAX = 40 // 근거 첫 문장을 짧은 이유로 쓸 때의 글자 수

/** 기준이 걸렸을 때의 쉬운 말. 판정기가 짧은 이유를 주지 않았고 근거 첫 문장이 길 때 쓴다 (기준 이름은 화면에 내지 않음) */
const PLAIN: Record<string, string> = {
  '없는 내용, 바뀐 뜻': '넣은 글에 없거나 뜻이 바뀐 내용',
  '숫자·날짜·이름': '넣은 글과 다른 숫자·날짜·이름',
  '세게 바꿔 말함': '넣은 글보다 세게 말함',
  '빠진 내용': '넣은 글의 중요한 내용이 빠짐',
  '잘못 읽을 표기': '목소리가 잘못 읽을 표기',
  '말하듯 쓴 문장': '말하듯 쓰지 않은 문장',
  '길이': '읽는 시간이 45초나 장면 하나가 10초를 넘음',
  '첫 장면': '첫 장면만 듣고는 무슨 얘기인지 모름',
  '이어짐, 되풀이': '앞 장면과 안 이어지거나 같은 말을 되풀이함',
  '끝맺음': '마지막 장면이 이야기를 끝맺지 않음',
}

const QUOTE_RE = /["“「]([^"”」\n]{2,200})["”」]/g
const quotesIn = (t: string) => [...t.matchAll(QUOTE_RE)].map((m) => m[1].trim()).filter(Boolean)

/** 근거 글의 첫 문장. 대본·넣은 글 인용이 들어 있거나 40자를 넘으면 쓰지 않는다(문장 중간에서 자르지 않음) */
export function firstSentence(reason: string): string | null {
  const t = reason.replace(/^\[[^\]]*\]\s*/, '').trim()
  const m = t.match(/^(.+?[.?!다])(\s|$)/)
  const s = (m ? m[1] : t).trim()
  if (!s || s.length > SHORT_MAX || /["“「'‘]/.test(s) || /^\d+번 장면/.test(s)) return null
  return s
}

const round1 = (x: number) => Math.round(x * 10) / 10

/** 기준 7: 숫자 옆에 어떻게 셌는지 (쇼더스 예상 초 합 × 곱한 값). 30초 미만은 걸지 않는다(기준표) */
function lengthText(cr: CriterionResult, scenes: Scene[]): string | null {
  if (cr.total_sec == null) return null
  const hi = 45
  const total = round1(cr.total_sec)
  const sum = round1(scenes.reduce((a, s) => a + (s.sec ?? 0), 0))
  const how = cr.sec_factor && sum ? ` (쇼더스 예상 ${sum}초 × 실제 목소리 비율 ${cr.sec_factor})` : ''
  if (total > hi) return `전체 ${total}초로 ${hi}초보다 김${how}`
  return null
}

function shortOf(name: string, cr: CriterionResult, scenes: Scene[]): string {
  if (cr.total_sec != null) {
    const l = lengthText(cr, scenes)
    if (l) return l
  }
  if (cr.short?.trim()) return cr.short.trim()
  return firstSentence(cr.reason) ?? PLAIN[name] ?? '고칠 곳'
}

/** 기준 순서: 탈락 기준 → 보류 기준 → 나머지 (무거운 것 먼저) */
function order(data: Data): number[] {
  const r = data.verdict_rule
  const head = [...r.fail, ...r.hold]
  return [...head, ...data.criteria.map((c) => c.n).filter((n) => !head.includes(n))]
}

export function placesOf(data: Data, r: Pick<Result, 'criteria'>, scenes: Scene[], ctx: { sourceText?: string } = {}): Places {
  const spots: Spot[] = []
  const problems: Problem[] = []
  const says: Say[] = []
  const has = (n: number) => scenes.some((s) => s.n === n)
  const text = (n: number) => scenes.find((s) => s.n === n)?.text ?? ''

  for (const n of order(data)) {
    const cr = r.criteria[String(n)]
    if (!cr?.flagged) continue
    const name = data.criteria.find((c) => c.n === n)?.name ?? ''
    const marks: { scene: number; quote: string; fix: string | null }[] = []

    if (cr.hits?.length) {
      // 잘못 읽을 표기: 표기와 고칠 말
      for (const h of cr.hits) if (has(h.scene)) marks.push({ scene: h.scene, quote: h.text, fix: h.fix })
    } else {
      // 판정기가 짚은 자리
      for (const m of cr.marks ?? []) if (has(m.scene)) marks.push({ scene: m.scene, quote: m.quote ?? '', fix: m.fix ?? null })
    }

    // 한 글자 구절('시' 등)은 문장 곳곳에 있어 밑줄을 긋지 않고 장면 끝 번호로
    for (const m of marks) if (m.quote.length < 2 && !m.fix) m.quote = ''
    // 모든 장면을 짚었는데 구절이 없으면 대본 전체 하나로
    const sceneOnly = marks.filter((m) => !m.quote)
    const whole = marks.length === 0 || (sceneOnly.length === marks.length && sceneOnly.length === scenes.length && scenes.length > 1)
    const quoted = marks.filter((m) => m.quote && text(m.scene).includes(m.quote))
    const lost = marks.filter((m) => m.quote && !text(m.scene).includes(m.quote)) // 장면 문장과 글자가 다른 인용 → 장면 끝 번호

    // 걸린 기준 하나 = 번호 하나. 바꿀 말이 있는 자리도 같은 번호를 단다(말풍선 번호와 대본 번호가 같게)
    const short = shortOf(name, cr, scenes)
    const no = problems.length + 1
    problems.push({ no, n, text: short, whole })
    says.push({ n, no, text: sayOf(name, cr, short, marks, whole, ctx, scenes) })
    if (whole) continue
    // 글자가 딱 맞지 않는 인용도 그대로 넘긴다. 화면(Card.tsx placeSpots)이 띄어쓰기·문장부호를 빼고 다시 맞추고,
    // 그래도 못 맞추면 장면 번호 곁에 번호만 둔다
    for (const m of [...quoted, ...lost]) spots.push({ scene: m.scene, quote: m.quote, fix: m.fix, no })
    for (const sc of new Set(sceneOnly.map((m) => m.scene))) spots.push({ scene: sc, quote: '', fix: null, no })
  }
  return { spots, problems, says, count: problems.length }
}

export const circled = (n: number) => (n >= 1 && n <= 20 ? String.fromCharCode(0x2460 + n - 1) : `(${n})`)

/** 받침이 있으면 「이」, 없으면 「가」 */
export const iga = (w: string) => {
  const c = w.charCodeAt(w.length - 1)
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0 ? '이' : '가'
}
