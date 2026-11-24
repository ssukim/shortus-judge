"""보류·탈락 대본을 고쳐 다시 판정하고, 어느 대본으로 만들지 정한다 (D35).

  1. 판정을 정한 걸린 곳(기준 1~4, 탈락 의심, 2개 이상 걸린 6·8·9)을 모델에 주고 걸린 장면만 고치게 한다.
  2. 코드가 고친 장면을 거른다. 되돌리는 경우:
       - 걸린 곳이 없는 장면을 바꿈
       - 넣은 글에도 있던 숫자가 빠짐(고치다가 사실을 지움)
       - 넣은 글에도, 원래 장면에도 없던 숫자가 새로 들어감(고치다가 사실을 지어냄)
  3. 고친 대본을 판정기로 처음부터 다시 판정한다(같은 지시문, 같은 판정 선).
  4. config.REVISE_ROUNDS가 2 이상이면, 통과하지 못했을 때 다시 판정한 결과로 남은 곳만 한 번 더 고친다(기본 1, D37).

어느 대본으로 만들지(decision):
  원래 대본이 통과     → 원래 대본(표기만 고친 대본이 있으면 그것) — judge/view.py의 decision_of
  고친 대본이 통과     → 처음 통과한 고친 대본으로 만든다(render_revised)
  어느 것도 통과 못 함 → 탈락이 아닌 대본이 있으면 걸린 곳이 가장 적은 것을 사람에게 보인다(review).
                         모두 탈락이면 만들지 않는다(do_not_render).
  보류는 사람이 본다는 판정 선(verdict.py)은 그대로 둔다. 고친 대본이 보류여도 저절로 만들지 않는다.

판정 칸(verdict, why, criteria)은 원래 대본의 것 그대로다. 고친 대본은 revisions 칸에, 결정은 decision 칸에 넣는다.
"""
import json
import re
import time

from . import backends, config, verdict

GUARD_NUM = re.compile(r"\d+(?:[.,]\d+)*")
MAX_RATIO = 1.2          # 고친 장면 글자 수 한도(원래 장면의 120%, 가정값). 지시문에 적고, 넘으면 기록만 한다


def numbers(text):
    """문장 속 숫자들(쉼표는 뺌). 「3만 1200원」은 {"3", "1200"}."""
    return {m.replace(",", "") for m in GUARD_NUM.findall(text or "")}


def issues(r):
    """판정을 정한 걸린 곳 → [{"n", "name", "scene", "quote", "source_quote", "reason"}].
    기준 5(표기)는 코드가 고친 대본을 내므로 넣지 않는다. 기준 7·10은 진단만이라 넣지 않는다."""
    crit = {int(k): c for k, c in r["criteria"].items()}
    hit = lambda n: crit.get(n, {}).get("result") == config.HIT
    nums = [n for n in verdict.FAIL_ON + verdict.HOLD_ANY if hit(n) or crit.get(n, {}).get("doubt")]
    two = [n for n in verdict.HOLD_TWO if hit(n)]
    if len(two) >= 2:
        nums += two
    out = []
    for n in sorted(nums):
        for f in crit[n].get("findings") or []:
            out.append({"n": n, "scene": f.get("scene"), "quote": f.get("quote", ""),
                        "source_quote": f.get("source_quote", ""), "reason": f.get("reason", "")})
    return out


def allowed_scenes(found, n_scenes):
    """고쳐도 되는 장면. 장면 없이 걸린 곳(대본 전체의 흐름 등)이 있으면 모든 장면."""
    if any(not f["scene"] for f in found):
        return set(range(1, n_scenes + 1))
    return {f["scene"] for f in found}


NAMES = {1: "넣은 글에 없는 내용, 바뀐 뜻", 2: "숫자·날짜·이름이 넣은 글과 다름", 3: "넣은 글보다 세게 말함",
         4: "꼭 있어야 할 내용이 빠짐", 6: "말하듯 쓰지 않은 문장", 8: "첫 장면", 9: "이어짐, 되풀이"}


