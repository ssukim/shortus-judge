"""판정 서버. 표준 라이브러리(http.server)만 쓴다. 빌드한 화면(web/dist)도 같이 내준다.

  python3 -m judge.serve [--port 8787] [--host 127.0.0.1]      (./judge.sh web 도 같음)
  http://127.0.0.1:8787     화면 (web/dist)
  GET  /api/judge           판정 서버가 있는지와 새로 판정할 수 있는지 {"judge": true, "ready", "model", "criteria"}
  POST /api/judge           판정. 본문 {"source": 넣은 글, "scenes": [{"text": 장면 문장, "sec": 쇼더스 예상 초(없어도 됨)}]}
                            → judge/view.py의 to_view 모양에 "input", "request_id"를 더한 것. 한 번에 받는 응답(JSON)만 낸다
                            Accept: application/x-ndjson이면 한 요청 안에서 줄 단위 JSON으로 흘려보낸다(아래 STREAM)
  GET  /api/fresh           {"fresh": true, "ready": 쇼더스 키가 있고 판정할 수 있는지}
  POST /api/fresh           쇼더스에서 새 대본 받기. {"step": "start", "source_id" | "text"} / {"step": "poll", "script_id"} (judge/fresh.py)
  GET  /api/tts             {"tts": true, "ready": 쇼더스 키(SHORTUS_API_KEY)가 있는지}
  POST /api/tts             본문 {"text"} → 쇼더스 목소리 미리 듣기(크레딧 0)로 받은 WAV. judge/listen.py의 tts(같은 문장은 한 번만 받음)

모델 호출 경로는 판정기와 같다(JUDGE_BACKEND, judge/backends.py). 판정 한 번은 대본 하나에 약 30초, 약 $0.01이고, 보류·탈락이면 고쳐 다시 판정(judge/revise.py)까지 약 1분이 걸린다(결론은 흘려보내기로 먼저 낸다).
판정할 수 없어도(claude 명령이나 키가 없음) 서버는 뜨고, 화면은 저장해 둔 결과를 보여 준다. 판정 요청에만 503으로 답한다.
쇼더스에서 새 대본 받기(/api/fresh)는 쇼더스 하루 한도를 쓰므로 이 서버도 하루 FRESH_DAILY_LIMIT번(기본 20)까지만 보낸다.
화면을 npm run dev로 따로 띄우면 출처가 달라지므로 JUDGE_ALLOW_ORIGINS=http://localhost:5173 을 같이 준다.
Host 머리글이 이 컴퓨터 주소(127.0.0.1·localhost·[::1]와 띄운 포트)가 아니면 403으로 막는다(DNS 재바인딩 방어).
다른 이름으로 열어야 하면 JUDGE_ALLOWED_HOSTS=이름:포트 를 준다.
"""
import argparse
import datetime as dt
import json
import mimetypes
import os
import re
import shutil
import socket
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

import queue

from . import backends, config, core, fresh, listen, view

DIST = config.ROOT / "web" / "dist"
PATH_JUDGE = "/api/judge"
PATH_TTS = "/api/tts"
PATH_FRESH = "/api/fresh"

# ---- 흘려보내기 (STREAM) ----
# 판정 요청에 Accept: application/x-ndjson이 있으면 한 요청 안에서 줄 단위 JSON으로 답한다.
#   {"type": "criterion", "n": 기준 번호, "result": 그 기준의 결과(judge/view.py의 criterion_view)}   기준 하나가 끝날 때마다
#   {"type": "judged", "body": 원래 대본의 결과}   기준 10개가 끝났을 때(고치기 전). 결정(decision)과 고친 대본은 비워 둔다.
#                                                     화면은 이 결론을 먼저 보이고 고친 대본은 done에서 이어 붙인다
#   {"type": "step", "text": 단계 글}   보류·탈락 뒤 고친 대본 만들기, 다시 판정하기를 시작할 때 (judge/revise.py)
#   {"type": "done", "status": 200, "body": 한 번에 받는 응답과 같은 본문}   마지막 한 줄
STREAM_TYPE = "application/x-ndjson"
NO_DIST = "화면이 아직 빌드되지 않았습니다. web 폴더에서 npm install, npm run build를 한 번 실행해 주세요."

