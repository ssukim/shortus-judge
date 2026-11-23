// 펼치기(details/summary)를 열면 펼친 내용이 보이게 스크롤한다. 모든 화면의 펼치기에 한 곳에서 건다(App.tsx).
// - 펼친 직후(다음 프레임) 펼친 내용 끝이 보이는 칸 아래(아래 고정 영역 위)보다 아래면 그만큼만 내린다(끝이 고정 영역 위 12px).
// - 펼친 내용이 보이는 칸보다 길면 펼치기 제목 줄(summary)을 보이는 칸 맨 위(머리줄 바로 아래)에 맞춘다.
// - 접을 때는 움직이지 않는다. 아래로만 옮기므로 따라가기(follow.ts)를 멈추지 않는다(멈춤은 위로 올라간 스크롤만 봄).
// - 세부정보 패널 안이면 패널 스크롤(.panel-body) 기준으로 같은 규칙. 움직임 줄이기 설정이면 바로 옮긴다.

const END_GAP = 12

function scroller(el: Element): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight) return p
  }
  return null // 창 스크롤
}

function reveal(d: HTMLDetailsElement) {
  const box = scroller(d)
  let top: number
  let bottom: number
  if (box) {
    const r = box.getBoundingClientRect()
    top = r.top
    bottom = r.bottom
  } else {
    top = document.querySelector('header.top')?.getBoundingClientRect().bottom ?? 0
    bottom = document.querySelector('.feed-bottom')?.getBoundingClientRect().top ?? window.innerHeight
  }
  const dr = d.getBoundingClientRect()
  const end = dr.bottom
  if (end <= bottom - END_GAP) return
  const head = (d.querySelector(':scope > summary') ?? d).getBoundingClientRect().top
  const by = dr.bottom - head > bottom - END_GAP - top ? head - top : end - (bottom - END_GAP)
  if (by <= 0) return
  const behavior: ScrollBehavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
  if (box) box.scrollBy({ top: by, behavior })
  else window.scrollBy({ top: by, behavior })
}

let installed = false
export function installReveal() {
  if (installed) return
  installed = true
  // toggle은 거품이 오르지 않아 잡기 단계에서 받는다
  document.addEventListener('toggle', (e) => {
    const d = e.target
    if (d instanceof HTMLDetailsElement && d.open) requestAnimationFrame(() => reveal(d))
  }, true)
}
