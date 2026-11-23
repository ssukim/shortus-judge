"""모델이 보는 기준: 1, 2, 3, 4, 6, 8, 9, 10.

호출은 대본 하나에 두 번이고, 둘을 동시에 보낸다.
  사실 묶음(기준 1·2·3·4)  넣은 글과 대본을 장면마다 대조한다. 장면마다 넣은 글의 근거 문장을 먼저 대게 한다.
  구성 묶음(기준 6·8·9·10) 대본을 말하기와 흐름으로 본다. 기준 8이 「넣은 글에 이유가 있는데도」를 따지므로
                           넣은 글도 함께 주되, 장면별 근거 문장은 받지 않는다.
모델은 기준마다 걸림/안 걸림과 근거만 낸다. 판정(통과·보류·탈락)은 verdict.py가 정한다.
"""
import json
import time
import re
from concurrent.futures import ThreadPoolExecutor

from . import backends, config

GROUPS = {
    "fact": (1, 2, 3, 4),
    "flow": (6, 8, 9, 10),
}


def load_rubric():
    """기준표의 「기준」 표를 읽어 {번호: {묶음, 기준, 걸리는 예, 걸리지 않는 예}}로. 지시문에 그대로 넣는다."""
    rows = {}
    in_table = False
    for line in config.RUBRIC.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            in_table = line.strip() == "## 기준"
            continue
        if not in_table or not line.startswith("|"):
            continue
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) != 5 or not cells[0].isdigit():
            continue
        n = int(cells[0])
        rows[n] = {"group": cells[1], "name": cells[2],
                   "hit": cells[3].split("<br>"), "ok": cells[4].split("<br>")}
    if sorted(rows) != list(range(1, 11)):
        raise SystemExit(f"기준표에서 기준 1~10을 읽지 못했습니다: {sorted(rows)}")
    return rows


def _criteria_text(rubric, nums):
    out = []
    for n in nums:
        r = rubric[n]
        out.append(f"### 기준 {n} ({r['group']}): {r['name']}\n"
                   + "걸리는 예:\n" + "\n".join(f"- {x}" for x in r["hit"]) + "\n"
                   + "걸리지 않는 예:\n" + "\n".join(f"- {x}" for x in r["ok"]))
    return "\n\n".join(out)


def _scenes_text(sections):
    return "\n".join(f"[장면 {n}] ({s.get('role', '')}) {s['text']}" for n, s in enumerate(sections, 1))


_FINDING = '{"scene": 장면 번호, "quote": "대본에서 그대로 옮긴 부분", "source_quote": "넣은 글에서 그대로 옮긴 부분 또는 \\"\\"", "reason": "왜 걸리는지 한 문장"}'


def build_prompt(group, rubric, sections, source):
    nums = GROUPS[group]
    crit = _criteria_text(rubric, nums)
    keys = ", ".join(f'"{n}": {{"hit": true 또는 false, "findings": [{_FINDING}, ...]}}' for n in nums)
    head = ("쇼더스(AI 쇼츠 서비스)가 넣은 글로 만든 쇼츠 대본을 검사합니다. 보는 것은 장면마다 목소리가 읽는 문장입니다. "
            "화면 제목, 배경, 음악은 보지 않습니다.\n"
            "아래 기준마다 대본이 걸리는지 「걸림/안 걸림」으로만 답합니다. 점수를 매기지 않습니다. "
            "기준의 「걸리는 예」와 「걸리지 않는 예」를 경계로 삼습니다. 「걸리지 않는 예」에 해당하면 걸지 않습니다.\n"
            "걸면 findings에 장면 번호와 대본 인용을 넣습니다. 걸지 않으면 findings는 빈 목록입니다.\n")
    if group == "fact":
        task = ("먼저 장면마다 그 장면의 내용을 받치는 넣은 글의 문장을 그대로 옮겨 grounding에 적습니다. "
                "받치는 문장이 없으면 \"\"로 둡니다. 그다음 그 대조를 바탕으로 기준을 판단합니다. "
                "기준 1·2·3에서 걸 때는 source_quote에 대조한 넣은 글 문장을 넣습니다(넣은 글에 없어서 걸면 \"\"). "
                "기준 4는 빠진 내용이 넣은 글의 어디에 있는지 source_quote에 넣고, scene에는 그 내용이 들어갔어야 할 장면 번호를 넣습니다.\n")
        shape = ('{"grounding": [{"scene": 1, "source_quote": "..."}, ...], ' + keys + "}")
    else:
        task = ("기준 8은 넣은 글을 함께 보고 판단합니다(첫 장면이 던진 궁금증의 답이 넣은 글에 있는지). "
                "다른 기준은 대본 문장만 봅니다.\n")
        shape = "{" + keys + "}"
    return (f"{head}{task}\n## 기준\n\n{crit}\n\n## 넣은 글\n\n{source.strip()}\n\n## 대본\n\n{_scenes_text(sections)}\n\n"
            f"## 답하는 꼴\n\n다른 말 없이 아래 꼴의 JSON 하나만 답합니다.\n{shape}\n")


