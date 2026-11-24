"""대본 하나를 판정한다."""
import json
import time
from pathlib import Path

from . import checks_code, checks_llm, config, listen, revise, verdict


def load_script(path):
    d = json.loads(Path(path).read_text(encoding="utf-8"))
    src = config.SOURCES / f"{d['source_id']}.txt"
    return d, src.read_text(encoding="utf-8")


def judge_file(path, model=None, fix=None):
    d, source = load_script(path)
    return judge_script(d, source, model, fix)


def judge_script(d, source, model=None, fix=None, on_criterion=None, on_step=None, on_judged=None):
    """메모리에 든 대본 하나를 판정한다. d: data/scripts/<id>.json과 같은 꼴({"id", "source_id", "script": {"sections"}}),
    source: 넣은 글. 파일을 읽지 않고, 판정 서버(judge/serve.py)도 이 함수를 쓴다.
    fix: 보류·탈락이면 고쳐 다시 판정한다(judge/revise.py). None이면 config.REVISE.
    on_criterion(번호, 기준 결과): 기준 하나가 끝날 때마다(코드 기준은 바로, 모델 기준은 묶음이 끝날 때). 원래 대본만 알린다.
    on_step(글): 고치기와 다시 판정을 시작할 때. 판정 서버가 흘려보낼 때 쓴다(judge/serve.py).
    on_judged(결과): 원래 대본의 판정이 끝났을 때(고치기 전). 화면이 결론을 먼저 보이게 한다."""
    model = model or config.MODEL
    r = _judge(d, source, model, on_criterion)
    if on_judged:
        on_judged(r)
    if config.REVISE if fix is None else fix:
        rejudge = lambda secs: _judge({**d, "script": {**d["script"], "sections": secs}}, source, model)
        revise.run(r, d, source, model, rejudge, on_step)
    return r


def _judge(d, source, model, on_criterion=None):
    t0 = time.monotonic()
    sections = d["script"]["sections"]

    criteria = {5: checks_code.check_notation(sections), 7: checks_code.check_length(sections)}
    for n in (5, 7):
        criteria[n]["by"] = "code"
    tell = on_criterion or (lambda n, c: None)
    if not config.LISTEN:   # 듣기 검사를 켜면 기준 5는 소리까지 들은 뒤에 알린다
        tell(5, criteria[5])
    tell(7, criteria[7])

    def group_done(g, out):
        for n, c in out["criteria"].items():
            tell(n, {**c, "by": "model"})
    # 원래 글(넣은 글)이 없으면 사실 묶음(기준 1~4)은 견줄 것이 없어 보지 않는다(D38). 판정 선에서는 안 걸림으로 두고 not_checked로 적는다
    given = bool(source and source.strip())
    if not given:
        for n in checks_llm.GROUPS["fact"]:
            criteria[n] = {"result": config.OK, "findings": [], "not_checked": True, "by": "model"}
            tell(n, criteria[n])
    llm = checks_llm.run(model, sections, source or "", on_group=group_done if on_criterion else None,
                         groups=None if given else ("flow",))
    calls, usage = [], {}
    for g, out in llm.items():
        for n, c in out["criteria"].items():
            criteria[n] = {**c, "by": "model"}
        calls += out["calls"]
        for k, v in out["usage"].items():
            usage[k] = usage.get(k, 0) + v
    criteria = dict(sorted(criteria.items()))

    fixed = checks_code.fix_script(sections, criteria[5]["findings"])
    if config.LISTEN:
        heard = listen.check(fixed, [x["text"] for x in sections])
        criteria[5]["listen"] = heard
        for f in heard["findings"]:
            criteria[5]["findings"].append(f)
            criteria[5]["unfixable"].append(f"장면 {f['scene']} 「{f['heard']}」")
        if heard["findings"]:
            criteria[5]["result"] = config.HIT
        tell(5, criteria[5])
    v, why, diag = verdict.decide({n: c["result"] for n, c in criteria.items()},
                                  doubt=[n for n, c in criteria.items() if c.get("doubt")],
                                  unfixable=criteria[5]["unfixable"])
    cost = sum(c.get("cost_usd", 0) for c in calls)
    return {
        "id": d["id"], "source_id": d["source_id"], "verdict": v, "why": why,
        "diagnostics": diag,
        "criteria": {str(n): c for n, c in criteria.items()},
        "grounding": llm["fact"]["grounding"] if given else None, "source_given": given,
        "scenes": [{"scene": n, "role": s.get("role"), "text": s["text"], "estimated_sec": s.get("estimated_sec")}
                   for n, s in enumerate(sections, 1)],
        "fixed_scenes": fixed if fixed != [s["text"] for s in sections] else None,
        "run": {"model": model, "backend": config.BACKEND, "effort": config.EFFORT,
                "calls": len([c for c in calls if "error" not in c]), "call_log": calls,
                "usage": usage, "cost_usd_est": round(cost, 5), "sec": round(time.monotonic() - t0, 1)},
    }


