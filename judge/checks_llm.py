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


SURE_NOTE = ("걸 때는 sure에 확신하는지 적습니다. 「걸리는 예」에 분명히 해당하고 시청자가 실제로 잘못 알거나 불편할 때만 "
             "sure를 true로 둡니다. 기준표의 경계에 걸쳐 판단이 갈릴 만하면 hit는 true로 두되 sure를 false로 둡니다. "
             "sure가 false인 걸림은 판정에 쓰지 않고 진단으로만 남습니다. 걸지 않으면 sure는 true입니다.\n")   # 6판 실험(D29·D30)


def build_prompt(group, rubric, sections, source):
    nums = GROUPS[group]
    crit = _criteria_text(rubric, nums)
    sure_key = '"sure": true 또는 false, ' if config.SURE_ONLY else ""
    keys = ", ".join(f'"{n}": {{"hit": true 또는 false, {sure_key}"findings": [{_FINDING}, ...]}}' for n in nums)
    head = ("쇼더스(AI 쇼츠 서비스)가 넣은 글로 만든 쇼츠 대본을 검사합니다. 보는 것은 장면마다 목소리가 읽는 문장입니다. "
            "화면 제목, 배경, 음악은 보지 않습니다.\n"
            "아래 기준마다 대본이 걸리는지 「걸림/안 걸림」으로만 답합니다. 점수를 매기지 않습니다. "
            "기준의 「걸리는 예」와 「걸리지 않는 예」를 경계로 삼습니다. 「걸리지 않는 예」에 해당하면 걸지 않습니다.\n"
            "걸면 findings에 장면 번호와 대본 인용을 넣습니다. 걸지 않으면 findings는 빈 목록입니다.\n"
            + (SURE_NOTE if config.SURE_ONLY else ""))
    if group == "fact":
        task = ("먼저 장면마다 그 장면의 내용을 받치는 넣은 글의 문장을 그대로 옮겨 grounding에 적습니다. "
                "받치는 문장이 없으면 \"\"로 둡니다. 그다음 그 대조를 바탕으로 기준을 판단합니다. "
                "기준 1·2·3에서 걸 때는 source_quote에 대조한 넣은 글 문장을 넣습니다(넣은 글에 없어서 걸면 \"\"). "
                "기준 4는 빠진 내용이 넣은 글의 어디에 있는지 source_quote에 넣고, scene에는 그 내용이 들어갔어야 할 장면 번호를 넣습니다.\n"
                "\n## 판단 순서 (기준끼리 헷갈릴 때)\n"
                "1. 기준 2는 넣은 글과 대본에 적힌 숫자·날짜·이름이 서로 다를 때만 겁니다. "
                "말을 확실하게 바꾼 것(「받을 수 있다」 → 「받는다」)은 기준 2가 아니라 기준 3에서 봅니다.\n"
                "2. 조건이 빠졌는지는 장면 하나가 아니라 대본 전체를 보고 정합니다. 다른 장면에서 이미 말한 조건"
                "(누구와, 몇 명이, 어디서, 언제)은 빠진 것이 아닙니다. 예: 앞 장면에서 「가족 셋이 다녀왔다」고 했으면 "
                "뒤 장면의 「모두 30만 원 들었다」는 셋의 경비로 들립니다. "
                "넣은 글의 조건이 대본 전체에서 빠졌으면 차례로 묻습니다. "
                "(가) 조건이 빠진 탓에 숫자나 주장이 다른 대상·범위에 붙어 틀린 말이 되었나 → 기준 1. "
                "(나) 그렇지 않고, 대본이 말한 것의 조건만 빠졌나 → 기준 4. "
                "(다) 대본이 말하지 않은 곁가지라면 → 걸지 않습니다. 하나를 고르고 같은 내용을 두 기준에 함께 걸지 않습니다. "
                "(가)와 (나)를 가를 때는 대본 문장이 넣은 글과 맞서는지 봅니다. "
                "(가)는 대본 문장을 들은 사람이 넣은 글과 반대되는 사실을 믿게 될 때뿐입니다: "
                "숫자가 다른 대상에 붙음(「두 명 61만 원」 → 「한 명에 61만 원」), 대상이 넓어지거나 바뀜(「만 65세 이상 무료」 → 「누구나 무료」). "
                "대본 문장이 흔한 경우에는 맞고 덜 말했을 뿐이면 (나)입니다: 기한·기간이 빠짐(「이번 달 할인」 → 「할인」), "
                "예외나 단서가 빠짐(「단, ~은 제외」「~이면 안 됨」), 잰 조건이 빠짐(「실내에서 잰 값」), 방법·절차가 빠짐(보증기간, 신청 방법). "
                "기준 1은 탈락이라, 틀린 사실을 믿게 되는지 확실할 때만 겁니다. 장소·순서 같은 작은 세부가 조금 달라진 것은 걸지 않습니다.\n"
                "3. 기준 4는 먼저 넣은 글에서 대본이 다루는 얘기의 핵심 정보를 3개 이하로 골라 core에 적습니다. "
                "핵심은 그 정보가 없으면 시청자가 대본의 요점을 잘못 알거나 쓰지 못하는 것입니다. "
                "core에 고른 것이 대본에 없을 때만 기준 4를 겁니다. 핵심이 아닌 세부는 빠져도 걸지 않습니다.\n"
                "4. 첫 장면(hook)도 다른 장면과 똑같이 넣은 글과 대조합니다. 「흔한 상황을 한 줄 깔아 줌」으로 넘기는 것은 "
                "누구에게나 있을 법한 고민이나 상황만입니다. 「~하면 ~된다」처럼 원인과 결과, 사실을 말하면 넣은 글에 그 말이 있는지 봅니다.\n")
        shape = ('{"grounding": [{"scene": 1, "source_quote": "..."}, ...], "core": ["핵심 정보", ...], ' + keys + "}")
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
        sure = c.get("sure") is not False   # 답에 없으면 확신으로 봄(5판 이전 결과와 같게)
        use = c["hit"] and (sure or not config.SURE_ONLY or n in config.SURE_EXEMPT)   # 탈락 기준은 애매해도 씀
        crit[n] = {"result": config.HIT if use else config.OK, "findings": fs}
        if c["hit"] and not sure and not use:
            crit[n]["unsure"] = True
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


