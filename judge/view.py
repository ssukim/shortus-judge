"""판정 결과(judge/core.py의 judge_script, results/<폴더>/<id>.json)를 화면(web/)이 읽는 모양으로 바꾼다.

판정 서버(judge/serve.py)의 응답과 화면 자료(web/scripts/export_data.py가 만드는 web/public/data.json)가 같은 함수를 쓴다.

  to_view(r)      결과 하나 → 화면 결과 (칸은 web/src/types.ts의 Result)
  redecide(r)     저장한 결과에 지금 판정 선을 다시 적용(tools/evaluate.py의 redecide와 같은 셈)

판정기는 모델로 문장을 고쳐 쓰지 않는다. 「고친 대본」(fixed_scenes)은 코드가 표기와 위험한 숫자만 목소리가 바로 읽게 바꾼 것이라
revision 칸에 method "reading_only"로 넣는다.
"""
import copy
import difflib

from . import checks_code, config, verdict

# 화면에 쓰는 기준 이름(짧게). 기준 문장은 기준표(data/labels/rubric.md)의 「기준」 칸.
NAMES = {1: "없는 내용, 바뀐 뜻", 2: "숫자·날짜·이름", 3: "세게 바꿔 말함", 4: "빠진 내용", 5: "잘못 읽을 표기",
         6: "말하듯 쓴 문장", 7: "길이", 8: "첫 장면", 9: "이어짐, 되풀이", 10: "끝맺음"}
BY = {1: "model", 2: "model", 3: "model", 4: "model", 5: "code", 6: "model", 7: "code", 8: "model", 9: "model",
      10: "model"}
RULE = {"fail": list(verdict.FAIL_ON), "hold": list(verdict.HOLD_ANY), "hold_group": list(verdict.HOLD_TWO),
        "hold_group_min": 2, "diag": list(verdict.DIAG_ONLY)}
SHORT_MAX = 80     # 짧은 이유 글자 수. 넘으면 자르고 「…」
SHORT_NOTICE_SEC = 30   # 이보다 짧으면 걸지 않고 알리기만 한다(기준표 「가정한 값」)


def redecide(r):
    """저장한 결과의 표 수(votes)로 지금 config·verdict의 규칙을 다시 적용한 새 결과. 원래 사전은 고치지 않는다.
    tools/evaluate.py의 redecide와 같은 셈이다(기준별 과반, 기준 5는 자동으로 못 고치는 표기만 보류)."""
    r = copy.deepcopy(r)
    res, doubt = {}, []
    for k, c in r["criteria"].items():
        n, v = int(k), c["result"]
        if c.get("votes"):
            hits, total = map(int, c["votes"].split("/"))
            major = hits * 2 > total
            hit = hits == total if n in config.UNANIMOUS else major
            v = config.HIT if hit else config.OK
            c["doubt"] = major and not hit
            if c["doubt"]:
                doubt.append(n)
            c["result"] = v
        res[n] = v
    unfixable = [f["quote"] for f in r["criteria"]["5"].get("findings", [])
                 if f.get("heard") is not None or not checks_code.fixable(f["quote"])]
    r["verdict"], r["why"], r["diagnostics"] = verdict.decide(res, doubt=doubt, unfixable=unfixable)
    return r


def reading_of(word):
    """잘못 읽는 표기 하나를 고친 대본에 들어가는 꼴로(단위 바꾸기 + 한글로 풀어 쓰기). 못 고치면 None."""
    out = checks_code.pin_reading(checks_code.suggest(word) or word).strip()
    return out if out != word else None


def fixed_texts(r):
    """고친 대본의 장면 문장들. 결과에 fixed_scenes가 있으면 그것, 없으면(그 칸을 넣기 전에 저장한 결과) 같은 코드로 다시 만든다."""
    texts = [s["text"] for s in r["scenes"]]
    if "fixed_scenes" in r:
        return r["fixed_scenes"] or texts
    findings = [{**f, **({"fix": checks_code.suggest(f["quote"])} if checks_code.suggest(f["quote"]) else {})}
                for f in r["criteria"]["5"].get("findings", []) if f.get("heard") is None]
    return checks_code.fix_script([{"text": t} for t in texts], findings)


