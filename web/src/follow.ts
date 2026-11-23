import { useEffect, useRef, useState } from 'react'

// 판정해 보기의 따라가기 스크롤(채팅 앱처럼).
// 머리줄은 위에, 입력칸과 버튼(.feed-bottom)은 아래에 고정되어 있다. 보이는 칸은 그 사이다.
// - 따라가는 중이면 새 차례가 생길 때, 내용이 늘 때, 끝났을 때 모두 「차례 끝이 아래 고정 영역 바로 위」에 오게 내린다.
//   끝났을 때 판정봇 보고부터 차례 끝까지가 보이는 칸보다 길면 보고 맨 위를 머리줄 바로 아래에 맞춘다(보고 첫 줄을 놓치지 않게).
// - 사용자가 위로 스크롤해 화면이 실제로 올라가면(휠·터치·키 뒤 0.6초 안에 scrollY가 줄면) 따라가기를 멈추고,
//   차례 끝이 고정 영역 근처로 돌아오면 다시 따라간다. 진행 중에 내용이 늘었다고 따로 알리지는 않는다.
// - 「판정봇 보고」(.bot-report)는 판정봇 덩어리 안의 결론 말풍선이다(머리줄은 차례 맨 위에 처음부터 있어 기준이 아니다).
// - 멈춘 채로 판정이 끝났고 판정 보고(.bot-report) 맨 위가 보이는 칸보다 아래에 있을 때만 「판정 결과 보기 ↓」를 띄운다.
//   보고가 보이게 직접 스크롤하거나, 단추를 누르거나, 새 판정을 시작하면 사라진다.
//   (화면 맨 위에서 위로 쓸거나 트랙패드에 손만 대 화면이 움직이지 않은 것은 멈춤으로 보지 않는다)
// - 움직임 줄이기 설정이면 바로 옮긴다. 휴대폰에서 보고서 패널이 열려 있으면(뒤 화면 스크롤 잠김) 움직이지 않는다.

const NEAR_PX = 80 // 차례 끝이 보이는 칸 아래에서 이만큼 안이면 「맨 아래 근처」
const END_GAP = 8 // 차례 끝과 고정 영역 위 사이 여백
const TOP_GAP = 8 // 보고 맨 위를 머리줄 아래에 맞출 때 여백
const INTENT_MS = 600 // 위로 가는 입력 뒤 이 시간 안에 화면이 올라가면 사용자가 올린 것으로 본다

const smooth = (): ScrollBehavior => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth')
const sheetOpen = () => document.body.style.overflow === 'hidden'
/** 보이는 칸의 위(머리줄 아래)와 아래(고정 영역 위), 화면 좌표 */
const viewTop = () => document.querySelector('header.top')?.getBoundingClientRect().bottom ?? 0
const viewBottom = () => document.querySelector('.feed-bottom')?.getBoundingClientRect().top ?? window.innerHeight