# ---- 입력 한도 ----
SOURCE_MAX_CHARS = 20_000
SCENES_MAX = 12
SCENE_MAX_CHARS = 300
SCENE_SEC_MAX = 60                # 적어 보낸 장면 초의 위쪽 끝. 이보다 크면 잘못 적은 것으로 본다(가정값)
BODY_MAX_BYTES = 128 * 1024       # 글 20,000자(한글 3바이트) + 장면 12개 x 300자가 들어가는 크기
TTS_TEXT_MAX = SCENE_MAX_CHARS
READ_TIMEOUT_SEC = 15             # 요청 하나에서 소켓을 기다리는 상한(가정값)

# 초가 없는 장면의 쇼더스 예상 초 어림: 대본 98개 장면 480개에서 예상 초 합 / 글자 수(띄어쓰기 포함) 합 = 0.1764초,
# 장면당 평균 오차 0.28초. 이 값으로 어림한 초에도 기준 7은 0.87(config.READ_RATIO)을 곱한다.
SEC_PER_CHAR = 0.1764

# ---- 호출 한도 (메모리에 셈) ----
PER_MINUTE = int(os.environ.get("JUDGE_PER_MINUTE", "5"))          # 같은 주소에서 1분에 받는 판정 수
MAX_CONCURRENT = int(os.environ.get("JUDGE_MAX_CONCURRENT", "2"))  # 동시에 하는 판정 수. 넘으면 429
_slots = threading.BoundedSemaphore(MAX_CONCURRENT)
_recent, _recent_lock = {}, threading.Lock()


class InputError(Exception):
    pass


def judge_ready():
    """새로 판정할 수 있는지. claude-cli는 claude 명령을, api는 키를 찾는다. 키 값은 밖으로 내지 않는다."""
    if config.BACKEND == "api":
        try:
            backends._api_key()
            return True
        except backends.CallFailed:
            return False
    return shutil.which(config.CLI_COMMAND) is not None


def tts_ready():
    return bool(listen._key())


def _minute_ok(ip):
    now = time.monotonic()
    with _recent_lock:
        q = [t for t in _recent.get(ip, []) if now - t < 60]
        if len(q) >= PER_MINUTE:
            _recent[ip] = q
            return False
        _recent[ip] = q + [now]
        return True


def parse_payload(payload):
    """→ (넣은 글, 대본 사전(judge_script가 받는 꼴), 초를 어림한 장면 번호)"""
    if not isinstance(payload, dict):
        raise InputError("요청 모양이 맞지 않습니다. source와 scenes를 담은 JSON을 보내 주세요.")
    source = payload.get("source")
    if not isinstance(source, str) or not source.strip():
        raise InputError("넣은 글이 비어 있습니다. 대본의 사실을 넣은 글과 견주므로 넣은 글이 있어야 합니다.")
    source = source.strip()
    if len(source) > SOURCE_MAX_CHARS:
        raise InputError(f"넣은 글이 {len(source):,}자입니다. {SOURCE_MAX_CHARS:,}자 이하로 줄여 주세요.")
    scenes = payload.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        raise InputError("대본이 비어 있습니다. 장면을 하나 이상 넣어 주세요.")
    if len(scenes) > SCENES_MAX:
        raise InputError(f"장면이 {len(scenes)}개입니다. {SCENES_MAX}개 이하로 넣어 주세요.")
    sections, estimated = [], []
    for i, sc in enumerate(scenes, 1):
        if not isinstance(sc, dict) or not isinstance(sc.get("text"), str) or not sc["text"].strip():
            raise InputError(f"{i}번 장면에 문장이 없습니다.")
        text = sc["text"].strip()
        if len(text) > SCENE_MAX_CHARS:
            raise InputError(f"{i}번 장면이 {len(text)}자입니다. 장면 하나는 {SCENE_MAX_CHARS}자 이하로 넣어 주세요.")
        sec = sc.get("sec")
        if sec is None:
            estimated.append(i)
            sec = round(len(text) * SEC_PER_CHAR, 1)
        elif isinstance(sec, bool) or not isinstance(sec, (int, float)) or not 0 < sec <= SCENE_SEC_MAX:
            raise InputError(f"{i}번 장면의 초가 맞지 않습니다. 0보다 크고 {SCENE_SEC_MAX} 이하인 숫자로 적어 주세요.")
        sections.append({"role": "", "text": text, "estimated_sec": float(sec)})
    sid = payload.get("script_id") if isinstance(payload.get("script_id"), str) else None
    d = {"id": (sid or "web")[:60], "source_id": "", "script": {"sections": sections}}
    return source, d, estimated


