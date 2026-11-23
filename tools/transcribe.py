"""장면 소리(audio/*.wav)를 받아쓰기 모델로 글자로 옮기고, 대본 문장의 표기와 견준다.

    .venv/bin/python tools/transcribe.py

쓰는 것: data/listen/heard-asr.csv (대본 id, 장면, 표기, 대본 문장, 받아쓴 글, 표기의 숫자가 받아쓴 글에 있는가)
받아쓰기는 틀린 발음도 맞는 글자로 옮길 수 있어(예: 「킬로」를 「kg」), 「있음」이 바르게 읽었다는 뜻은 아니다.
「없음」은 숫자가 다르게 들렸을 가능성이 크다는 뜻이다(예: 61만 → 62만).
"""

import csv
import json
import re
from pathlib import Path

import mlx_whisper

ROOT = Path(__file__).resolve().parent.parent
MODEL = "mlx-community/whisper-large-v3-turbo"
CACHE = ROOT / "audio" / "asr.json"


BIG = {"만": 10_000, "억": 100_000_000, "조": 1_000_000_000_000}
NUM = re.compile(r"(?:\d[\d,]*(?:\.\d+)?\s*[천만억조]?\s*|[천만억조]\s*)+")
PART = re.compile(r"(\d[\d,]*(?:\.\d+)?)?\s*([천만억조]?)")


def values(s: str) -> set[float]:
    """글에 든 수를 값으로 모은다. 「3만 5,000」, 「3만 5천」, 「35000」은 모두 35000."""
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


def digits(s: str) -> str:
    return re.sub(r"[^\d]", "", s)


def main() -> None:
    tokens = list(csv.DictReader((ROOT / "data/listen/tokens.csv").open()))
    texts = {}
    for p in (ROOT / "data/scripts").glob("*.json"):
        d = json.loads(p.read_text())
        for i, sec in enumerate(d["script"]["sections"], 1):
            texts[(d["id"], str(i))] = sec["text"].strip()

    cache = json.loads(CACHE.read_text()) if CACHE.exists() else {}
    for sid, scene in sorted({(t["대본 id"], t["장면"]) for t in tokens}):
        name = f"{sid}-s{scene}.wav"
        if name not in cache:
            r = mlx_whisper.transcribe(str(ROOT / "audio" / name), path_or_hf_repo=MODEL, language="ko")
            cache[name] = r["text"].strip()
            CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1))
            print(name, cache[name])

    out = []
    for t in tokens:
        heard = cache[f"{t['대본 id']}-s{t['장면']}.wav"]
        want = values(t["표기"])
        found = "있음" if want and want <= values(heard) else ("없음" if want else "-")
        out.append({**t, "대본 문장": texts[(t["대본 id"], t["장면"])], "받아쓴 글": heard, "숫자 일치": found})
    with (ROOT / "data/listen/heard-asr.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(out[0]))
        w.writeheader()
        w.writerows(out)
    miss = [o for o in out if o["숫자 일치"] == "없음"]
    print(f"표기 {len(out)}개 중 숫자가 받아쓴 글에 없는 것 {len(miss)}개")


if __name__ == "__main__":
    main()
