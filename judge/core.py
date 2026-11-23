"""대본 하나를 판정한다."""
import json
import time
from pathlib import Path

from . import checks_code, checks_llm, config, verdict


def load_script(path):
    d = json.loads(Path(path).read_text(encoding="utf-8"))
    src = config.SOURCES / f"{d['source_id']}.txt"
    return d, src.read_text(encoding="utf-8")


def judge_file(path, model=None):
    model = model or config.MODEL
    t0 = time.monotonic()
    d, source = load_script(path)
    sections = d["script"]["sections"]

    criteria = {5: checks_code.check_notation(sections), 7: checks_code.check_length(sections)}
    for n in (5, 7):
        criteria[n]["by"] = "code"
    llm = checks_llm.run(model, sections, source)
    calls, usage = [], {}
    for g, out in llm.items():
        for n, c in out["criteria"].items():
            criteria[n] = {**c, "by": "model"}
        calls += out["calls"]
        for k, v in out["usage"].items():
            usage[k] = usage.get(k, 0) + v
    criteria = dict(sorted(criteria.items()))

    v, why, diag = verdict.decide({n: c["result"] for n, c in criteria.items()})
    cost = sum(c.get("cost_usd", 0) for c in calls)
    return {
        "id": d["id"], "source_id": d["source_id"], "verdict": v, "why": why,
        "diagnostics": diag,
        "criteria": {str(n): c for n, c in criteria.items()},
        "grounding": llm["fact"]["grounding"],
        "scenes": [{"scene": n, "role": s.get("role"), "text": s["text"], "estimated_sec": s.get("estimated_sec")}
                   for n, s in enumerate(sections, 1)],
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
        if c["result"] == config.HIT:
            for f in c["findings"]:
                sc = f"장면 {f['scene']}" if f.get("scene") else "전체"
                L.append(f"    · {sc}: 「{f['quote']}」 {f['reason']}")
                if f.get("source_quote"):
                    L.append(f"        넣은 글: 「{f['source_quote']}」")
        if n == "5" and c.get("vague"):
            L.append("    (애매, 걸지 않음) " + ", ".join(f"장면 {v['scene']} 「{v['quote']}」 {v['reason'].split('— ')[-1]}"
                                                for v in c["vague"]))
        if n == "7":
            L.append(f"    읽는 시간 추정 {c['total_sec']}초")
    if r["diagnostics"]:
        L.append("")
        L.append("진단(판정에는 넣지 않음): " + ", ".join(f"기준 {n}" for n in r["diagnostics"]))
    run = r["run"]
    u = run["usage"]
    L.append("")
    L.append(f"모델 {run['model']} ({run['backend']}, effort {run['effort']}) · 호출 {run['calls']}번 · "
             f"{run['sec']}초 · 입력 {u.get('input_tokens', 0) + u.get('cache_creation_input_tokens', 0) + u.get('cache_read_input_tokens', 0)}"
             f" / 출력 {u.get('output_tokens', 0)} 토큰 · 추정 ${run['cost_usd_est']:.4f}")
    return "\n".join(L)
