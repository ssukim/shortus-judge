"""코드가 보는 기준: 5(표기), 7(길이). 둘 다 진단만 내고, 표기는 고칠 표기를 함께 낸다."""
import re

from . import config

# 기준 5의 규칙 (data/listen/prefill.csv의 「규칙」 열과 같은 갈래)
#   잘못 읽음: 숫자 뒤 영문 단위 기호(5km, 600W, 4.5kg), 쉼표 든 숫자(31,200원, 3만 5,000원), 소수 퍼센트(2.5%)
#   애매: 영문 약어(KTX, AF-55), 범위 기호(2~3일)  → 걸지 않고 진단만
WRONG_RULES = [
    ("영문 단위 기호", re.compile(r"\d(?:[.,]\d+)*[A-Za-z]+")),
    ("쉼표 든 금액", re.compile(r"\d{1,3}(?:,\d{3})+")),
    ("소수 퍼센트", re.compile(r"\d+\.\d+\s?%")),
]
VAGUE_RULES = [
    ("범위 기호", re.compile(r"\d\s?~\s?\d")),
    ("영문 약어", re.compile(r"(?<![0-9A-Za-z.,])[A-Za-z][A-Za-z0-9-]*")),
]


UNIT_READ = {"km": "킬로미터", "cm": "센티미터", "mm": "밀리미터", "m": "미터", "kg": "킬로그램", "g": "그램",
             "ml": "밀리리터", "mL": "밀리리터", "L": "리터", "l": "리터", "kW": "킬로와트", "W": "와트",
             "GB": "기가바이트", "MB": "메가바이트", "TB": "테라바이트", "Pa": "파스칼", "dB": "데시벨", "kcal": "킬로칼로리",
             "V": "볼트", "A": "암페어", "Hz": "헤르츠", "mAh": "밀리암페어시", "Wh": "와트시"}


def _man(n):
    """정수를 「만」 단위로: 124020 → 「12만 4020」, 25900 → 「2만 5900」, 9000 → 「9000」."""
    man, rest = divmod(n, 10000)
    if not man:
        return str(rest)
    return f"{man}만" + (f" {rest}" if rest else "")


def suggest(word):
    """잘못 읽는 표기 하나를 목소리가 바로 읽는 표기로. 못 고치면 None."""
    out = re.sub(r"(\d+(?:\.\d+)?)\s?%", r"\1퍼센트", word)
    out = re.sub(r"\d{1,3}(?:,\d{3})+", lambda m: _man(int(m.group().replace(",", ""))), out)
    out = re.sub(r"(\d(?:\.\d+)?)([A-Za-z]+)",
                 lambda m: m.group(1) + UNIT_READ[m.group(2)] if m.group(2) in UNIT_READ else m.group(), out)
    return out if out != word else None


def _words_with(text, pat):
    """규칙에 걸린 낱말을 띄어쓰기 단위로 돌려준다(같은 낱말은 한 번)."""
    out = []
    for m in pat.finditer(text):
        s = text.rfind(" ", 0, m.start()) + 1
        e = text.find(" ", m.end())
        w = text[s:] if e < 0 else text[s:e]
        if w not in out:
            out.append(w)
    return out


def check_notation(sections):
    """기준 5. → {"result", "findings": [...], "vague": [...]}"""
    findings, vague = [], []
    for n, sec in enumerate(sections, 1):
        text = sec["text"]
        taken = set()
        for rule, pat in WRONG_RULES:
            for w in _words_with(text, pat):
                if w in taken:
                    continue
                taken.add(w)
                f = {"scene": n, "quote": w, "reason": f"잘못 읽는 표기 — {rule}"}
                if suggest(w):
                    f["fix"] = suggest(w)
                findings.append(f)
        for rule, pat in VAGUE_RULES:
            for w in _words_with(text, pat):
                if w in taken:
                    continue
                vague.append({"scene": n, "quote": w, "reason": f"애매한 표기 — {rule}"})
    unfixable = [f["quote"] for f in findings if not f.get("fix")]
    return {"result": config.HIT if findings else config.OK, "findings": findings, "vague": vague,
            "unfixable": unfixable}


def fix_script(sections, findings):
    """잘못 읽는 표기를 고친 표기로 바꾼 장면 문장들. 렌더링에는 이 문장을 쓴다."""
    texts = [s["text"] for s in sections]
    for f in findings:
        if f.get("fix") and f.get("scene"):
            texts[f["scene"] - 1] = texts[f["scene"] - 1].replace(f["quote"], f["fix"])
    return texts


def check_length(sections):
    """기준 7(진단만). → {"result", "findings", "total_sec"}"""
    r = config.READ_RATIO
    secs = [float(s.get("estimated_sec") or 0) * r for s in sections]
    total = sum(secs)
    findings = []
    if total > config.MAX_TOTAL_SEC:
        findings.append({"scene": None, "quote": "",
                         "reason": f"읽는 시간 {total:.1f}초 > {config.MAX_TOTAL_SEC}초 (예상 초 합 × {r})"})
    for n, s in enumerate(secs, 1):
        if s > config.MAX_SCENE_SEC:
            findings.append({"scene": n, "quote": sections[n - 1]["text"][:30],
                             "reason": f"장면 읽는 시간 {s:.1f}초 > {config.MAX_SCENE_SEC}초"})
    return {"result": config.HIT if findings else config.OK, "findings": findings, "total_sec": round(total, 1)}
