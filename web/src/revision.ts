// 고친 대본(결과의 revision 칸, judge/view.py의 revision_view).
// 판정기는 모델로 문장을 고쳐 쓰지 않는다. 목소리가 잘못 읽을 표기와 읽을 때마다 틀리게 읽는 숫자만
// 코드가 바로 읽히게 바꾼다(method "reading_only"). 바꾼 장면의 글(after)이 렌더링에 들어갈 문장이다.

import type { Data, Result, Revision } from './types'

export function revisionOf(r?: Pick<Result, 'revision'>): Revision | null {
  const x = r?.revision
  if (!x || !Array.isArray(x.scenes) || x.error) return null
  return x.scenes.some((s) => s.changed) ? x : null
}

/** 판정봇의 끝 문장: 어느 대본으로 만드는지. 원래 대본 그대로면 null */
export function decisionSay(data: Data, r: Result, shortName: (n: number) => string): string | null {
  const d = r.decision
  if (!d) return null
  const names = (ns: number[]) => ns.map(shortName).join('·')
  const rev = revisionOf(r)
  const changed = rev ? rev.scenes.filter((s) => s.changed).length : 0
  const fixNote = rev ? ` 목소리가 잘못 읽을 표기와 숫자를 바로 읽히게 바꾼 고친 대본(장면 ${changed}개)도 같이 냈어요.` : ''
  if (d.action === 'render_original') return null
  if (d.action === 'render_revised')
    return `목소리가 잘못 읽을 표기와 숫자만 바로 읽히게 바꾼 고친 대본(장면 ${changed}개)으로 만들어요. 문장 내용은 그대로예요.`
  const left = (d.remaining ?? []).map((x) => x.criterion)
  if (d.action === 'review') {
    const unknown = r.undecided?.length ? ' 모델 답을 받지 못한 기준이 있어요.' : ''
    return `${left.length ? names(left) + ' 때문에 ' : ''}사람이 보고 고칠지 정해야 해요.${unknown}${fixNote}`
  }
  const facts = left.filter((n) => data.verdict_rule.fail.includes(n))
  return `넣은 글과 다른 내용${facts.length ? `(${names(facts)})` : ''}이 있어 만들지 않아요. 판정기는 내용을 고쳐 쓰지 않아요.`
}