def _with_input(out, d, estimated):
    out["input"] = {"sec_estimated_scenes": estimated,
                    "scenes": [{"n": i, "text": s["text"], "sec": s["estimated_sec"]}
                               for i, s in enumerate(d["script"]["sections"], 1)]}
    return out


def judge_payload(payload, on_criterion=None, on_step=None, on_judged=None):
    """판정 요청 본문 하나 → 화면이 읽는 결과. 입력이 틀리면 InputError.
    on_criterion(번호, 화면 기준 결과), on_step(글), on_judged(고치기 전 결과): 흘려보낼 때(STREAM)."""
    source, d, estimated = parse_payload(payload)
    scenes = d["script"]["sections"]
    tell = (lambda n, c: on_criterion(n, view.criterion_view(n, c, scenes))) if on_criterion else None
    now = lambda: dt.datetime.now().astimezone().isoformat(timespec="seconds")

    def judged(r):   # 고치기 전 결론: 고칠 것이 있으면(보류·탈락) 결정과 고친 대본은 아직 비워 둔다
        if not on_judged:
            return
        out = view.to_view(r, judged_at=now())
        if r["verdict"] != config.PASS:
            out.update(decision=None, revision=None)
        on_judged(_with_input(out, d, estimated))
    r = core.judge_script(d, source, on_criterion=tell, on_step=on_step, on_judged=judged)
    return _with_input(view.to_view(r, judged_at=now()), d, estimated)


