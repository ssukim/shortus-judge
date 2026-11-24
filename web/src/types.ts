// web/scripts/export_data.py가 만드는 public/data.json의 모양.
// 결과(Result)는 판정 서버(judge/serve.py)의 응답과 같은 모양이다. 둘 다 judge/view.py의 to_view가 만든다.

export type Verdict = string // "통과" | "보류" | "탈락" (data.verdicts)

export interface Criterion {
  n: number
  name: string // 화면에 쓰는 짧은 이름 (judge/view.py의 NAMES)
  group?: string // 기준표의 묶음 (사실 · 듣기 · 구성)
  text?: string // 기준표의 기준 문장
  by?: string // code / model
}

export interface Scene {
  n: number
  role: string
  sec: number | null // 쇼더스 예상 초 (estimated_sec)
  text: string
}

export interface Label {
  verdict: Verdict
  flags: number[] | null
}

export interface Script {
  id: string
  type: string
  type_name: string
  source_id: string
  total_sec: number | null
  scenes: Scene[]
  nth: string // 같은 글로 만든 대본 가운데 몇 번째인지 ("첫 번째")
  test: boolean // 시험용 50개 (data/labels/test.txt)
  consensus: { all?: Label; sure?: Label } // 채점자 세 명의 다수결 정답, 확신 정답
  shortus: { script_id: string; text_source_id: string; collected_at: string | null; raw: unknown } // 쇼더스에서 받아 둔 그대로
}

export interface Hit { scene: number; text: string; fix: string | null; heard?: string }

export interface CriterionResult {
  flagged: boolean
  scenes: number[]
  reason: string
  by: string // code / model / code+listen
  result?: string // 걸림 / 안 걸림 / 판정 못 함
  error?: boolean // 모델 답을 받지 못함 (판정 못 함)
  votes?: string // 사실 묶음: 세 번 물어 걸림이라 답한 수 ("2/3")
  doubt?: boolean
  short?: string // 짧은 이유
  source_quote?: string | null // 견준 넣은 글의 문장
  marks?: { scene: number; quote: string; fix?: string | null }[] // 대본 위에 표시할 자리
  hits?: Hit[] // 기준 5: 걸린 표기와 고친 대본에 들어간 읽는 법
  vague?: { scene: number; text: string; why: string }[] // 기준 5: 애매해서 걸지 않은 표기
  listen?: { heard: number; different: number; skipped: string | null } // 기준 5: 듣기 검사(켰을 때)
  total_sec?: number // 기준 7
  scene_sec?: number[]
  sec_factor?: number
  not_checked?: boolean
}

// review: 보류라 사람이 보고 정함 (공개본 판정 선. 고친 대본도 보류면 저절로 만들지 않는다, D35)
export type Action = 'render_original' | 'render_revised' | 'review' | 'do_not_render'

export interface Decision {
  action: Action
  script: string | null // original / revision 1 / revision 2, 정하지 않으면 null
  round: number | null
  reason: string
  remaining: { criterion: number; name: string }[] // 판정을 정한 걸린 기준
  tried?: number // 고쳐 다시 판정한 횟수 (judge/revise.py)
}

export interface Result {
  id?: string
  verdict: Verdict
  why: string[] // 판정 까닭 (judge/verdict.py)
  flagged: number[]
  diagnostics: number[] // 걸렸지만 판정에 쓰지 않은 기준
  criteria: Record<string, CriterionResult>
  summary: string
  notices: string[]
  undecided: { criterion: number | null; why: string }[]
  source_given?: boolean
  cost_usd: number
  elapsed_sec?: number | null
  model?: string
  calls?: number
  judged_at?: string | null
  decision: Decision
  // 고친 대본 (web/src/revision.ts의 revisionOf로 읽음). 통과한 대본은 표기만 고친 것(method reading_only),
  // 보류·탈락 대본은 모델이 고치고 다시 판정한 것(method model, judge/revise.py). revision_2는 두 번째로 고친 것
  revision: unknown
  revision_2?: unknown
}

/** k/n과 95% Wilson 구간(백분율, 정수) */
export interface Frac { k: number; n: number; lo: number; hi: number }

export interface Check {
  n: number
  verdict: Frac
  baseline: { top: string; k: number }
  confusion: Record<string, Record<string, number>>
  fail_n: number
  fail_as_fail: number
  fail_as_hold: number
  leak: string[]
  false_fail: string[]
  not_fail_n: number
  criteria: Record<string, { gold: number; both: number; miss: number; extra: number }>
  diffs: { id: string; verdict: string; gold: string }[]
}

export type SetKey = 'dev' | 'test' | 'all'
export type GoldKey = 'all' | 'sure'

export interface Source {
  title: string
  text: string
  origin: { kind: string; title?: string | null; publisher?: string | null; published?: string | null; url?: string | null; license?: string } | null
}

export interface Rule { fail: number[]; hold: number[]; hold_group: number[]; hold_group_min: number; diag: number[] }

export interface Data {
  criteria: Criterion[]
  verdict_rule: Rule
  verdicts: Verdict[]
  undecided: string
  model: string
  results_dir: string
  scripts: Script[]
  sources: Record<string, Source>
  results: Record<string, Result>
  check: Record<GoldKey, Record<SetKey, Check>>
}
