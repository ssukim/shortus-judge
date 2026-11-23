"""쇼더스에서 대본을 새로 받는다 (판정 서버의 POST /api/fresh, D36). 표준 라이브러리만 쓴다.

  {"step": "start", "source_id": 모아 둔 글 id}       또는 {"step": "start", "text": 붙여 넣은 글, "title"?}
      → {"source_id", "title", "text_source_id", "script_id", "send_sec", "poll_after_sec"}
  {"step": "poll", "script_id"}
      → {"done": false, "poll_after_sec"} 또는 {"done": true, "scenes": [{"text", "sec"}], "received_at", "raw"}

화면은 start → poll(여러 번) → POST /api/judge 순서로 불러 단계를 보여 준다. 쇼더스 쪽 대기 60초는 화면이 센다.
부르는 쇼더스 호출은 tools/collect.py와 같은 세 가지(POST text-sources, POST scripts, GET scripts/{id})이고 크레딧이 들지 않는다.
대본 만들기는 쇼더스 하루 한도(100번)를 쓰므로, 이 서버도 하루 DAILY_LIMIT번까지만 보낸다(메모리에 셈, 가정값).
"""
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request

from . import config, listen

BASE_URL = os.environ.get("SHORTUS_BASE_URL") or listen.BASE_URL   # 시험할 때만 바꾼다(가짜 쇼더스)
RUNNING = {"pending", "queued", "generating", "running", "processing"}
FAILED = {"failed", "error", "cancelled"}
POLL_DEFAULT_SEC = 3
HTTP_TIMEOUT_SEC = 20
FAIL = "지금은 새 대본을 받을 수 없습니다."
DAILY_FULL = "쇼더스의 오늘 대본 만들기 한도(100번)를 다 썼습니다. 한국 시각 자정에 풀립니다."

TEXT_MIN = 100                # 붙여 넣은 글 길이 (web/src/judgeClient.ts와 같은 값)
TEXT_MAX = 15_000
TITLE_MAX = 60
PER_MINUTE = int(os.environ.get("FRESH_PER_MINUTE", "2"))     # 같은 주소에서 1분에 (가정값)
DAILY_LIMIT = int(os.environ.get("FRESH_DAILY_LIMIT", "20"))  # 이 서버가 하루에 보내는 대본 만들기 수 (가정값)
SHOWN_FIELDS = ("id", "text_source_id", "status", "full_text", "estimated_duration_sec", "sections")
SHOWN_SECTION = ("role", "text", "estimated_sec", "reading")

_lock = threading.Lock()
_minute, _day = {}, {"date": "", "n": 0}
_issued = {}                  # 이 서버가 만든 쇼더스 대본 id → 만든 때. 조회는 이것만 받는다
_UUID = re.compile(r"^[0-9a-fA-F-]{8,64}$")


def ready():
    return bool(listen._key())


def source_ids():
    return sorted(p.stem for p in config.SOURCES.glob("*.txt"))


def _call(key, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Bearer {key}", "Accept": "application/json"}
    if data:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE_URL + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=HTTP_TIMEOUT_SEC) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _take(ip):
    now = time.monotonic()
    today = time.strftime("%Y-%m-%d")
    with _lock:
        hits = [t for t in _minute.get(ip, []) if now - t < 60]
        if len(hits) >= PER_MINUTE:
            return False
        if _day["date"] != today:
            _day.update(date=today, n=0)
        if _day["n"] >= DAILY_LIMIT:
            return False
        _minute[ip] = hits + [now]
        _day["n"] += 1
        return True


def _title(body):
    first = next((l.strip() for l in body.splitlines() if l.strip()), "")
    return first[:TITLE_MAX].rstrip()