def changes(before, after):
    """두 문장에서 바뀐 낱말 묶음 → [(전, 후)] (띄어쓰기 단위)."""
    a, b = before.split(), after.split()
    out = []
    for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=a, b=b, autojunk=False).get_opcodes():
        if op != "equal":
            out.append((" ".join(a[i1:i2]), " ".join(b[j1:j2])))
    return out


def _short(text):
    text = (text or "").strip()
    return text if len(text) <= SHORT_MAX else text[:SHORT_MAX - 1].rstrip() + "…"


def criterion_view(n, c, scenes):
    """기준 하나 → {flagged, scenes, reason, short, by, marks, source_quote, ...}"""
    hit = c["result"] == config.HIT
    fs = c.get("findings") or []
    out = {"flagged": hit, "scenes": [], "reason": "", "by": c.get("by") or BY[n], "result": c["result"]}
    if c.get("votes"):
        out["votes"] = c["votes"]
    if c.get("doubt"):
        out["doubt"] = True
    if c["result"] == config.UNKNOWN:
        out["error"] = True
        out["reason"] = f"모델 답을 받지 못함({c.get('error') or '까닭 모름'})"
    if n == 7:
        secs = [round(float(s.get("estimated_sec") or 0) * config.READ_RATIO, 1) for s in scenes]
        out.update({"total_sec": c.get("total_sec", round(sum(secs), 1)), "scene_sec": secs,
                    "sec_factor": config.READ_RATIO})
    if n == 5:
        out["vague"] = [{"scene": v["scene"], "text": v["quote"], "why": v["reason"]} for v in c.get("vague") or []]
        if c.get("listen"):
            h = c["listen"]
            out["listen"] = {"heard": len(h.get("heard") or {}), "different": len(h.get("findings") or []),
                             "skipped": h.get("skipped")}
            out["by"] = "code+listen"
    if not hit:
        return out
    with_scene = [f for f in fs if f.get("scene")]
    out["scenes"] = sorted({f["scene"] for f in with_scene})
    out["reason"] = " ".join((f"{f['scene']}번 장면 「{f['quote']}」: " if f.get("scene") and f.get("quote") else "")
                             + f.get("reason", "") for f in fs).strip()
    out["short"] = _short(fs[0].get("reason")) if fs else ""
    out["source_quote"] = next((f["source_quote"] for f in fs if f.get("source_quote")), "")
    if n == 5:
        out["hits"] = [{"scene": f["scene"], "text": f["quote"], "fix": None, "heard": f["heard"]}
                       if f.get("heard") is not None else
                       {"scene": f["scene"], "text": f["quote"], "fix": reading_of(f["quote"])} for f in with_scene]
        out["marks"] = [{"scene": h["scene"], "quote": h["text"], "fix": h["fix"]} for h in out["hits"]]
    else:
        out["marks"] = [{"scene": f["scene"], "quote": "" if n == 7 else (f.get("quote") or ""), "fix": None}
                        for f in with_scene]
    return out


def revision_view(r, texts):
    """고친 대본 → revision 칸(reading_only). 바뀐 장면이 없으면 None."""
    scenes = []
    for n, (s, after) in enumerate(zip(r["scenes"], texts), 1):
        before = s["text"]
        changed = after != before
        why = ("읽는 법만 바꿈: " + ", ".join(f"「{a}」 → 「{b}」" for a, b in changes(before, after))) if changed else ""
        scenes.append({"n": n, "before": before, "after": after, "changed": changed, "why": why,
                       **({"reading": after} if changed else {})})
    if not any(s["changed"] for s in scenes):
        return None
    return {"method": "reading_only", "round": 1, "scenes": scenes, "new_numbers": [], "error": None}


def decision_of(v, why, fixed, remaining):
    if v == config.PASS:
        if fixed:
            return {"action": "render_revised", "script": "revision 1", "round": 1, "remaining": [],
                    "reason": "통과. 목소리가 잘못 읽을 표기와 숫자만 바로 읽히게 바꾼 고친 대본으로 만듭니다."}
        return {"action": "render_original", "script": "original", "round": 0, "remaining": [],
                "reason": "통과. 원래 대본 그대로 만듭니다."}
    if v == config.HOLD:
        return {"action": "review", "script": None, "round": None, "remaining": remaining,
                "reason": "보류. 사람이 보고 정합니다: " + "; ".join(why)}
    return {"action": "do_not_render", "script": None, "round": None, "remaining": remaining,
            "reason": "탈락. 넣은 글과 다른 내용이 있어 만들지 않습니다: " + "; ".join(why)}


