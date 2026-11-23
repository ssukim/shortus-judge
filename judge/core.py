"""대본 하나를 판정한다."""
import json
import time
from pathlib import Path

from . import checks_code, checks_llm, config, listen, verdict


def load_script(path):
    d = json.loads(Path(path).read_text(encoding="utf-8"))
    src = config.SOURCES / f"{d['source_id']}.txt"
    return d, src.read_text(encoding="utf-8")


def judge_file(path, model=None):
    d, source = load_script(path)
    return judge_script(d, source, model)


def judge_script(d, source, model=None):
    """메모리에 든 대본 하나를 판정한다. d: data/scripts/<id>.json과 같은 꼴({"id", "source_id", "script": {"sections"}}),
    source: 넣은 글. 파일을 읽지 않고, 판정 서버(judge/serve.py)도 이 함수를 쓴다."""
    model = model or config.MODEL
    t0 = time.monotonic()
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

    fixed = checks_code.fix_script(sections, criteria[5]["findings"])
    if config.LISTEN:
        heard = listen.check(fixed, [x["text"] for x in sections])
        criteria[5]["listen"] = heard
        for f in heard["findings"]:
            criteria[5]["findings"].append(f)
            criteria[5]["unfixable"].append(f"장면 {f['scene']} 「{f['heard']}」")
        if heard["findings"]:
            criteria[5]["result"] = config.HIT
    v, why, diag = verdict.decide({n: c["result"] for n, c in criteria.items()},
                                  doubt=[n for n, c in criteria.items() if c.get("doubt")],
                                  unfixable=criteria[5]["unfixable"])
    cost = sum(c.get("cost_usd", 0) for c in calls)
    return {
        "id": d["id"], "source_id": d["source_id"], "verdict": v, "why": why,
        "diagnostics": diag,
        "criteria": {str(n): c for n, c in criteria.items()},
        "grounding": llm["fact"]["grounding"],
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
