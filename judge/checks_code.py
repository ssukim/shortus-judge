"""코드가 보는 기준: 5(표기), 7(길이)."""
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
                findings.append({"scene": n, "quote": w, "reason": f"잘못 읽는 표기 — {rule}"})
        for rule, pat in VAGUE_RULES:
            for w in _words_with(text, pat):
                if w in taken:
                    continue
                vague.append({"scene": n, "quote": w, "reason": f"애매한 표기 — {rule}"})
    return {"result": config.HIT if findings else config.OK, "findings": findings, "vague": vague}


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