def build_prompt(sections, source, found, allowed):
    lines = []
    for f in found:
        where = f"장면 {f['scene']}" if f["scene"] else "대본 전체"
        lines.append(f"- 기준 {f['n']} ({NAMES.get(f['n'], '')}) · {where}"
                     + (f" · 「{f['quote']}」" if f["quote"] else "") + f": {f['reason']}"
                     + (f"\n  넣은 글: 「{f['source_quote']}」" if f["source_quote"] else ""))
    limits = ", ".join(f"장면 {i} {int(len(sections[i - 1]['text']) * MAX_RATIO)}자"
                       for i in sorted(allowed))
    scenes = "\n".join(f"[장면 {n}] {s['text']}" for n, s in enumerate(sections, 1))
    return (
        "쇼더스(AI 쇼츠 서비스)가 넣은 글로 만든 쇼츠 대본에서 판정기가 아래 문제를 찾았습니다. "
        "문제가 된 곳만 고쳐, 목소리가 그대로 읽을 장면 문장을 다시 씁니다.\n\n"
        "## 고치는 원칙\n"
        "1. 넣은 글에 있는 사실만 씁니다. 넣은 글에 없는 숫자·날짜·이름·주장을 새로 넣지 않습니다.\n"
        "2. 넣은 글과 다른 내용은 넣은 글에 맞게 바로잡고, 세게 바뀐 말은 넣은 글의 말 세기로 돌려 놓고, "
        "빠진 핵심 정보는 넣은 글에서 가져와 짧게 더합니다.\n"
        "3. 문제가 없는 문장과 숫자는 그대로 둡니다. 숫자·단위 표기(「3만 1200원」, 「15kg」)는 바꾸지 않습니다. "
        "읽는 법은 판정기 코드가 따로 고칩니다.\n"
        f"4. 고쳐도 되는 장면은 {', '.join(map(str, sorted(allowed)))}번뿐입니다. 다른 장면은 답에 넣지 않습니다.\n"
        f"5. 쇼츠라 짧아야 합니다. 고친 장면의 글자 수 한도: {limits}.\n"
        "6. 귀로 듣는 문장이라 말하듯 씁니다. 장면의 말투(~요/~다)는 원래 장면을 따릅니다.\n\n"
        f"## 찾은 문제\n\n" + "\n".join(lines) + "\n\n"
        f"## 넣은 글\n\n{source.strip()}\n\n"
        f"## 대본\n\n{scenes}\n\n"
        "## 답하는 꼴\n\n다른 말 없이 아래 꼴의 JSON 하나만 답합니다. 바꾼 장면만 넣습니다.\n"
        '{"scenes": [{"scene": 장면 번호, "text": "고친 장면 문장 전체", "why": "무엇을 왜 고쳤는지 한 문장"}, ...]}\n'
    )


def parse(text, n_scenes):
    """모델 답 → {장면 번호: {"text", "why"}}. 꼴이 틀리면 ValueError."""
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise ValueError("JSON 없음")
    data = json.loads(m.group())
    if not isinstance(data.get("scenes"), list):
        raise ValueError("scenes가 없음")
    out = {}
    for s in data["scenes"]:
        if not isinstance(s, dict):
            continue
        n, t = s.get("scene"), s.get("text")
        if isinstance(n, int) and 1 <= n <= n_scenes and isinstance(t, str) and t.strip():
            out[n] = {"text": t.strip(), "why": str(s.get("why") or "").strip()}
    return out


def guard(sections, proposed, allowed, source):
    """모델이 고친 장면을 거른다 → (새 장면 문장들, [장면 기록], 되돌린 것 [{"scene", "why", "proposed"}])"""
    src = numbers(source)
    texts, scenes, reverted = [], [], []
    for n, s in enumerate(sections, 1):
        before = s["text"]
        p = proposed.get(n)
        after, why = before, ""
        if p and p["text"] != before:
            lost = sorted((numbers(before) & src) - numbers(p["text"]))
            new = sorted(numbers(p["text"]) - src - numbers(before))
            if n not in allowed:
                reverted.append({"scene": n, "why": "걸린 곳이 없는 장면을 바꿈", "proposed": p["text"]})
            elif lost:
                reverted.append({"scene": n, "why": "넣은 글에도 있는 숫자가 빠짐: " + ", ".join(lost), "proposed": p["text"]})
            elif new:
                reverted.append({"scene": n, "why": "넣은 글에 없는 숫자가 들어감: " + ", ".join(new), "proposed": p["text"]})
            else:
                after, why = p["text"], p["why"]
        texts.append(after)
        scenes.append({"n": n, "before": before, "after": after, "changed": after != before, "why": why,
                       "too_long": after != before and len(after) > len(before) * MAX_RATIO})
    return texts, scenes, reverted


def _sections(sections, texts):
    """고친 문장 → 다시 판정에 넘길 장면. 바뀐 장면의 예상 초는 글자 수 비율로 늘이거나 줄인다."""
    out = []
    for s, t in zip(sections, texts):
        sec = s.get("estimated_sec")
        if t != s["text"] and sec:
            sec = round(float(sec) * len(t) / max(len(s["text"]), 1), 1)
        out.append({**s, "text": t, "estimated_sec": sec})
    return out


def ask(model, prompt, n_scenes):
    """고치기를 한 번 묻는다. JSON이 안 읽히면 한 번 더. → (답 또는 None, 호출 기록, 오류)"""
    calls, error = [], None
    for attempt in range(1 + config.JSON_RETRIES):
        t0 = time.monotonic()
        try:
            text, u = backends.call(model, prompt if attempt == 0 else prompt + "\n(JSON 하나만 답합니다.)")
        except backends.CallFailed as e:
            calls.append({"group": "revise", "attempt": attempt + 1, "sec": round(time.monotonic() - t0, 1), "error": str(e)})
            error = str(e)
            continue
        calls.append({"group": "revise", "attempt": attempt + 1, "sec": round(time.monotonic() - t0, 1),
                      **u, "cost_usd": round(backends.cost_usd(model, u), 5)})
        try:
            return parse(text, n_scenes), calls, None
        except (ValueError, json.JSONDecodeError) as e:
            error = f"답을 읽지 못함: {e}"
            calls[-1]["parse_error"] = error
    return None, calls, error


