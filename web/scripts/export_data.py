"""화면 자료 web/public/data.json을 만든다.  python3 web/scripts/export_data.py   (web 폴더에서는 npm run export)

넣는 것
  scripts   대본 98개(data/scripts): 장면, 넣은 글 id, 시험용 표시(data/labels/test.txt), 정답 두 가지
            (다수결 data/labels/consensus.csv, 확신 data/labels/consensus-sure.csv), 쇼더스에서 받은 원본
  sources   넣은 글(data/sources)과 출처(data/SOURCES.md)
  results   최종 판정기(5판) 결과(results/v5-all98)를 지금 판정 선으로 다시 정한 것(judge/view.py의 redecide,
            tools/evaluate.py --redecide와 같은 셈)을 화면 모양(judge/view.py의 to_view)으로
  check     판정기를 정답과 견준 숫자(개발용 48 · 시험용 50 · 전체 98, 다수결 · 확신). tools/evaluate.py와 같은 셈이고,
            끝에 tools/evaluate.py --redecide 출력과 한 줄씩 대조해 다르면 멈춘다
  criteria  기준표(data/labels/rubric.md 2.3판)의 기준 10개와 판정 선

읽기만 하고 data/, results/는 바꾸지 않는다.
"""
import csv
import datetime as dt
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from judge import config, view  # noqa: E402
from tools.evaluate import CRITERIA, redecide as eval_redecide, wilson  # noqa: E402

RESULTS = ROOT / "results" / "v5-all98"
LABELS = ROOT / "data" / "labels"
OUT = ROOT / "web" / "public" / "data.json"
TYPE_NAMES = {"news": "뉴스", "blog": "블로그", "community": "커뮤니티", "product": "제품 소개"}
NTH = ["첫 번째", "두 번째", "세 번째", "네 번째", "다섯 번째"]
TITLE_MAX = 40
SETS = {"dev": "개발용", "test": "시험용", "all": "전체"}
GOLDS = {"all": "consensus.csv", "sure": "consensus-sure.csv"}


def read_csv(path):
    with path.open(encoding="utf-8") as f:
        return {r["id"]: r for r in csv.DictReader(f)}


def source_origins():
    """data/SOURCES.md 표 → {글 id: {kind, title, published, url, license}}"""
    out = {}
    for line in (ROOT / "data" / "SOURCES.md").read_text(encoding="utf-8").splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) != 6 or not re.match(r"^[a-z]+-\d+$", cells[0]):
            continue
        sid, kind, title, published, url, lic = cells
        out[sid] = {"kind": kind, "title": None if title == "(없음)" else title,
                    "published": None if published == "-" else published,
                    "url": None if url == "-" else url, "license": lic,
                    "publisher": "정책브리핑" if "korea.kr" in url else None}
    return out


def source_title(text, meta_title=None):
    """기사는 SOURCES.md의 제목, 나머지는 넣은 글 첫 문장. 길면 자른다."""
    t = meta_title or next((l.strip() for l in text.splitlines() if l.strip()), "")
    t = re.sub(r"\s+", " ", t)
    if len(t) > TITLE_MAX:
        m = re.match(r"(.+?[.?!])(\s|$)", t)
        t = m.group(1) if m and len(m.group(1)) <= TITLE_MAX else t[:TITLE_MAX].rstrip() + "…"
    return t


def label(row):
    return {"verdict": row["verdict"], "flags": [n for n in range(1, 11) if row.get(f"c{n}") == "1"]}


def frac(k, n):
    lo, hi = wilson(k, n)
    return {"k": k, "n": n, "lo": round(lo * 100), "hi": round(hi * 100)}


def check(pred, gold, ids):
    """tools/evaluate.py main()과 같은 셈. pred·gold: {id: {"verdict", "c1"...}}"""
    n = len(ids)
    hit = sum(pred[i]["verdict"] == gold[i]["verdict"] for i in ids)
    top, top_k = Counter(gold[i]["verdict"] for i in ids).most_common(1)[0]
    vs = [config.PASS, config.HOLD, config.FAIL]
    confusion = {g: {p: sum(1 for i in ids if gold[i]["verdict"] == g and pred[i]["verdict"] == p) for p in vs} for g in vs}
    fail = [i for i in ids if gold[i]["verdict"] == config.FAIL]
    leak = [i for i in fail if pred[i]["verdict"] == config.PASS]
    false_fail = [i for i in ids if pred[i]["verdict"] == config.FAIL and gold[i]["verdict"] != config.FAIL]
    crit = {}
    for c in CRITERIA:
        g = {i for i in ids if gold[i][c] == "1"}
        p = {i for i in ids if pred[i][c] == "1"}
        crit[c[1:]] = {"gold": len(g), "both": len(g & p), "miss": len(g - p), "extra": len(p - g)}
    return {
        "n": n, "verdict": frac(hit, n), "baseline": {"top": top, "k": top_k},
        "confusion": confusion, "fail_n": len(fail),
        "fail_as_fail": sum(pred[i]["verdict"] == config.FAIL for i in fail),
        "fail_as_hold": sum(pred[i]["verdict"] == config.HOLD for i in fail),
        "leak": leak, "false_fail": false_fail, "not_fail_n": n - len(fail), "criteria": crit,
        "diffs": [{"id": i, "verdict": pred[i]["verdict"], "gold": gold[i]["verdict"]}
                  for i in ids if pred[i]["verdict"] != gold[i]["verdict"]],
    }