def render(r):
    """사람이 읽는 출력."""
    L = [f"{r['id']}  →  {r['verdict']}" + (f"  ({'; '.join(r['why'])})" if r["why"] else "")]
    L.append("")
    for n, c in r["criteria"].items():
        who = "코드" if c["by"] == "code" else "모델"
        L.append(f"기준 {n:>2} [{who}] {c['result']}" + (f"  — {c['error']}" if c.get("error") else ""))
        if c.get("doubt"):
            L[-1] += f"  (탈락 의심 — {c['votes']}번 걸림)"
        if c.get("unsure") and c["result"] != config.HIT:
            L[-1] += "  (애매한 걸림이 있어 판정에는 안 씀)"
        if c["result"] == config.HIT or c.get("doubt") or c.get("unsure"):
            for f in c["findings"]:
                sc = f"장면 {f['scene']}" if f.get("scene") else "전체"
                L.append(f"    · {sc}: 「{f['quote']}」 {f['reason']}" + (f" → 「{f['fix']}」로" if f.get("fix") else ""))
                if f.get("source_quote"):
                    L.append(f"        넣은 글: 「{f['source_quote']}」")
        if n == "5" and c.get("vague"):
            L.append("    (애매, 걸지 않음) " + ", ".join(f"장면 {v['scene']} 「{v['quote']}」 {v['reason'].split('— ')[-1]}"
                                                for v in c["vague"]))
        if n == "5" and c.get("listen"):
            h = c["listen"]
            L.append("    (듣기 검사) " + (f"건너뜀: {h['skipped']}" if h["skipped"] else
                                        f"숫자가 든 장면 {len(h['heard'])}개를 들음, 다르게 들린 장면 {len(h['findings'])}개"))
        if n == "7":
            L.append(f"    읽는 시간 추정 {c['total_sec']}초")
    if r.get("fixed_scenes"):
        L.append("")
        L.append("고친 대본(표기를 목소리가 바로 읽게 바꿈, 렌더링에 이 문장을 씀):")
        for n, t in enumerate(r["fixed_scenes"], 1):
            if t != r["scenes"][n - 1]["text"]:
                L.append(f"    장면 {n}: {t}")
    for rev in r.get("revisions") or []:
        L.append("")
        res = rev["result"]
        L.append(f"고친 대본 {rev['round']}번째" + (f" → 다시 판정: {res['verdict']}" + (f" ({'; '.join(res['why'])})" if res["why"] else "")
                                                  if res else f" — {rev['error']}"))
        texts = (res.get("fixed_scenes") if res else None) or [s["after"] for s in rev["scenes"] or []]
        for s in rev["scenes"] or []:
            if s["changed"]:
                L.append(f"    장면 {s['n']}: {texts[s['n'] - 1]}")
                L.append(f"        원래: {s['before']}")
                if s["why"]:
                    L.append(f"        → {s['why']}")
        for x in rev["reverted"]:
            L.append(f"    (되돌림) 장면 {x['scene']}: {x['why']}")
    if r.get("decision"):
        L.append("")
        L.append(f"결정: {r['decision']['reason']}")
    if r["diagnostics"]:
        L.append("")
        L.append("진단(판정에는 넣지 않음): " + ", ".join(f"기준 {n}" for n in r["diagnostics"]))
    run = r["run"]
    u = run["usage"]
    L.append("")
    L.append(f"모델 {run['model']} ({run['backend']}, effort {run['effort']}) · 호출 {run['calls']}번 · "
             f"{run['sec']}초 · 입력 {u.get('input_tokens', 0) + u.get('cache_creation_input_tokens', 0) + u.get('cache_read_input_tokens', 0)}"
             f" / 출력 {u.get('output_tokens', 0)} 토큰 · 추정 ${run['cost_usd_est']:.4f}")
    if "revise_cost_usd" in run:
        L.append(f"고쳐 다시 판정 {len(r['revisions'])}번 · {run['revise_sec']}초 · 추정 ${run['revise_cost_usd']:.4f}")
    return "\n".join(L)
