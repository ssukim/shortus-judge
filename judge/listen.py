"""듣기 검사(기준 5 보강, 켰을 때만): 숫자가 든 장면을 쇼더스 목소리로 읽혀 받아쓰고, 숫자가 다르게 들리는지 본다.

    JUDGE_LISTEN=1 .venv/bin/python -m judge data/scripts/<id>.json

- 소리는 쇼더스 「목소리 미리 듣기」(POST /v1/tts/preview)로 받는다. 크레딧이 들지 않는다. audio/listen/에 모아 두고 다시 받지 않는다.
- 받아쓰기는 이 컴퓨터의 whisper(mlx_whisper)로 한다. 없으면 검사를 건너뛰고 그렇다고 적는다.
- 읽히는 문장은 고친 대본(표기를 바꾼 뒤)이다. 렌더링에 들어갈 문장을 들어야 하기 때문이다.
- 받아쓰기는 틀린 발음도 맞는 글자로 옮길 수 있어, 「숫자가 같게 들림」이 바르게 읽었다는 보장은 아니다.
  「다르게 들림」만 건다(예: 61만 → 62만, D6).
"""
import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request

from . import config

BASE_URL = "https://shortus.viewus.co.kr"
VOICE = {"provider": "internal", "model": "supertonic-3", "voice": "F1",
         "speed": 1.1, "language": "ko", "normalize_numbers": False}   # tools/listen_sheet.py와 같은 목소리
ASR_MODEL = "mlx-community/whisper-large-v3-turbo"
AUDIO = config.ROOT / "audio" / "listen"
GAP_SEC = 3.5   # 미리 듣기 호출 사이 간격(1분에 20번을 넘지 않게)

BIG = {"만": 10_000, "억": 100_000_000, "조": 1_000_000_000_000}
NUM = re.compile(r"(?:\d[\d,]*(?:\.\d+)?\s*[천만억조]?\s*|[천만억조]\s*)+")
PART = re.compile(r"(\d[\d,]*(?:\.\d+)?)?\s*([천만억조]?)")
_last_call = [0.0]
_LOCK = threading.Lock()   # run_all이 대본 여러 개를 동시에 판정해도 호출 간격과 캐시 파일을 지킴


def values(s):
    """글에 든 수를 값으로 모은다. 「3만 5,000」, 「3만 5천」, 「35000」은 모두 35000. (tools/transcribe.py와 같음)"""
    out = set()
    for m in NUM.finditer(s):
        if not re.search(r"\d", m.group(0)):
            continue
        total = small = 0.0
        for num, unit in PART.findall(m.group(0)):
            if not num and not unit:
                continue
            n = float(num.replace(",", "")) if num else (1.0 if unit == "천" else 0.0)
            if unit == "천":
                small += n * 1000
            elif unit in BIG:
                total += (small + n) * BIG[unit]
                small = 0.0
            else:
                small += n
        out.add(total + small)
    return out


_SINO_D = {"영": 0, "공": 0, "일": 1, "이": 2, "삼": 3, "사": 4, "오": 5, "육": 6, "칠": 7, "팔": 8, "구": 9}
_SINO_U = {"십": 10, "백": 100, "천": 1000}
_NATIVE_ONES = {"한": 1, "하나": 1, "두": 2, "둘": 2, "세": 3, "셋": 3, "네": 4, "넷": 4, "다섯": 5, "여섯": 6,
                "일곱": 7, "여덟": 8, "아홉": 9}
_NATIVE_TENS = {"열": 10, "스무": 20, "스물": 20, "서른": 30, "마흔": 40, "쉰": 50, "예순": 60, "일흔": 70,
                "여든": 80, "아흔": 90}


def _sino_int(w):
    """「육십일」 → 61, 「삼천칠백」 → 3700, 「천이백」 → 1200(만·억 없이)."""
    total, d = 0, None
    for ch in w:
        if ch in _SINO_D:
            d = _SINO_D[ch]
        elif ch in _SINO_U:
            total += (1 if d is None else d) * _SINO_U[ch]
            d = None
    return total + (d or 0)


SINO_NUM = re.compile(r"[영공일이삼사오육칠팔구십백천만억]+(?:\s?[일이삼사오육칠팔구십백천]+)*(?:\s?점\s?[영공일이삼사오육칠팔구]+)?")
NATIVE_NUM = re.compile("(" + "|".join(_NATIVE_TENS) + ")?(" + "|".join(sorted(_NATIVE_ONES, key=len, reverse=True))
                        + r")?\s?(?:개|가지|명|시|배|박스|잔|병|장|살|번|포|마리|그릇)(\s?반)?")


