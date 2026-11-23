#!/bin/zsh
# shortus-judge — Claude 세션 열기 (원격 접속 가능)
#
# 사용법:
#   ./run.sh                   선택 메뉴
#   ./run.sh chat              Claude 새 대화
#   ./run.sh resume [검색어]   이전 세션 이어서
#
# 판정은 ./judge.sh (대본 하나, 개발용·시험용 일괄 판정, 견주기, 합의 계산)

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

ARG1="${1:-}"
shift 2>/dev/null
REMAINING_ARGS=("$@")

case "$ARG1" in
  chat)
    echo ""
    echo "  Claude 새 대화 (원격 접속 가능, 권한 확인 없음)"
    echo "  ━━━━━━━━━━━━━━━━━━━━"
    echo ""
    caffeinate -i claude --remote-control "shortus-judge-chat" --dangerously-skip-permissions
    ;;

  resume)
    echo ""
    echo "  Claude 세션 이어서 (원격 접속 가능, 권한 확인 없음)"
    echo "  ━━━━━━━━━━━━━━━━━━━━"
    echo ""
    if [[ -n "${REMAINING_ARGS[1]:-}" ]]; then
      caffeinate -i claude --remote-control "shortus-judge-resume" --resume "${REMAINING_ARGS[1]}" --dangerously-skip-permissions
    else
      caffeinate -i claude --remote-control "shortus-judge-resume" --resume --dangerously-skip-permissions
    fi
    ;;

  "")
    echo ""
    echo "  쇼더스 대본 판정기"
    echo "  ━━━━━━━━━━━━━━━━━━━━"
    echo ""
    echo "  1. chat    — Claude 새 대화 (원격 접속)"
    echo "  2. resume  — Claude 세션 이어서 (원격 접속)"
    echo ""
    echo -n "  번호: "
    read -r MENU

    case "$MENU" in
      1|c|chat)   exec "$0" chat ;;
      2|r|resume) exec "$0" resume ;;
      *) echo "  잘못된 선택."; exit 1 ;;
    esac
    ;;

  *)
    echo ""
    echo "  알 수 없는 명령: $ARG1"
    echo "  사용법: ./run.sh [chat|resume [검색어]]"
    exit 1
    ;;
esac