def parse(text, group, n_scenes):
    """모델 답에서 JSON을 읽어 {"criteria": {번호: {...}}, "grounding": [...]}로. 꼴이 틀리면 ValueError."""
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("JSON 없음")
    data = json.loads(m.group())
    crit = {}
    for n in GROUPS[group]:
        c = data.get(str(n))
        if not isinstance(c, dict) or not isinstance(c.get("hit"), bool):
            raise ValueError(f"기준 {n}의 hit가 없음")
        fs = []
        for f in c.get("findings") or []:
            if isinstance(f, dict):
                sc = f.get("scene")
                fs.append({"scene": sc if isinstance(sc, int) and 1 <= sc <= n_scenes else None,
                           "quote": str(f.get("quote") or ""), "source_quote": str(f.get("source_quote") or ""),
                           "reason": str(f.get("reason") or "")})
        crit[n] = {"result": config.HIT if c["hit"] else config.OK, "findings": fs}
    grounding = data.get("grounding") if group == "fact" else None
    return {"criteria": crit, "grounding": grounding if isinstance(grounding, list) else None}


RETRY_NOTE = "\n\n(앞서 보낸 답이 지시한 꼴의 JSON으로 읽히지 않았습니다. 설명 없이 위 꼴의 JSON 하나만 답합니다.)"


def ask_group(group, model, rubric, sections, source):
    """한 묶음을 묻는다. JSON이 안 읽히면 한 번 더 묻고, 그래도 안 되면 그 묶음의 기준을 「판정 못 함」으로."""
    prompt = build_prompt(group, rubric, sections, source)
    calls, usage, error = [], {k: 0 for k in ("input_tokens", "output_tokens",
                                              "cache_creation_input_tokens", "cache_read_input_tokens")}, None
    for attempt in range(1 + config.JSON_RETRIES):
        t0 = time.monotonic()
        try:
            text, u = backends.call(model, prompt if attempt == 0 else prompt + RETRY_NOTE)
        except backends.CallFailed as e:
            calls.append({"group": group, "attempt": attempt + 1, "sec": round(time.monotonic() - t0, 1),
                          "error": str(e)})
            error = str(e)
            continue
        for k in usage:
            usage[k] += u[k]
        calls.append({"group": group, "attempt": attempt + 1, "sec": round(time.monotonic() - t0, 1),
                      **u, "cost_usd": round(backends.cost_usd(model, u), 5)})
        try:
            out = parse(text, group, len(sections))
            return {**out, "calls": calls, "usage": usage, "error": None}
        except (ValueError, json.JSONDecodeError) as e:
            error = f"답을 읽지 못함: {e}"
            calls[-1]["parse_error"] = error
    crit = {n: {"result": config.UNKNOWN, "findings": [], "error": error} for n in GROUPS[group]}
    return {"criteria": crit, "grounding": None, "calls": calls, "usage": usage, "error": error}


def run(model, sections, source):
    rubric = load_rubric()
    with ThreadPoolExecutor(max_workers=len(GROUPS)) as ex:
        futs = {g: ex.submit(ask_group, g, model, rubric, sections, source) for g in GROUPS}
        return {g: f.result() for g, f in futs.items()}
