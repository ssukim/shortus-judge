import { useEffect, useSyncExternalStore } from 'react'
import { href } from './common'
import { clearRecent, removeRecent, recentList, restoreRecent, subscribeRecent } from './recent'

// 왼쪽 메뉴: 제목 → 새 판정 → 화면 링크 → 최근 판정(recent.ts).
// 넓은 화면에서는 왼쪽에 고정. 휴대폰 폭(760px 이하)에서는 숨겨 두고, 머리줄 ☰ 단추로 왼쪽에서 덮어 연다.
// 열린 메뉴는 항목을 누르면(주소가 바뀌면, App.tsx) 닫힌다. 바깥을 누르거나 Esc로도 닫힌다.

export default function Sidebar({ page, query, open, onClose }: {
  page: string; query: URLSearchParams; open: boolean; onClose: () => void
}) {
  const recent = useSyncExternalStore(subscribeRecent, recentList)
  const diffOn = page === 'list' && query.get('f') === 'diff'
  const turns = (query.get('t') ?? '').split(',').filter(Boolean)
  const shownToken = page === '' && turns.length === 1 ? turns[0] : ''
  // 최근 판정 하나를 지운다. 지금 화면에 떠 있는 차례면 화면에서도 빼고, 남는 차례가 없으면 새 판정 화면(홈)으로 간다
  const forget = (token: string) => {
    removeRecent(token)
    if (page !== '' || !turns.includes(token)) return
    const rest = turns.filter((t) => t !== token)
    window.location.hash = rest.length ? href([], { t: rest.join(',') }) : href([])
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  return (
    <>
      {open && <div className="side-shade" onClick={onClose} aria-hidden="true" />}
      <aside id="side" className={open ? 'side side-open' : 'side'} aria-label="메뉴">
        <a className="side-title" href={href([])} onClick={onClose}>쇼츠 대본 판정기</a>
        {/* 같은 주소(첫 화면)에서 눌러도 닫히게 onClose를 같이 부른다 */}
        <a className="side-new" href={href([])} onClick={onClose}>＋ 새 판정</a>
        <nav className="side-nav" aria-label="다른 화면">
          <a className={(page === 'list' && !diffOn) || page === 'script' ? 'on' : ''} href={href(['list'])} onClick={onClose}>모아 둔 대본</a>
          <a className={diffOn ? 'on' : ''} href={href(['list'], { f: 'diff' })} onClick={onClose}>채점자와 판정 다름</a>
          <a className={page === 'check' ? 'on' : ''} href={href(['check'])} onClick={onClose}>얼마나 믿을 수 있나</a>
        </nav>
        <div className="side-recent">
          <div className="side-recent-head">
            <h2>최근 판정</h2>
            {recent.length > 0 && <button type="button" className="inline-link side-clear" onClick={() => { const shown = page === '' && turns.some((t) => recent.some((x) => x.token === t)); clearRecent(); if (shown) window.location.hash = href([]) }}>모두 지우기</button>}
          </div>
          {recent.length === 0 ? (
            <p className="hint">판정한 대본이 여기에 쌓입니다.</p>
          ) : (
            <ul>
              {recent.map((x) => (
                <li key={x.token}>
                  <a className={x.token === shownToken ? 'on' : ''} href={href([], { t: x.token })} title={x.label}
                    onClick={() => { restoreRecent(x); onClose() }}>
                    <span className="side-recent-label">{x.label}</span>
                    <span className="side-recent-v">{x.verdict}</span>
                  </a>
                  <button type="button" className="side-recent-del" onClick={() => forget(x.token)} aria-label={`${x.label} 지우기`} title="이 판정 지우기">×</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>
  )
}