def cross_check(checks):
    """tools/evaluate.py --redecide 출력의 일치·기준선·치명 오류 줄과 data.json의 숫자를 대조한다."""
    for gold in GOLDS:
        for s in SETS:
            c = checks[gold][s]
            out = subprocess.run([sys.executable, str(ROOT / "tools" / "evaluate.py"), str(RESULTS), "--redecide",
                                  "--set", s, "--gold", gold], capture_output=True, text=True, check=True).stdout
            want = [f"판정 일치: {c['verdict']['k']}/{c['n']}",
                    f"기준선(모두 {c['baseline']['top']}): {c['baseline']['k']}/{c['n']}",
                    f"통과로 샘 {len(c['leak'])}", f"잘못 탈락(합의는 통과·보류): {len(c['false_fail'])}"]
            for w in want:
                if w not in out:
                    raise SystemExit(f"tools/evaluate.py 출력과 다름 ({s}, {gold}): 「{w}」가 없음\n{out}")


def main():
    test_ids = set((LABELS / "test.txt").read_text(encoding="utf-8").split())
    golds = {k: read_csv(LABELS / f) for k, f in GOLDS.items()}
    origins = source_origins()

    scripts, source_ids = [], []
    for p in sorted(config.SCRIPTS.glob("*.json")):
        d = json.loads(p.read_text(encoding="utf-8"))
        s = d["script"]
        scripts.append({
            "id": d["id"], "type": d["type"], "type_name": TYPE_NAMES.get(d["type"], d["type"]),
            "source_id": d["source_id"], "total_sec": s.get("estimated_duration_sec"),
            "scenes": [{"n": i, "role": sec.get("role", ""), "sec": sec.get("estimated_sec"), "text": sec["text"]}
                       for i, sec in enumerate(s["sections"], 1)],
            "nth": NTH[sum(1 for x in scripts if x["source_id"] == d["source_id"])],
            "test": d["id"] in test_ids,
            "consensus": {k: label(g[d["id"]]) for k, g in golds.items() if d["id"] in g},
            "shortus": {"script_id": s.get("id"), "text_source_id": s.get("text_source_id"),
                        "collected_at": d.get("collected_at"), "raw": s},
        })
        if d["source_id"] not in source_ids:
            source_ids.append(d["source_id"])

    sources = {}
    for sid in sorted(source_ids):
        text = (config.SOURCES / f"{sid}.txt").read_text(encoding="utf-8")
        origin = origins.get(sid)
        sources[sid] = {"title": source_title(text, (origin or {}).get("title")), "text": text, "origin": origin}

    results = {}
    for p in sorted(RESULTS.glob("*.json")):
        r = view.redecide(json.loads(p.read_text(encoding="utf-8")))
        at = dt.datetime.fromtimestamp(p.stat().st_mtime).astimezone().isoformat(timespec="seconds")
        results[r["id"]] = view.to_view(r, judged_at=at)

    # 화면 숫자와 tools/evaluate.py가 같은 판정을 쓰는지 먼저 본다
    ref = eval_redecide(RESULTS)
    for i, r in results.items():
        if r["verdict"] != ref[i]["verdict"]:
            raise SystemExit(f"{i}: 판정이 tools/evaluate.py --redecide와 다름 ({r['verdict']} ≠ {ref[i]['verdict']})")
    checks = {}
    for gk, g in golds.items():
        checks[gk] = {}
        for s in SETS:
            ids = sorted(i for i in ref if i in g and (s == "all" or (s == "test") == (i in test_ids)))
            checks[gk][s] = check(ref, g, ids)

    data = {
        "criteria": view.criteria_meta(),
        "verdict_rule": view.RULE,
        "verdicts": [config.PASS, config.HOLD, config.FAIL],
        "undecided": config.UNKNOWN,
        "model": config.MODEL,
        "results_dir": str(RESULTS.relative_to(ROOT)),
        "scripts": scripts,
        "sources": sources,
        "results": results,
        "check": checks,
    }
    cross_check(checks)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    t = checks["all"]["test"]
    print(f"{OUT.relative_to(ROOT)}: 대본 {len(scripts)}개(시험용 {sum(s['test'] for s in scripts)}개), 결과 {len(results)}개, "
          f"시험용 일치 {t['verdict']['k']}/{t['n']}, tools/evaluate.py 출력과 같음")


if __name__ == "__main__":
    main()
