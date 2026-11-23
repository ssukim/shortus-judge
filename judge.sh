#!/bin/zsh
# shortus-judge — 쇼더스 대본 판정기 실행 (Claude 세션 열기는 run.sh)
#
# 사용법:
#   ./judge.sh                       선택 메뉴
#   ./judge.sh one [대본 파일]       대본 하나 판정 (기본: data/scripts/blog-04-g1.json)
#   ./judge.sh dev [결과 폴더]       개발용 대본 판정하고 합의와 견줌 (기본: results/latest)
#   ./judge.sh test [결과 폴더]      시험용 대본 판정하고 합의와 견줌 (기본: results/latest-test)
#   ./judge.sh eval [결과 폴더]      저장한 결과를 합의와 견줌 (기본: results/latest)
#   ./judge.sh labels                채점자 합의 다시 계산
#   ./judge.sh web [포트]            화면과 판정 서버 띄우기 (기본 http://127.0.0.1:8787, 빌드한 web/dist가 있어야 함)
#
# 환경 변수:
#   JUDGE_MODEL    기본 claude-haiku-5-5. claude-sonnet-5-5 로 바꿀 수 있다.
#   JUDGE_BACKEND  기본 claude-cli(이 컴퓨터에 로그인한 Claude Code). api 로 두면 .env의 ANTHROPIC_API_KEY.
#   JUDGE_WORKERS  동시에 판정할 대본 수 (기본 6)
#   JUDGE_LISTEN   1이면 듣기 검사(숫자 든 장면을 쇼더스 목소리로 읽혀 받아쓰기로 대조)를 더한다. .venv의 파이썬으로 돈다.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

CMD="${1:-}"
ARG="${2:-}"
WORKERS="${JUDGE_WORKERS:-6}"
PY=python3
[[ "${JUDGE_LISTEN:-}" == "1" ]] && PY=.venv/bin/python

check() {
  command -v python3 >/dev/null || { echo "  python3가 없어요 (3.11 이상)"; exit 1; }
  if [[ "${JUDGE_BACKEND:-claude-cli}" == "api" ]]; then
    [[ -n "${ANTHROPIC_API_KEY:-}" ]] || grep -q '^ANTHROPIC_API_KEY=.' .env 2>/dev/null \
      || { echo "  ANTHROPIC_API_KEY가 없어요 (.env.example 참고)"; exit 1; }
  else
    command -v claude >/dev/null || { echo "  claude 명령이 없어요 — Claude Code에 로그인하거나 JUDGE_BACKEND=api 로 실행하세요"; exit 1; }
  fi
}

title() {
  echo ""
  echo "  $1"
  echo "  ━━━━━━━━━━━━━━━━━━━━"
  echo "  모델 ${JUDGE_MODEL:-claude-haiku-5-5} · 호출 ${JUDGE_BACKEND:-claude-cli} · 동시 ${WORKERS}개 · 듣기 검사 ${JUDGE_LISTEN:-0}"
  echo ""
}

case "$CMD" in
  one)
    FILE="${ARG:-data/scripts/blog-04-g1.json}"
    [[ -f "$FILE" ]] || { echo "  대본 파일이 없어요: $FILE"; exit 1; }
    check
    title "대본 하나 판정 — $FILE"
    $PY -m judge "$FILE"
    ;;

  dev)
    OUT="${ARG:-results/latest}"
    check
    title "개발용 대본 판정 → $OUT"
    $PY -m judge.run_all --out "$OUT" --set dev --workers "$WORKERS" || exit 1
    echo ""
    python3 tools/evaluate.py "$OUT"
    ;;

  test)
    OUT="${ARG:-results/latest-test}"
    check
    title "시험용 대본 판정 → $OUT"
    $PY -m judge.run_all --out "$OUT" --set test --workers "$WORKERS" || exit 1
    echo ""
    python3 tools/evaluate.py "$OUT" --set test
    ;;

  eval)
    OUT="${ARG:-results/latest}"
    [[ -f "$OUT/summary.csv" ]] || { echo "  결과가 없어요: $OUT/summary.csv"; exit 1; }
    SET=dev; [[ "$OUT" == *test* ]] && SET=test
    echo ""
    python3 tools/evaluate.py "$OUT" --set "$SET"
    ;;

  labels)
    echo ""
    python3 tools/consensus.py
    ;;

  web)
    if [[ ! -f web/dist/index.html ]]; then
      echo "  화면이 아직 빌드되지 않았어요. 한 번 빌드해 주세요 (Node.js 20 이상):"
      echo "    cd web && npm install && npm run build"
      exit 1
    fi
    title "화면과 판정 서버 — 끄려면 Ctrl+C"
    if [[ -n "$ARG" ]]; then $PY -m judge.serve --port "$ARG"; else $PY -m judge.serve; fi
    ;;

  "")
    echo ""
    echo "  쇼더스 대본 판정기"
    echo "  ━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "  1. one     — 대본 하나 판정"
    echo "  2. dev     — 개발용 대본 판정하고 합의와 견주기"
    echo "  3. test    — 시험용 대본 판정하고 합의와 견주기"
    echo "  4. eval    — 저장한 결과를 합의와 견주기"
    echo "  5. labels  — 채점자 합의 다시 계산"
    echo "  6. web     — 화면과 판정 서버 띄우기"
    echo ""
    echo -n "  번호: "
    read -r MENU
    case "$MENU" in
      1|one)    exec "$0" one ;;
      2|dev)    exec "$0" dev ;;
      3|test)   exec "$0" test ;;
      4|eval)   exec "$0" eval ;;
      5|labels) exec "$0" labels ;;
      6|web)    exec "$0" web ;;
      *) echo "  잘못된 선택."; exit 1 ;;
    esac
    ;;

  *)
    echo ""
    echo "  알 수 없는 명령: $CMD"
    echo "  사용법: ./judge.sh [one [대본]|dev [폴더]|test [폴더]|eval [폴더]|labels|web [포트]]"
    exit 1
    ;;
esac
