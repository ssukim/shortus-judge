import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { parseHash, setQuery } from './common'
import { BotFace } from './Card'

// 판정 보고서 패널.
// - 넓은 화면(1024px 이상): 오른쪽 고정 패널. 대화를 덮지 않고 대화 칸이 좁아진다. 어두운 막·밀려 들어오는 효과 없음.
//   패널이 열려 있어도 대화를 스크롤하고 누를 수 있다.
// - 좁은 화면: 화면 전체를 덮는 새 화면(뒤로 버튼).
// - 열린 상태·탭·기준은 주소에 남는다(#/…?d=<열쇠>&dt=<탭>&dc=<기준>). 그 주소를 열면 같은 패널이 열린다(공유).
//   처음 열 때 주소를 하나 쌓아 뒤로 가기로 닫히고, 열린 채 탭·기준을 바꿀 때는 주소만 바꾼다.

const KEY = 'd', TAB = 'dt', CRIT = 'dc'
export const WIDE = '(min-width: 1024px)'
const openedHere = new Set<string>()
const openers = new Map<string, HTMLElement>()

function useHashQuery(): URLSearchParams {
  const [h, setH] = useState(window.location.hash)
  useEffect(() => {
    const on = () => setH(window.location.hash)
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return parseHash(h).query
}

function replaceQuery(updates: Record<string, string | undefined>) {
  const { path, query } = parseHash(window.location.hash)
  for (const [k, v] of Object.entries(updates)) (v ? query.set(k, v) : query.delete(k))
  const qs = query.toString()
  history.replaceState(null, '', '#/' + path.map(encodeURIComponent).join('/') + (qs ? '?' + qs : ''))
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

export interface PanelState {
  open: boolean
  tab: string | null
  crit: number | null
  show: (from: HTMLElement | null, at?: { tab?: string; crit?: number }) => void
  setTab: (tab: string) => void
  hide: () => void
}

export function usePanel(key: string): PanelState {
  const q = useHashQuery()
  const open = q.get(KEY) === key
  const tab = open ? q.get(TAB) : null
  const c = open ? Number(q.get(CRIT)) : NaN
  const show: PanelState['show'] = (from, at = {}) => {
    const upd = { [KEY]: key, [TAB]: at.tab, [CRIT]: at.crit != null ? String(at.crit) : undefined }
    if (open) return replaceQuery(upd)
    if (from) openers.set(key, from)
    openedHere.add(key)
    setQuery(upd)
  }
  const hide = () => {
    if (openedHere.has(key)) {
      openedHere.delete(key)
      history.back()
    } else replaceQuery({ [KEY]: undefined, [TAB]: undefined, [CRIT]: undefined })
  }
  const was = useRef(open)
  useEffect(() => {
    if (was.current && !open) openers.get(key)?.focus()
    was.current = open
  }, [open])
  return { open, tab, crit: Number.isFinite(c) && c > 0 ? c : null, show, setTab: (t) => replaceQuery({ [TAB]: t, [CRIT]: undefined }), hide }
}

function useWide() {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches)
  useEffect(() => {
    const m = window.matchMedia(WIDE)
    const on = () => setWide(m.matches)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return wide
}

function CopyLink() {
  const [done, setDone] = useState(false)
  return (
    <button type="button" className="panel-icon" aria-label={done ? '링크를 복사했어요' : '이 보고서 링크 복사'} title="링크 복사"
      onClick={() => navigator.clipboard?.writeText(window.location.href).then(() => { setDone(true); setTimeout(() => setDone(false), 1500) })}>
      {done ? '✓' : '⧉'}
    </button>
  )
}

export function Panel({ title, sub, onClose, tabs, tab, onTab, children }: {
  title: string
  sub?: string // 대본 제목
  onClose: () => void
  tabs?: { id: string; label: string }[]
  tab?: string
  onTab?: (id: string) => void
  children: ReactNode
}) {
  const wide = useWide()
  const head = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    head.current?.focus({ preventScroll: true })
    document.body.classList.add('has-panel')
    const prev = document.body.style.overflow
    if (!wide) document.body.style.overflow = 'hidden' // 새 화면일 때만 뒤 화면을 잠근다
    return () => {
      document.body.classList.remove('has-panel')
      document.body.style.overflow = prev
    }
  }, [wide])

  return createPortal(
    <aside className={wide ? 'panel panel-side' : 'panel panel-full'} aria-label={title}
      onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }}>
      <div className="panel-top">
        {!wide && <button type="button" className="panel-back" onClick={onClose}>← 뒤로</button>}
        <span className="panel-actions">
          <CopyLink />
          {wide && <button type="button" className="panel-icon" onClick={onClose} aria-label="보고서 닫기">✕</button>}
        </span>
      </div>
      <div className="panel-id">
        <BotFace />
        <span className="panel-bot">판정봇</span>
        <h2 ref={head} tabIndex={-1}>{title}</h2>
        {sub && <p className="panel-sub">{sub}</p>}
      </div>
      {tabs && tabs.length > 1 && (
        <div className="panel-tabs" role="tablist" aria-label="보고서 나누어 보기">
          {tabs.map((t) => (
            <button key={t.id} type="button" role="tab" aria-selected={t.id === tab} className={t.id === tab ? 'on' : ''} onClick={() => onTab?.(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div className="panel-body" role={tabs ? 'tabpanel' : undefined}>{children}</div>
    </aside>,
    document.body,
  )
}
