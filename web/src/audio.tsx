// 대본 들어 보기. 화면 전체에 소리 하나만 재생한다(다른 단추를 누르면 앞의 재생은 멈춤).
// 소리는 판정 서버의 api/tts(쇼더스 「목소리 미리 듣기」, 크레딧 0, judge/listen.py의 tts)로 받는다.
// 판정 서버에 쇼더스 키가 있을 때만 쓰고(GET {tts: true, ready: true}), 없으면 단추를 보이지 않는다.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { API_URL, getJson } from './judgeClient'

export const TTS_URL = API_URL.replace(/judge\/?$/, 'tts')

/** 소리 하나: 저장한 파일 주소(url) 또는 api/tts로 읽힐 글(text). key는 재생 중 표시에 씀 */
export interface Clip { key: string; url?: string; text?: string }

let el: HTMLAudioElement | null = null
let playing: string | null = null
let queue: Clip[] = []
let token = 0
const subs = new Set<() => void>()
const blobs = new Map<string, Promise<string | null>>()

function emit() { subs.forEach((f) => f()) }
function setPlaying(k: string | null) { playing = k; emit() }

function audioEl(): HTMLAudioElement {
  if (!el) {
    el = new Audio()
    el.preload = 'auto'
    el.addEventListener('ended', () => next(token))
    el.addEventListener('error', () => next(token))
  }
  return el
}

function ttsBlob(text: string): Promise<string | null> {
  let p = blobs.get(text)
  if (!p) {
    p = fetch(TTS_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
      .then((r) => (r.ok ? r.blob() : null)).then((b) => (b ? URL.createObjectURL(b) : null)).catch(() => null)
    blobs.set(text, p)
    p.then((u) => { if (!u) blobs.delete(text) })
  }
  return p
}

function next(t: number) {
  if (t !== token) return
  const c = queue.shift()
  if (!c) return setPlaying(null)
  setPlaying(c.key)
  const src = c.url ? Promise.resolve(c.url) : c.text ? ttsBlob(c.text) : Promise.resolve(null)
  src.then((u) => {
    if (t !== token) return
    if (!u) return next(t)
    const a = audioEl()
    a.src = u
    a.play().catch(() => next(t))
  })
}

/** 차례로 재생. 하나면 그 장면만 */
export function play(clips: Clip[]) {
  stop()
  queue = [...clips]
  next(token)
}

export function stop() {
  token += 1
  queue = []
  if (el) { el.pause(); el.removeAttribute('src'); el.load() }
  setPlaying(null)
}

export function usePlaying(): string | null {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f) }, () => playing)
}

let ttsProbe: Promise<boolean> | null = null
function probeTts(): Promise<boolean> {
  ttsProbe ??= getJson(TTS_URL).then((b) => !!(b && b.tts === true && b.ready === true))
  return ttsProbe
}

/** 판정 서버에서 소리를 받을 수 있는지 (처음엔 false, 물어본 뒤 바뀜) */
export function useTtsReady(): boolean {
  const [ok, setOk] = useState(false)
  useEffect(() => { let on = true; probeTts().then((v) => on && setOk(v)); return () => { on = false } }, [])
  return ok
}

/** ▶ 단추. 누르면 clips를 차례로 재생하고, 재생 중에 다시 누르면 멈춤 */
export function PlayButton({ clips, label, small, text }: { clips: Clip[]; label: string; small?: boolean; text?: string }) {
  const now = usePlaying()
  if (!clips.length) return null
  const on = !!now && clips.some((c) => c.key === now)
  return (
    <button type="button" className={`play-btn${small ? ' play-small' : ''}${text ? ' play-text' : ''}${on ? ' on' : ''}`}
      aria-label={on ? `${label} 멈추기` : label} aria-pressed={on} onClick={() => (on ? stop() : play(clips))}>
      <span aria-hidden="true">{on ? '■' : '▶'}</span>{text && <span>{on ? '멈추기' : text}</span>}
    </button>
  )
}