export function useFollow(token: string, done: boolean): { newBelow: boolean; jump: () => void; nudge: () => void } {
  const [newBelow, setNewBelow] = useState(false)
  const follow = useRef(true)
  const doneRef = useRef(done)
  // 그리기 전에 바로 보는 끝남 값. doneRef는 끝남 효과(useEffect, 그린 뒤)에서야 바뀌어, 끝나서 내용이 는 첫 그리기에서
  // nudge(useLayoutEffect)와 ResizeObserver가 아직 진행 중으로 보고 맨 아래로 내렸다가 끝남 효과가 보고 맨 위로 되올리는 일이 있었다.
  // 렌더 중에 적어 두어, 끝난 뒤 처음 늘어날 때는 아래로 내리지 않고 끝남 효과의 toEnd 한 번만 움직이게 한다
  const doneNow = useRef(done)
  doneNow.current = done
  const el = () => (token ? document.getElementById(`turn-${token}`) : null)

  /** 차례 끝을 고정 영역 바로 위로. 내용이 늘 때는 바로(auto), 한 번씩 옮길 때는 부드럽게 */
  const toBottom = (behavior: ScrollBehavior = 'auto') => {
    const a = el()
    if (!a || sheetOpen()) return
    const target = window.scrollY + a.getBoundingClientRect().bottom - (viewBottom() - END_GAP)
    if (Math.abs(target - window.scrollY) > 1) window.scrollTo({ top: Math.max(0, target), behavior })
  }
  /** 끝났을 때: 보고부터 차례 끝까지가 보이는 칸에 들어가면 맨 아래로, 아니면 보고 맨 위를 머리줄 아래로 */
  const toEnd = (behavior: ScrollBehavior) => {
    const a = el()
    if (!a || sheetOpen()) return
    const b = a.querySelector('.bot-report')
    const room = viewBottom() - END_GAP - (viewTop() + TOP_GAP)
    if (b && a.getBoundingClientRect().bottom - b.getBoundingClientRect().top > room) {
      window.scrollTo({ top: Math.max(0, window.scrollY + b.getBoundingClientRect().top - viewTop() - TOP_GAP), behavior })
    } else toBottom(behavior)
  }

  // 새 차례: 맨 아래로 (이미 끝난 저장 결과도 같은 규칙)
  useEffect(() => {
    if (!token) return
    follow.current = true
    setNewBelow(false)
    doneRef.current = done
    requestAnimationFrame(() => (done ? toEnd('auto') : toBottom('auto')))
  }, [token])

  // 끝남: 따라가는 중이면 맨 아래로(보고가 길면 보고 맨 위로). 멈춘 상태면 보고 맨 위가 보이는 칸 아래에 있을 때만 「판정 결과 보기 ↓」
  useEffect(() => {
    const was = doneRef.current
    doneRef.current = done
    if (!token || !done || was) return
    requestAnimationFrame(() => {
      if (follow.current) return toEnd(smooth())
      setNewBelow(reportBelow())
    })
  }, [done])

  /** 판정 보고 맨 위가 보이는 칸 아래에 있다(아직 안 보임). 보고가 없으면 false */
  const reportBelow = () => {
    const top = el()?.querySelector('.bot-report')?.getBoundingClientRect().top
    return top != null && top > viewBottom()
  }

  // 진행 중 내용이 늘면 따라간다. 고정 영역 높이가 바뀌어도(붙여 넣기 칸을 펼침) 같은 자리를 지킨다
  useEffect(() => {
    const a = el()
    if (!a || typeof ResizeObserver === 'undefined') return
    let lastH = a.getBoundingClientRect().height
    const ro = new ResizeObserver(() => {
      if (doneRef.current || doneNow.current) return
      const r = a.getBoundingClientRect()
      const before = r.bottom - (r.height - lastH) // 늘기 전 차례 끝
      lastH = r.height
      // 늘기 전에 차례 끝이 보이는 칸 아래 근처였으면(사용자가 끝을 보고 있었으면) 다시 따라간다
      if (!follow.current && before - viewBottom() < NEAR_PX) follow.current = true
      if (follow.current) toBottom()
    })
    ro.observe(a)
    const bar = document.querySelector('.feed-bottom')
    if (bar) ro.observe(bar)
    return () => ro.disconnect()
  }, [token])

  // 사용자가 위로 스크롤하면 멈추고, 끝 근처로 돌아오면 다시 따라간다
  useEffect(() => {
    // 위로 가는 입력만 적어 두고, 멈춤은 화면이 실제로 올라갔을 때(onScroll) 정한다
    let upAt = -Infinity
    let lastY = window.scrollY
    const up = () => (upAt = performance.now())
    const onWheel = (e: WheelEvent) => e.deltaY < 0 && up()
    let ty = 0
    const onTouchStart = (e: TouchEvent) => (ty = e.touches[0]?.clientY ?? 0)
    const onTouchMove = (e: TouchEvent) => (e.touches[0]?.clientY ?? 0) > ty + 4 && up()
    const onKey = (e: KeyboardEvent) => ['ArrowUp', 'PageUp', 'Home'].includes(e.key) && up()
    const onScroll = () => {
      const y = window.scrollY
      const wentUp = y < lastY - 1
      lastY = y
      const a = el()
      if (!a) return
      if (doneRef.current) {
        // 끝난 뒤: 사용자가 스크롤해 보고가 보이면 단추를 거둔다
        if (!reportBelow()) setNewBelow(false)
        return
      }
      if (wentUp && performance.now() - upAt < INTENT_MS) {
        follow.current = false
        return
      }
      if (a.getBoundingClientRect().bottom - viewBottom() < NEAR_PX) {
        follow.current = true
      }
    }
    window.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: true })
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll)
    }
  }, [token])

  const jump = () => {
    follow.current = true
    setNewBelow(false)
    if (doneRef.current) toEnd(smooth())
    else toBottom(smooth())
  }
  // 차례가 다시 그려질 때마다(useLayoutEffect, 그리기 전) 바로 맞춘다. ResizeObserver는 다음 그리기 때 와서 그 사이 한 번 어긋나 보일 수 있다
  const nudge = () => {
    if (follow.current && !doneRef.current && !doneNow.current) toBottom()
  }
  return { newBelow, jump, nudge }
}