def _add_pinned(c5, scenes, texts):
    """발음 고정(위험한 숫자를 한글로)으로만 바뀐 곳을 기준 5의 고칠 표기에 더한다. 화면은 걸린 기준의 표시만 그리므로,
    표기 규칙에는 안 걸렸어도 고친 대본이 바뀌었으면 기준 5를 걸린 것으로 보인다(진단만인 기준이라 판정은 그대로)."""
    if c5 is None:
        return
    hits = c5.setdefault("hits", [])
    for n, (s, after) in enumerate(zip(scenes, texts), 1):
        for before, fix in changes(s["text"], after):
            if before and not any(h["scene"] == n and (before in h["text"] or h["text"] in before) for h in hits):
                hits.append({"scene": n, "text": before, "fix": fix, "pinned": True})
    if hits and not c5["flagged"]:
        c5.update({"flagged": True, "scenes": sorted({h["scene"] for h in hits}),
                   "short": "읽을 때마다 틀리게 읽힐 수 있는 숫자를 한글로 풀어 씀",
                   "reason": "목소리가 읽을 때마다 다르게 읽는 숫자를 고친 대본에서 한글로 풀어 썼습니다(판정에는 쓰지 않음)."})
    c5["marks"] = [{"scene": h["scene"], "quote": h["text"], "fix": h["fix"]} for h in hits]


def to_view(r, judged_at=None):
    """판정 결과 하나 → 화면 결과. r의 verdict·why·diagnostics를 그대로 쓴다(저장한 결과는 먼저 redecide)."""
    scenes = r["scenes"]
    crit = {k: criterion_view(int(k), c, scenes) for k, c in r["criteria"].items()}
    texts = fixed_texts(r)
    _add_pinned(crit.get("5"), scenes, texts)
    flagged = [int(k) for k, c in crit.items() if c["flagged"]]
    rev = revision_view(r, texts)
    diag = list(r.get("diagnostics") or [])
    if crit.get("5", {}).get("flagged") and 5 not in diag and 5 not in [int(x.split()[1]) for x in r.get("why") or []
                                                                         if x.startswith("기준 5")]:
        diag = sorted(diag + [5])   # 고친 대본으로 해결한 표기는 남은 문제가 아님
    remaining = [{"criterion": n, "name": NAMES[n]} for n in flagged if n not in diag]
    notices = []
    total = crit.get("7", {}).get("total_sec")
    if total is not None and total < SHORT_NOTICE_SEC:
        notices.append(f"읽는 시간이 {total}초로 {SHORT_NOTICE_SEC}초에 못 미칩니다(걸지 않음).")
    run = r.get("run") or {}
    return {
        "id": r.get("id"), "source_id": r.get("source_id"),
        "verdict": r["verdict"], "why": list(r.get("why") or []), "flagged": sorted(flagged),
        "diagnostics": diag, "criteria": crit,
        "summary": r["verdict"] + (": " + "; ".join(r["why"]) if r.get("why") else ""),
        "notices": notices,
        "undecided": [{"criterion": int(k), "why": c.get("error") or ""} for k, c in r["criteria"].items()
                      if c["result"] == config.UNKNOWN],
        "source_given": True,
        "cost_usd": run.get("cost_usd_est", 0), "elapsed_sec": run.get("sec"), "model": run.get("model"),
        "calls": run.get("calls"), "judged_at": judged_at,
        "decision": decision_of(r["verdict"], r.get("why") or [], rev is not None, remaining),
        "revision": rev,
    }


def criteria_meta(rubric=None):
    """기준 10개의 번호·이름·묶음·기준 문장·누가 보는지. 화면이 기준 이름을 박아 두지 않게 data.json과 GET /api/judge에 넣는다."""
    from .checks_llm import load_rubric
    rubric = rubric or load_rubric()
    return [{"n": n, "name": NAMES[n], "group": rubric[n]["group"], "text": rubric[n]["name"], "by": BY[n]}
            for n in sorted(rubric)]
