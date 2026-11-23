"""개발용 보류·탈락 대본에 고쳐 다시 판정(judge/revise.py)만 돌려 잰다 (D35).

  python3 tools/measure_revise.py [--n 12] [--out results/v5-revise]

원래 대본의 판정은 다시 하지 않고 results/v5 저장본에 지금 판정 선을 다시 적용해(view.redecide) 쓴다.
시험용(data/labels/test.txt) 대본은 쓰지 않는다. 이미 결과가 있으면 다시 돌리지 않고 숫자만 센다.
"""
import argparse
import json
import random
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from judge import config, core, revise, view  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--n", type=int, default=12)
    ap.add_argument("--out", default="results/v5-revise")
    ap.add_argument("--seed", type=int, default=7)
    a = ap.parse_args()
    out = ROOT / a.out
    out.mkdir(parents=True, exist_ok=True)
    test = set((ROOT / "data/labels/test.txt").read_text().split())
    cands = []
    for f in sorted((ROOT / "results/v5").glob("*.json")):
        if f.stem not in test:
            r = view.redecide(json.loads(f.read_text(encoding="utf-8")))
            if revise.needed(r):
                cands.append((f, r))
    random.seed(a.seed)
    pick = random.sample(cands, min(a.n, len(cands)))
    print(f"개발용 보류·탈락 {len(cands)}개 중 {len(pick)}개")

    def one(fr):
        f, r = fr
        dst = out / f.name
        if dst.exists():
            return json.loads(dst.read_text(encoding="utf-8"))
        d, source = core.load_script(ROOT / "data/scripts" / f.name)
        rej = lambda secs: core._judge({**d, "script": {**d["script"], "sections": secs}}, source, config.MODEL)
        revise.run(r, d, source, config.MODEL, rej)
        dst.write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding="utf-8")
        return r

    with ThreadPoolExecutor(4) as ex:
        rs = list(ex.map(one, pick))
    for r in rs:
        rounds = [x["result"]["verdict"] if x["result"] else x["error"] for x in r["revisions"]]
        print(f"{r['id']:<18} {r['verdict']} → {' → '.join(rounds)}  {r['decision']['action']}  ${r['run']['revise_cost_usd']:.4f}")
    first = sum(r["revisions"][0]["result"] is not None and r["revisions"][0]["result"]["verdict"] == config.PASS for r in rs)
    cost = sum(r["run"]["revise_cost_usd"] for r in rs)
    print(f"첫 번째 고친 대본이 통과 {first}/{len(rs)} · 고쳐서 만듦 "
          f"{sum(r['decision']['action'] == 'render_revised' for r in rs)}/{len(rs)} · 평균 ${cost / len(rs):.4f}")


if __name__ == "__main__":
    main()