def vote(results):
    """같은 묶음을 여러 번 물은 결과를 기준마다 합친다. 걸림이 과반이면 걸림이고, 근거는 걸림이라 답한 첫 결과에서 가져온다.
    config.UNANIMOUS의 기준(탈락 기준)은 모두 걸림일 때만 걸고, 과반이지만 갈렸으면 안 걸림 + doubt로 둔다."""
    ok = [r for r in results if not r["error"]]
    base = ok[0] if ok else results[0]
    crit = {}
    for n in base["criteria"]:
        votes = [r["criteria"][n]["result"] for r in ok]
        hits = sum(v == config.HIT for v in votes)
        if not ok:
            crit[n] = base["criteria"][n]
            continue
        major = hits * 2 > len(ok)
        hit = hits == len(ok) if n in config.UNANIMOUS else major
        doubt = major and not hit
        src = next((r for r in ok if r["criteria"][n]["result"] == config.HIT), base) if major else base
        if not major:   # 확신하지 못한 걸림이 있으면 근거를 진단으로 남김
            src = next((r for r in ok if r["criteria"][n].get("unsure")), src)
        crit[n] = {**src["criteria"][n], "result": config.HIT if hit else config.OK, "votes": f"{hits}/{len(ok)}"}
        if doubt:
            crit[n]["doubt"] = True
    usage = {k: sum(r["usage"][k] for r in results) for k in base["usage"]}
    return {"criteria": crit, "grounding": base.get("grounding"), "calls": [c for r in results for c in r["calls"]],
            "usage": usage, "error": None if ok else base["error"]}


def run(model, sections, source):
    rubric = load_rubric()
    jobs = [(g, k) for g in GROUPS for k in range(config.VOTES.get(g, 1))]
    with ThreadPoolExecutor(max_workers=len(jobs)) as ex:
        futs = {(g, k): ex.submit(ask_group, g, model, rubric, sections, source) for g, k in jobs}
        out = {}
        for g in GROUPS:
            rs = [futs[(g, k)].result() for k in range(config.VOTES.get(g, 1))]
            out[g] = rs[0] if len(rs) == 1 else vote(rs)
        return out
