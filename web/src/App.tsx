import { useEffect, useRef, useState } from 'react'
import type { Data } from './types'
import { href, parseHash } from './common'
import ListPage from './ListPage'
import ScriptPage from './ScriptPage'
import CheckPage from './CheckPage'
import Feed, { HeroShell } from './Feed'
import Sidebar from './Sidebar'
import { installReveal } from './reveal'

installReveal() // 펼치기를 열면 펼친 내용이 보이게 (reveal.ts)

function useHash() {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const on = () => setHash(window.location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return hash
}

export default function App() {
  const [data, setData] = useState<Data | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hash = useHash()
  // 넓은 화면은 왼쪽 메뉴(Sidebar)만 있고 머리줄이 없다(display: none → 높이 0). 휴대폰 폭에서만 머리줄(☰ 단추)이 위에 고정된다.
  // 머리줄 실제 높이를 --top-h로 적어 두면 스크롤 맞춤(follow.ts, reveal.ts, scroll-padding)이 그만큼 뺀다
  const top = useRef<HTMLElement>(null)
  useEffect(() => {
    const el = top.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => document.documentElement.style.setProperty('--top-h', `${el.offsetHeight}px`))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const [menu, setMenu] = useState(false) // 휴대폰 폭에서 메뉴가 열려 있는지
  useEffect(() => setMenu(false), [hash])

  useEffect(() => {
    // 상대 경로: 하위 경로에 올려도 같은 폴더의 data.json을 읽는다.
    fetch(import.meta.env.BASE_URL + 'data.json')
      .then((r) => {
        if (!r.ok) throw new Error(`data.json을 읽지 못했습니다 (${r.status})`)
        return r.json()
      })
      .then(setData)
      .catch((e) => setError(String(e.message ?? e)))
  }, [])

  useEffect(() => {
    window.scrollTo(0, 0)
  }, [hash.split('?')[0]])

  const route = parseHash(hash)
  const page = route.path[0] ?? ''

  return (
    <>
      <header className="top" ref={top}>
        <div className="top-inner">
          <button type="button" className="menu-btn" aria-label="메뉴 열기" aria-expanded={menu} aria-controls="side" onClick={() => setMenu(true)}>☰</button>
          <a className="title" href={href([])}>쇼츠 대본 판정기</a>
        </div>
      </header>
      <Sidebar page={page} query={route.query} open={menu} onClose={() => setMenu(false)} />
      <main className={page === '' ? 'wrap wrap-narrow' : 'wrap'}>
        {error && <p className="notice">{error}</p>}
        {/* 자료를 받는 동안: 첫 화면은 제목만 먼저 같은 자리에 그리고, 다른 화면은 비워 둔다(「불러오는 중」 글을 띄우지 않음) */}
        {!data && !error && page === '' && <HeroShell />}
        {data && page === 'list' && <ListPage data={data} query={route.query} />}
        {data && page === 'script' && <ScriptPage data={data} id={route.path[1] ?? ''} />}
        {data && page === 'check' && <CheckPage data={data} />}
        {data && page === '' && <Feed data={data} query={route.query} />}
        {data && !['', 'list', 'script', 'check'].includes(page) && (
          <p className="notice">없는 주소입니다. <a href={href(['list'])}>대본 목록</a>으로 갑니다.</p>
        )}
      </main>
    </>
  )
}
