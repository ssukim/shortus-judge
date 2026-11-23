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
    unfixable = [f["quote"] for f in findings if not f.get("fix") and pin_reading(f["quote"]) == f["quote"]]
    return {"result": config.HIT if findings else config.OK, "findings": findings, "vague": vague,
            "unfixable": unfixable}


def fix_script(sections, findings):
    """잘못 읽는 표기를 고치고(단위·쉼표·퍼센트) 위험한 숫자를 한글로 풀어 쓴 장면 문장들. 렌더링에는 이 문장을 쓴다."""
    texts = [s["text"] for s in sections]
    for f in findings:
        if f.get("fix") and f.get("scene"):
            texts[f["scene"] - 1] = texts[f["scene"] - 1].replace(f["quote"], f["fix"])
    return [pin_reading(t) for t in texts]


def fixable(word):
    """표기 하나를 자동으로 고칠 수 있나(단위 표기를 바꾸거나 한글로 풀어 쓸 수 있나)."""
    return bool(suggest(word)) or pin_reading(word) != word


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

# ── 발음 고정: 목소리가 읽을 때마다 다르게 읽은 숫자를 한글로 풀어 쓴다(D27) ──
# 쇼더스 목소리로 같은 문장을 네 번씩 읽혀 받아쓰니, 숫자로 쓴 「61만 원」 「8가지」 「1.5개」 등은 28번 중 10번 틀렸고
# 한글로 풀어 쓴 문장은 16번 모두 바르게 읽혔다. 위험이 드러난 세 갈래만 바꾼다. 날짜·「2박 3일」 같은 것은 그대로 둔다.
_SINO = "영일이삼사오육칠팔구"
_NATIVE = {1: "한", 2: "두", 3: "세", 4: "네", 5: "다섯", 6: "여섯", 7: "일곱", 8: "여덟", 9: "아홉", 10: "열",
           20: "스무", 30: "서른", 40: "마흔", 50: "쉰", 60: "예순", 70: "일흔", 80: "여든", 90: "아흔"}
_NATIVE_TENS = {10: "열", 20: "스물", 30: "서른", 40: "마흔", 50: "쉰", 60: "예순", 70: "일흔", 80: "여든", 90: "아흔"}
NATIVE_COUNTERS = ("가지", "개", "명", "마리", "잔", "병", "권", "벌", "켤레", "그릇", "봉지", "포", "장", "시간",
                   "시", "배", "박스", "살", "번째", "번")
# 한자어로 읽는 단위: 온도, 횟수, 미터법(단위 기호를 한글로 바꾼 뒤), 퍼센트
SINO_UNITS = ("도", "회", "킬로미터", "센티미터", "밀리미터", "미터", "킬로그램", "그램", "밀리리터", "리터",
              "킬로와트", "와트", "볼트", "암페어", "퍼센트", "기가", "기가바이트", "메가바이트", "파스칼", "데시벨",
              "칼로리", "킬로칼로리", "층", "분", "초", "주", "개월")   # 「년」은 날짜라 두지 않음


def sino(n):
    """정수를 한자어 수로: 610000 → 육십일만, 37000000 → 삼천칠백만."""
    if n == 0:
        return "영"
    out = ""
    for big, name in ((10 ** 12, "조"), (10 ** 8, "억"), (10 ** 4, "만"), (1, "")):
        part, n = divmod(n, big)
        if not part:
            continue
        words = ""
        for unit, uname in ((1000, "천"), (100, "백"), (10, "십"), (1, "")):
            d, part = divmod(part, unit)
            if d:
                words += ("" if d == 1 and unit > 1 else _SINO[d]) + uname
        out += words + name + (" " if name and n else "")
    return out.strip()


def native(n):
    """1~99를 고유어 수로(단위 앞 꼴): 8 → 여덟, 21 → 스물한."""
    tens, ones = divmod(n, 10)
    if not ones:
        return _NATIVE[n]
    return (_NATIVE_TENS[tens * 10] if tens else "") + _NATIVE[ones]


_UNIT = {"조": 10 ** 12, "억": 10 ** 8, "만": 10 ** 4, "천": 1000, "백": 100, "": 1}


def _amount(m):
    """「61만」 「3700만」 「2억 5000만」 「8만 9천」 → 값을 읽어 한자어로."""
    total = small = 0
    for num, unit in re.findall(r"(\d+)\s*(조|억|만|천|백)?", m.group(0)):
        if unit in ("조", "억", "만"):
            total += (small + int(num)) * _UNIT[unit]
            small = 0
        else:
            small += int(num) * _UNIT[unit]
    return sino(total + small)


AMOUNT = re.compile(r"\d+\s*(?:조|억|만)(?:\s*\d+\s*(?:억|만|천|백)?)*")
DECIMAL_COUNTER = re.compile(r"(\d+)\.5\s*(" + "|".join(NATIVE_COUNTERS) + r")(가|를|는|와|로)?")
_AFTER_BAN = {"가": "이", "를": "을", "는": "은", "와": "과", "로": "으로", None: ""}   # 「반」 뒤 조사
DECIMAL = re.compile(r"(\d+)\.(\d+)(?=\s*[가-힣])")
SMALL_COUNTER = re.compile(r"(?<![\d.,])(\d{1,2})\s*(" + "|".join(sorted(NATIVE_COUNTERS, key=len, reverse=True))
                           + r")(?!간|월)")   # 「시간」은 따로, 「개월」은 한자어
SINO_UNIT = re.compile(r"(?<![\d.,A-Za-z])(\d+)\s*(" + "|".join(sorted(SINO_UNITS, key=len, reverse=True)) + ")")
WON = re.compile(r"(?<![\d.,])(\d{4,})\s*(?=원)")


def pin_reading(text):
    """위험한 숫자를 한글로 풀어 쓴 문장. 바뀐 것이 없으면 그대로."""
    text = re.sub(r"(\d)\s?%", r"\1퍼센트", text)
    text = AMOUNT.sub(_amount, text)
    text = DECIMAL_COUNTER.sub(lambda m: f"{native(int(m.group(1)))} {m.group(2)} 반{_AFTER_BAN[m.group(3)]}"
                               if int(m.group(1)) < 100 else m.group(0), text)
    text = DECIMAL.sub(lambda m: f"{sino(int(m.group(1)))} 점 {''.join(_SINO[int(c)] for c in m.group(2))} ", text)
    text = re.sub(r" {2,}", " ", text)
    text = SMALL_COUNTER.sub(lambda m: f"{native(int(m.group(1)))} {m.group(2)}" if 0 < int(m.group(1)) < 100
                             else m.group(0), text)
    text = SINO_UNIT.sub(lambda m: f"{sino(int(m.group(1)))} {m.group(2)}", text)
    text = WON.sub(lambda m: sino(int(m.group(1))) + " ", text)
    return re.sub(r" {2,}", " ", text)

