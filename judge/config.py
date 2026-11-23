"""판정기 설정. 값을 바꾸려면 이 파일이나 환경 변수를 고친다."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUBRIC = ROOT / "data" / "labels" / "rubric.md"
SCRIPTS = ROOT / "data" / "scripts"
SOURCES = ROOT / "data" / "sources"

# ---- 모델 ----
# 기본은 claude-haiku-5-5. 소넷은 JUDGE_MODEL=claude-sonnet-5-5로 고른다.
MODEL = os.environ.get("JUDGE_MODEL") or "claude-haiku-5-5"
# 생각 깊이. claude -p의 --effort, API의 output_config.effort에 같은 값을 보낸다 (가정값).
EFFORT = os.environ.get("JUDGE_EFFORT") or "medium"
MAX_TOKENS = 8000            # API 경로만. claude -p는 이 값을 받지 않는다.

# 100만 토큰당 달러. 출처: Anthropic API 단가표(claude-api 스킬에 실린 표, 2026-11-03 기준).
# Haiku 5.5 단가는 입력 10만 토큰 이하 기준(넘으면 0.50/2.50). 대본 한 편 입력은 1만 토큰 안팎이라 이하로 본다.
# claude -p는 지시문을 캐시 쓰기 토큰으로 센다. 캐시 쓰기는 입력 단가의 1.25배, 캐시 읽기는 0.1배로 센다
# (Anthropic 프롬프트 캐시 단가 규칙. Sonnet 5.5 캐시 읽기는 단가표상 $0.10=0.05배라 조금 위로 잡힌다).
CACHE_WRITE_RATIO = 1.25
CACHE_READ_RATIO = 0.1
PRICE_PER_MTOK = {
    "claude-sonnet-5-5": {"input": 2.00, "output": 10.00},
    "claude-haiku-5-5": {"input": 0.10, "output": 0.50},
}
if MODEL not in PRICE_PER_MTOK:
    raise SystemExit(f"JUDGE_MODEL={MODEL}: 단가가 없는 모델입니다 (judge/config.py PRICE_PER_MTOK)")

# ---- 호출 경로 ----
BACKEND = (os.environ.get("JUDGE_BACKEND") or "claude-cli").strip()
if BACKEND not in ("claude-cli", "api"):
    raise SystemExit(f"JUDGE_BACKEND={BACKEND}: claude-cli 또는 api만 됩니다")
CLI_COMMAND = "claude"
CLI_TIMEOUT_SEC = 300        # 프로세스 하나의 시간 초과 (가정값)
API_URL = "https://api.anthropic.com/v1/messages"
API_VERSION = "2023-06-01"
API_TIMEOUT_SEC = 300
JSON_RETRIES = 1             # 답이 JSON으로 안 읽히면 한 번 더 묻는다
SYSTEM_PROMPT = "사용자가 준 지시대로 대본을 검사하고, 지시한 꼴의 JSON 하나로만 답합니다."

# ---- 코드가 보는 기준 ----
READ_RATIO = 0.87            # 읽는 시간 = estimated_sec × 0.87 (기준표 「가정한 값」)
MAX_TOTAL_SEC = 45
MAX_SCENE_SEC = 10

# ---- 판정 ----
PASS, HOLD, FAIL = "통과", "보류", "탈락"
HIT, OK, UNKNOWN = "걸림", "안 걸림", "판정 못 함"

# 같은 묶음을 몇 번 물어 다수결로 정할지. 사실 묶음은 걸리면 탈락이 되는 기준 1·2가 있어
# 실행마다 흔들리는 것을 줄이려고 3번 묻는다(2판을 세 번 돌리니 22개 중 5개의 판정이 바뀜).
VOTES = {"fact": int(os.environ.get("JUDGE_FACT_VOTES", "3")), "flow": 1}
# 탈락 기준(1·2)은 여러 번 물은 답이 모두 걸림일 때만 건다. 과반이지만 갈렸으면 「탈락 의심」으로 두고 보류로 낸다(D15).
UNANIMOUS = ()  # 5판부터 비움(D19). 지시문이 「확실할 때만 기준 1」을 맡음

# 듣기 검사(judge/listen.py): JUDGE_LISTEN=1일 때만. 받아쓰기 모델이 .venv에 있어 .venv/bin/python으로 실행한다(D27).
LISTEN = os.environ.get("JUDGE_LISTEN", "") == "1"
