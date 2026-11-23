#!/bin/zsh
# shortus-judge — 쇼더스 대본 판정기 실행
#
# 사용법:
#   ./run.sh                       선택 메뉴
#   ./run.sh judge [대본 파일]     대본 하나 판정 (기본: data/scripts/blog-04-g1.json)
#   ./run.sh all [결과 폴더]       개발용 22개 판정, 5개씩 동시에 (기본: results/latest)
#   ./run.sh test [결과 폴더]      시험용 10개 판정 (기본: results/latest-test)
#   ./run.sh eval [결과 폴더]      결과를 채점자 합의와 견줌 (기본: results/latest)
#   ./run.sh labels                채점자 세 명의 합의와 맞는 정도 다시 계산
#
# 모델 호출: 기본은 이 컴퓨터에 로그인한 Claude Code(claude 명령).
#           JUDGE_BACKEND=api 로 두면 .env의 ANTHROPIC_API_KEY로 부른다.
# 모델: 기본 claude-haiku-5-5. JUDGE_MODEL=claude-sonnet-5-5 로 바꿀 수 있다.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

ARG1="${1:-}"
shift 2>/dev/null
REMAINING_ARGS=("$@")

check() {
  command -v python3 >/dev/null || { echo "  python3가 없어요 (3.11 이상)"; exit 1; }
  if [[ "${JUDGE_BACKEND:-claude-cli}" == "api" ]]; then
    [[ -n "${ANTHROPIC_API_KEY:-}" ]] || grep -q '^ANTHROPIC_API_KEY=.' .env 2>/dev/null \
      || { echo "  ANTHROPIC_API_KEY가 없어요 (.env.example 참고)"; exit 1; }
  else
    command -v claude >/dev/null || { echo "  claude 명령이 없어요 — Claude Code를 설치하고 로그인하거나 JUDGE_BACKEND=api 로 실행하세요"; exit 1; }
  fi
}

title() {
  echo ""
  echo "  $1"
  echo "  ━━━━━━━━━━━━━━━━━━━━"
  echo "  모델 ${JUDGE_MODEL:-claude-haiku-5-5} · 호출 ${JUDGE_BACKEND:-claude-cli}"
  echo ""
}

case "$ARG1" in
  judge)
    FILE="${REMAINING_ARGS[1]:-data/scripts/blog-04-g1.json}"
    [[ -f "$FILE" ]] || { echo "  대본 파일이 없어요: $FILE"; exit 1; }
    check
    title "대본 하나 판정 — $FILE"
    python3 -m judge "$FILE"
    ;;

  all)
    OUT="${REMAINING_ARGS[1]:-results/latest}"
    check
    title "개발용 22개 판정 → $OUT"
    python3 -m judge.run_all --out "$OUT" --set dev --workers 5 || exit 1
    echo ""
    python3 tools/evaluate.py "$OUT"
    ;;

  test)
    OUT="${REMAINING_ARGS[1]:-results/latest-test}"
    check
    title "시험용 10개 판정 → $OUT"
    python3 -m judge.run_all --out "$OUT" --set test --workers 5 || exit 1
    echo ""
    python3 tools/evaluate.py "$OUT" --set test
    ;;

  eval)
    OUT="${REMAINING_ARGS[1]:-results/latest}"
    [[ -f "$OUT/summary.csv" ]] || { echo "  결과가 없어요: $OUT/summary.csv"; exit 1; }
    SET=dev; [[ "$OUT" == *test* ]] && SET=test
    echo ""
    python3 tools/evaluate.py "$OUT" --set "$SET"
    ;;

  labels)
    echo ""
    python3 tools/consensus.py
    ;;

  "")
    echo ""
    echo "  쇼더스 대본 판정기"
    echo "  ━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "  1. judge   — 대본 하나 판정"
    echo "  2. all     — 개발용 22개 판정하고 합의와 견주기"
    echo "  3. test    — 시험용 10개 판정하고 합의와 견주기"
    echo "  4. eval    — 저장한 결과를 합의와 견주기"
    echo "  5. labels  — 채점자 합의 다시 계산"
    echo ""
    echo -n "  번호: "
    read -r MENU

    case "$MENU" in
      1|judge)  exec "$0" judge ;;
      2|all)    exec "$0" all ;;
      3|test)   exec "$0" test ;;
      4|eval)   exec "$0" eval ;;
      5|labels) exec "$0" labels ;;
      *)
        echo "  잘못된 선택."
        exit 1
        ;;
    esac
    ;;

  *)
    echo ""
    echo "  알 수 없는 명령: $ARG1"
    echo "  사용법: ./run.sh [judge [대본]|all [폴더]|test [폴더]|eval [폴더]|labels]"
    exit 1
    ;;
esac