def hangul_values(s):
    """받아쓴 글에 한글로 적힌 수(「육십일만」, 「두 배」, 「한 개 반」)를 값으로. 흔한 낱말과 헷갈리지 않게,
    한자어는 십·백·천·만·억·점이 든 것만, 고유어는 단위 앞에 온 것만 읽는다."""
    out = set()
    for m in SINO_NUM.finditer(s):
        w = m.group(0).replace(" ", "")
        if not re.search("[십백천만억점]", w):
            continue
        whole, _, frac = w.partition("점")
        total = small = 0
        for part in re.split("(만|억)", whole):
            if part in ("만", "억"):
                total += (small or 1) * (10 ** 4 if part == "만" else 10 ** 8)
                small = 0
            elif part:
                small = _sino_int(part)
        v = float(total + small)
        if frac:
            v += float("0." + "".join(str(_SINO_D[c]) for c in frac if c in _SINO_D))
        out.add(v)
    for m in re.finditer(r"(\d+)\s*(?:개|가지|명|시간|잔|병|장|포)\s*반", s):   # 받아쓰기가 「1개 반」처럼 옮긴 것
        out.add(int(m.group(1)) + 0.5)
    for m in NATIVE_NUM.finditer(s):
        if not (m.group(1) or m.group(2)):
            continue
        v = (_NATIVE_TENS.get(m.group(1), 0) if m.group(1) else 0) + (_NATIVE_ONES.get(m.group(2), 0) if m.group(2) else 0)
        out.add(v + (0.5 if m.group(3) else 0.0))
    return out


def _key():
    key = os.environ.get("SHORTUS_API_KEY", "").strip()
    env = config.ROOT / ".env"
    if not key and env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            name, _, value = line.partition("=")
            if name.strip() == "SHORTUS_API_KEY":
                key = value.strip().strip("'\"")
    return key


def tts(text):
    """문장 소리 파일 경로. 같은 문장은 한 번만 받는다."""
    with _LOCK:
        return _tts(text)


def _tts(text):
    AUDIO.mkdir(parents=True, exist_ok=True)
    path = AUDIO / (hashlib.sha1(text.encode("utf-8")).hexdigest()[:16] + ".wav")
    if path.exists():
        return path
    key = _key()
    if not key:
        raise RuntimeError("SHORTUS_API_KEY가 없음")
    wait = GAP_SEC - (time.monotonic() - _last_call[0])
    if wait > 0:
        time.sleep(wait)
    _last_call[0] = time.monotonic()
    req = urllib.request.Request(BASE_URL + "/v1/tts/preview", data=json.dumps({**VOICE, "text": text}).encode(),
                                 headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json",
                                          "Accept": "audio/wav"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            wav = r.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"미리 듣기 {e.code}") from None
    if wav[:4] != b"RIFF":
        raise RuntimeError("미리 듣기 응답이 WAV가 아님")
    path.write_bytes(wav)
    return path


def transcribe(path):
    with _LOCK:
        return _transcribe(path)


def _transcribe(path):
    cache_path = AUDIO / "asr.json"
    cache = json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {}
    if path.name not in cache:
        import mlx_whisper   # .venv에만 있음
        cache[path.name] = mlx_whisper.transcribe(str(path), path_or_hf_repo=ASR_MODEL, language="ko")["text"].strip()
        cache_path.write_text(json.dumps(cache, ensure_ascii=False, indent=1), encoding="utf-8")
    return cache[path.name]


def check(texts, originals=None):
    """texts: 렌더링에 들어갈 장면 문장들(고친 대본), originals: 원래 대본 문장들
    → {"findings": [...], "heard": {장면: 받아쓴 글}, "skipped": 까닭 또는 None}
    숫자는 원래 대본에서 뽑는다. 고친 대본은 숫자를 한글로 풀어 써서 숫자가 없을 수 있기 때문이다."""
    originals = originals or texts
    try:
        import mlx_whisper  # noqa: F401
    except ImportError:
        return {"findings": [], "heard": {}, "skipped": "받아쓰기 모델(mlx_whisper)이 없음 — .venv/bin/python으로 실행"}
    findings, heard = [], {}
    for n, (text, orig) in enumerate(zip(texts, originals), 1):
        want = values(orig.replace(",", "")) | values(text)
        if not want:
            continue
        try:
            got = transcribe(tts(text))
        except RuntimeError as e:
            return {"findings": findings, "heard": heard, "skipped": f"장면 {n}: {e}"}
        heard[n] = got
        loose = {float(x) for x in re.findall(r"\d+(?:\.\d+)?", got)}   # 「2, 3분」처럼 나눠 옮긴 숫자
        missing = sorted(want - values(got.replace(",", "")) - hangul_values(got) - loose)
        if missing:
            findings.append({"scene": n, "quote": text, "heard": got,
                             "reason": "들어 보니 숫자가 다르게 들림: 대본의 "
                                       + ", ".join(f"{v:g}" for v in missing) + "이(가) 받아쓴 글에 없음"})
    return {"findings": findings, "heard": heard, "skipped": None}