def pasted(text, title=None):
    """붙여 넣은 글 → (오류 상태 또는 None, 제목 또는 오류 본문, 본문)"""
    if not isinstance(text, str) or (title is not None and not isinstance(title, str)):
        return 400, {"error": "요청 모양이 맞지 않습니다."}, None
    body = text.strip()
    if len(body) < TEXT_MIN:
        return 400, {"error": f"글이 너무 짧습니다. {TEXT_MIN}자 이상 넣어 주세요."}, None
    if len(body) > TEXT_MAX:
        return 400, {"error": f"글이 너무 깁니다. {TEXT_MAX:,}자 이하로 줄여 주세요."}, None
    return None, ((title or "").strip() or _title(body))[:TITLE_MAX], body


def start(source_id=None, ip="-", text=None, title=None):
    if text is not None:
        err, title, body = pasted(text, title)
        if err:
            return err, title
    elif source_id in source_ids():
        body = (config.SOURCES / f"{source_id}.txt").read_text(encoding="utf-8").strip()
        title = _title(body)
    else:
        return 400, {"error": "없는 글입니다."}
    key = listen._key()
    if not key:
        return 503, {"error": FAIL}
    if not _take(ip):
        return 429, {"error": "요청이 많아 " + FAIL}
    t0 = time.monotonic()
    try:
        ts = _call(key, "POST", "/v1/t2s/text-sources", {"title": title, "body": body, "language": "ko"})
        created = _call(key, "POST", "/v1/t2s/scripts", {"text_source_id": ts["id"]})
    except urllib.error.HTTPError as e:
        if e.code == 429:   # 쇼더스 하루 한도. 응답 글·키는 밖으로 내지 않는다
            return 429, {"error": DAILY_FULL}
        return 502, {"error": FAIL}
    except (urllib.error.URLError, TimeoutError, KeyError, ValueError, OSError):
        return 502, {"error": FAIL}   # 쇼더스 응답 글·키는 밖으로 내지 않는다
    with _lock:
        _issued[str(created["id"])] = time.monotonic()
    return 200, {"source_id": source_id if text is None else None, "title": title, "text_source_id": ts["id"],
                 "script_id": created["id"], "send_sec": round(time.monotonic() - t0, 1),
                 "poll_after_sec": POLL_DEFAULT_SEC}


def _shown(s):
    out = {k: s[k] for k in SHOWN_FIELDS if k in s and k != "sections"}
    out["sections"] = [{f: x[f] for f in SHOWN_SECTION if f in x} for x in s.get("sections") or [] if isinstance(x, dict)]
    return out


def poll(script_id, ip="-"):
    with _lock:
        known = isinstance(script_id, str) and _UUID.match(script_id) and \
            time.monotonic() - _issued.get(script_id, -1e9) < 3600
    if not known:
        return 400, {"error": "없는 대본입니다."}
    key = listen._key()
    if not key:
        return 503, {"error": FAIL}
    try:
        s = _call(key, "GET", f"/v1/t2s/scripts/{script_id}")
    except (urllib.error.URLError, TimeoutError, ValueError, OSError):
        return 502, {"error": FAIL}
    if s.get("status") in FAILED or s.get("error"):
        return 502, {"error": FAIL}
    if s.get("status") in RUNNING or s.get("poll_after_seconds") is not None:
        return 200, {"done": False, "poll_after_sec": s.get("poll_after_seconds") or POLL_DEFAULT_SEC}
    if not s.get("sections"):
        return 502, {"error": FAIL}
    return 200, {"done": True, "script_id": script_id, "text_source_id": s.get("text_source_id"),
                 "received_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                 "scenes": [{"text": x["text"], "sec": x.get("estimated_sec")} for x in s["sections"]],
                 "raw": _shown(s)}


def handle(payload, ip="-"):
    if not isinstance(payload, dict) or payload.get("step") not in ("start", "poll"):
        return 400, {"error": "step은 start 또는 poll로 보내 주세요."}
    if payload["step"] == "poll":
        return poll(payload.get("script_id"), ip)
    text, sid = payload.get("text"), payload.get("source_id")
    if text is not None and sid not in (None, ""):
        return 400, {"error": "글과 source_id 가운데 하나만 보내 주세요."}
    return start(sid, ip, text, payload.get("title"))