class Handler(BaseHTTPRequestHandler):
    timeout = READ_TIMEOUT_SEC
    server_version = "judge"
    sys_version = ""

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (socket.timeout, TimeoutError, ConnectionError):
            self.close_connection = True

    def _route(self):
        try:
            return unquote(self.path.split("?")[0].split("#")[0]).rstrip("/") or "/"
        except Exception:  # noqa: BLE001  이상한 경로
            return "/\0"

    def _allowed_hosts(self):
        """받는 Host 머리글. DNS 재바인딩(다른 사이트가 자기 도메인을 127.0.0.1로 돌려 이 서버에 판정·소리 요청을 보내
        비용을 쓰게 하는 것)을 막으려고, 이 컴퓨터 주소와 띄운 포트, JUDGE_ALLOWED_HOSTS로 준 호스트만 받는다."""
        bound_host, port = self.server.server_address[:2]
        names = {"127.0.0.1", "localhost", "[::1]"}
        if bound_host not in ("0.0.0.0", "::", ""):
            names.add(bound_host if ":" not in bound_host else f"[{bound_host}]")
        hosts = {f"{h}:{port}" for h in names}
        hosts |= {h.strip().lower() for h in os.environ.get("JUDGE_ALLOWED_HOSTS", "").split(",") if h.strip()}
        return hosts

    def _origin_ok(self):
        """Host가 허용 목록에 있고, Origin이 있으면 그 Host와 같거나 JUDGE_ALLOW_ORIGINS에 있어야 한다."""
        hosts = self._allowed_hosts()
        host = (self.headers.get("Host") or "").strip().lower()
        if host not in hosts:
            return False
        origin = (self.headers.get("Origin") or "").strip()
        if not origin or origin == "null" and self.command in ("GET", "HEAD"):
            return True
        allow = {o.strip() for o in os.environ.get("JUDGE_ALLOW_ORIGINS", "").split(",") if o.strip()}
        return origin in allow or origin.lower() in {f"http://{h}" for h in hosts}

    def _cors(self):
        allow = [o.strip() for o in os.environ.get("JUDGE_ALLOW_ORIGINS", "").split(",") if o.strip()]
        origin = self.headers.get("Origin")
        if origin and origin in allow:
            return {"Access-Control-Allow-Origin": origin, "Vary": "Origin", "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type"}
        return {}

    def _send(self, status, body, ctype="application/json; charset=utf-8", cache="no-store"):
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache)
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in self._cors().items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def _body(self, limit):
        """JSON 본문 → (사전, None) 또는 (None, (상태, 오류 본문))"""
        ctype = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        if ctype != "application/json":    # 다른 사이트가 사전 확인 없는 POST로 판정(비용)을 부르지 못하게
            return None, (415, {"error": "Content-Type: application/json으로 보내 주세요."})
        n = self.headers.get("Content-Length") or ""
        n = int(n) if n.isdigit() else 0
        if n > limit:
            return None, (413, {"error": "요청이 너무 큽니다."})
        try:
            return json.loads(self.rfile.read(n) or b"null"), None
        except (UnicodeDecodeError, ValueError, RecursionError):
            return None, (400, {"error": "요청을 읽지 못했습니다. JSON으로 보내 주세요."})

    def do_OPTIONS(self):
        if not self._origin_ok():
            return self._send(403, {"error": "이 주소로는 받지 않습니다. http://127.0.0.1:<포트>로 열어 주세요."})
        self._send(204, b"", ctype="text/plain")

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        if not self._origin_ok():
            return self._send(403, {"error": "이 주소로는 받지 않습니다. http://127.0.0.1:<포트>로 열어 주세요."})
        route = self._route()
        if route == PATH_JUDGE:
            return self._send(200, {"judge": True, "ready": judge_ready(), "model": config.MODEL,
                                    "backend": config.BACKEND, "criteria": view.criteria_meta(), "stream": STREAM_TYPE})
        if route == PATH_FRESH:
            return self._send(200, {"fresh": True, "ready": judge_ready() and fresh.ready()})
        if route == PATH_TTS:
            return self._send(200, {"tts": True, "ready": tts_ready()})
        if route.startswith("/api/"):
            return self._send(404, {"error": "없는 주소입니다."})
        self._static(route)

    def _static(self, route):
        rel = route.lstrip("/") or "index.html"
        parts = [x for x in re.split(r"[\\/]", rel) if x]
        if "\0" in rel or any(x.startswith(".") for x in parts):   # .git, .env, .. 같은 경로는 내주지 않음
            return self._send(404, {"error": "없는 주소입니다."})
        target = (DIST / rel).resolve()
        if not (DIST / "index.html").is_file():
            return self._send(404, NO_DIST.encode("utf-8"), ctype="text/plain; charset=utf-8")
        if not target.is_relative_to(DIST.resolve()) or not target.is_file():
            return self._send(404, {"error": "없는 주소입니다."})
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript", "application/json"):
            ctype += "; charset=utf-8"
        self._send(200, target.read_bytes(), ctype=ctype, cache="no-cache")

    def do_POST(self):
        if not self._origin_ok():
            return self._send(403, {"error": "이 주소로는 받지 않습니다. http://127.0.0.1:<포트>로 열어 주세요."})
        route = self._route()
        try:
            if route == PATH_JUDGE:
                return self._judge()
            if route == PATH_TTS:
                return self._tts()
            if route == PATH_FRESH:
                return self._fresh()
            self._send(404, {"error": "없는 주소입니다."})
        except (socket.timeout, TimeoutError, ConnectionError):
            self.close_connection = True

    def _judge(self):
        payload, err = self._body(BODY_MAX_BYTES)
        if err:
            return self._send(*err)
        try:
            parse_payload(payload)
        except InputError as e:
            return self._send(400, {"error": str(e)})
        if not judge_ready():
            return self._send(503, {"error": "지금은 새로 판정할 수 없습니다. 저장해 둔 결과는 볼 수 있습니다."})
        if not _minute_ok(self.client_address[0]):
            return self._send(429, {"error": f"요청이 많습니다. 1분에 {PER_MINUTE}번까지 받습니다. 1분 뒤에 다시 눌러 주세요."})
        if not _slots.acquire(blocking=False):
            return self._send(429, {"error": "지금 판정하는 대본이 많습니다. 잠시 뒤 다시 눌러 주세요."})
        try:
            if STREAM_TYPE in (self.headers.get("Accept") or ""):
                return self._judge_stream(payload)
            out = judge_payload(payload)
        except Exception as e:  # noqa: BLE001  글은 밖으로 내지 않고 서버 창에만 남긴다
            self.log_error("판정 실패: %r", e)
            return self._send(500, {"error": "판정에 실패했습니다. 잠시 뒤 다시 눌러 주세요."})
        finally:
            _slots.release()
        out["request_id"] = uuid.uuid4().hex[:12]
        self._send(200, out)

    def _fresh(self):
        payload, err = self._body(64 * 1024)
        if err:
            return self._send(*err)
        if not judge_ready():
            return self._send(503, {"error": fresh.FAIL})
        self._send(*fresh.handle(payload, self.client_address[0]))

    def _judge_stream(self, payload):
        """판정을 일꾼 스레드에서 돌리고, 기준 하나·단계 하나가 끝날 때마다 이 스레드에서 한 줄씩 써 보낸다."""
        q = queue.Queue()

        def work():
            try:
                q.put(("done", 200, judge_payload(payload, on_criterion=lambda n, c: q.put(("criterion", n, c)),
                                                  on_step=lambda text: q.put(("step", text)),
                                                  on_judged=lambda body: q.put(("judged", body)))))
            except Exception as e:  # noqa: BLE001  글은 밖으로 내지 않고 서버 창에만 남긴다
                self.log_error("판정 실패: %r", e)
                q.put(("done", 500, {"error": "판정에 실패했습니다. 잠시 뒤 다시 눌러 주세요."}))

        threading.Thread(target=work, daemon=True).start()
        self.send_response(200)
        self.send_header("Content-Type", STREAM_TYPE + "; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        for k, v in self._cors().items():
            self.send_header(k, v)
        self.end_headers()
        self.close_connection = True
        gone = False
        while True:
            item = q.get()
            if item[0] == "criterion":
                obj = {"type": "criterion", "n": item[1], "result": item[2]}
            elif item[0] == "step":
                obj = {"type": "step", "text": item[1]}
            elif item[0] == "judged":
                obj = {"type": "judged", "body": item[1]}
            else:
                body = item[2] if item[1] != 200 else {**item[2], "request_id": uuid.uuid4().hex[:12]}
                obj = {"type": "done", "status": item[1], "body": body}
            if not gone:
                try:
                    self.wfile.write((json.dumps(obj, ensure_ascii=False) + "\n").encode("utf-8"))
                    self.wfile.flush()
                except OSError:   # 화면이 연결을 끊음. 판정은 끝까지 돈다
                    gone = True
            if item[0] == "done":
                return

    def _tts(self):
        payload, err = self._body(4096)
        if err:
            return self._send(*err)
        text = payload.get("text") if isinstance(payload, dict) else None
        if not isinstance(text, str) or not text.strip() or len(text) > TTS_TEXT_MAX:
            return self._send(400, {"error": f"장면 문장을 {TTS_TEXT_MAX}자 이하로 보내 주세요."})
        if not tts_ready():
            return self._send(503, {"error": "지금은 소리를 받을 수 없습니다."})
        try:
            wav = listen.tts(text.strip()).read_bytes()
        except RuntimeError as e:
            self.log_error("미리 듣기 실패: %s", e)
            return self._send(502, {"error": "소리를 받지 못했습니다."})
        self._send(200, wav, ctype="audio/wav", cache="private, max-age=3600")


def main():
    ap = argparse.ArgumentParser(prog="python -m judge.serve", description="판정 서버와 화면을 띄웁니다.")
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--host", default="127.0.0.1")
    a = ap.parse_args()
    server = ThreadingHTTPServer((a.host, a.port), Handler)
    print(f"화면: http://{a.host}:{a.port}" + ("" if (DIST / "index.html").is_file() else f"  ({NO_DIST})"), flush=True)
    print(f"판정: POST {PATH_JUDGE} · 모델 {config.MODEL} · 호출 {config.BACKEND} · "
          + ("판정 가능" if judge_ready() else "판정 못 함(claude 명령이나 키가 없음), 저장해 둔 결과만")
          + f" · 1분 {PER_MINUTE}번, 동시에 {MAX_CONCURRENT}건", flush=True)
    print(f"새 대본: POST {PATH_FRESH} · " + (f"쇼더스에서 받기(하루 {fresh.DAILY_LIMIT}번까지)" if fresh.ready() else "SHORTUS_API_KEY가 없어 끔"), flush=True)
    print(f"소리: POST {PATH_TTS} · " + ("쇼더스 미리 듣기(크레딧 0)" if tts_ready() else "SHORTUS_API_KEY가 없어 끔"), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