STEPS = {1: ("{v} 고친 대본을 만들고 있어요", "고친 대본을 다시 판정하고 있어요"),
         2: ("남은 곳을 한 번 더 고치고 있어요", "두 번째 고친 대본을 다시 판정하고 있어요")}


def one_round(k, cur, sections, source, model, rejudge, on_step=None):
    """고치기 한 번 + 다시 판정. cur: 지금 대본(sections)을 판정한 결과 → 고친 대본 기록"""
    t0 = time.monotonic()
    step = on_step or (lambda text: None)
    make, again = STEPS.get(k, STEPS[2])
    step(make.format(v="탈락이라" if cur["verdict"] == config.FAIL else "보류라"))
    found = issues(cur)
    allowed = allowed_scenes(found, len(sections))
    proposed, calls, error = ask(model, build_prompt(sections, source, found, allowed), len(sections))
    rev = {"round": k, "error": error, "scenes": None, "reverted": [], "result": None, "calls": calls}
    if proposed is not None:
        texts, rev["scenes"], rev["reverted"] = guard(sections, proposed, allowed, source)
        if not any(s["changed"] for s in rev["scenes"]):
            rev["error"] = "고친 장면이 없음" + (" (모두 되돌림)" if rev["reverted"] else "")
        else:
            step(again)
            rev["result"] = rejudge(_sections(sections, texts))
    cost = sum(c.get("cost_usd", 0) for c in calls) + (rev["result"]["run"]["cost_usd_est"] if rev["result"] else 0)
    rev["cost_usd"] = round(cost, 5)
    rev["sec"] = round(time.monotonic() - t0, 1)
    return rev


def needed(r):
    """고쳐 볼 대본인가: 보류·탈락이고, 모델이 고칠 걸린 곳이 있다(판정 못 함이나 못 고치는 표기만이면 사람이 본다)."""
    return r["verdict"] in (config.HOLD, config.FAIL) and bool(issues(r))


def run(r, d, source, model, rejudge, on_step=None):
    """r(원래 대본의 판정 결과)에 revisions와 decision을 넣는다. rejudge(장면 목록) → 판정 결과"""
    if not needed(r):
        return r
    revs, cur, sections = [], r, d["script"]["sections"]
    for k in range(1, config.REVISE_ROUNDS + 1):
        rev = one_round(k, cur, sections, source, model, rejudge, on_step)
        revs.append(rev)
        res = rev["result"]
        if not res or res["verdict"] == config.PASS or not needed(res):
            break
        cur, sections = res, _sections(sections, [s["after"] for s in rev["scenes"]])
    # 2번째부터는 앞 판의 고친 문장을 받아 고쳤으므로, before를 원래 대본 문장으로 맞춰 둔다
    # 앞 판에서 바꾸고 이번 판에서 그대로 둔 장면은 앞 판의 까닭을 이어 받는다
    orig = [s["text"] for s in d["script"]["sections"]]
    why = {}
    for rev in revs:
        for s in rev["scenes"] or []:
            if s["changed"]:
                why[s["n"]] = s["why"]
            s["before"] = orig[s["n"] - 1]
            s["changed"] = s["after"] != s["before"]
            s["why"] = why.get(s["n"], "") if s["changed"] else ""
    r["revisions"] = revs
    r["decision"] = choose(r, revs)
    r["run"]["revise_cost_usd"] = round(sum(x["cost_usd"] for x in revs), 5)
    r["run"]["revise_sec"] = round(sum(x["sec"] for x in revs), 1)
    return r


def _left(res):
    """판정을 정한 걸린 기준 번호(진단만인 것은 뺌)."""
    return [int(k) for k, c in res["criteria"].items()
            if c["result"] == config.HIT and int(k) not in (res.get("diagnostics") or []) and int(k) not in verdict.DIAG_ONLY]


def choose(r, revs):
    """어느 대본으로 만들지 → {"action", "round", "reason", "remaining"} (모듈 머리말의 규칙)"""
    done = [(x["round"], x["result"]) for x in revs if x["result"]]
    for k, res in done:
        if res["verdict"] == config.PASS:
            return {"action": "render_revised", "round": k, "remaining": [],
                    "reason": f"{k}번째 고친 대본이 다시 판정에서 통과해 그 대본으로 만듭니다."}
    cands = [(0, r)] + done
    ok = [(k, res) for k, res in cands if res["verdict"] != config.FAIL]
    tried = f"{len(revs)}번 고쳐 봤지만 " if revs else ""
    if not ok:
        last = cands[-1][1]
        return {"action": "do_not_render", "round": None, "remaining": _left(last),
                "reason": f"{tried}넣은 글과 다른 내용이 남아 만들지 않습니다."}
    k, res = min(ok, key=lambda x: (len(_left(x[1])), -x[0]))
    return {"action": "review", "round": k or None, "remaining": _left(res),
            "reason": f"{tried}통과하지 못했습니다. "
                      + (f"걸린 곳이 가장 적은 {k}번째 고친 대본을 사람이 보고 정합니다." if k else
                         "원래 대본을 사람이 보고 정합니다.")}
