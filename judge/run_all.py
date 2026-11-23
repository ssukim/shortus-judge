"""python -m judge.run_all --out results/<이름>  — 대본 32개를 모두 판정. 이미 있는 결과는 건너뛴다."""
import argparse
import csv
import json
from pathlib import Path

from . import config, core

CODE = {config.HIT: 1, config.OK: 0, config.UNKNOWN: "NA"}


def main():
    ap = argparse.ArgumentParser(prog="python -m judge.run_all")
    ap.add_argument("--out", required=True, help="결과 폴더, 예: results/v1")
    ap.add_argument("--set", choices=["dev", "test", "all"], default="dev",
                    help="dev: data/labels/test.txt에 없는 대본(기본), test: 시험용만, all: 모두")
    a = ap.parse_args()
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    files = sorted(config.SCRIPTS.glob("*.json"))
    test_ids = set((config.ROOT / "data" / "labels" / "test.txt").read_text().split())
    if a.set == "dev":
        files = [f for f in files if f.stem not in test_ids]
    elif a.set == "test":
        files = [f for f in files if f.stem in test_ids]
    total_cost = 0.0
    for i, f in enumerate(files, 1):
        dst = out / f.name
        if dst.exists():
            print(f"[{i}/{len(files)}] {f.stem} 건너뜀(결과 있음)")
            continue
        r = core.judge_file(f)
        dst.write_text(json.dumps(r, ensure_ascii=False, indent=1), encoding="utf-8")
        total_cost += r["run"]["cost_usd_est"]
        print(f"[{i}/{len(files)}] {f.stem} {r['verdict']} · {r['run']['sec']}초 · ${r['run']['cost_usd_est']:.4f}",
              flush=True)
    with open(out / "summary.csv", "w", newline="", encoding="utf-8") as fp:
        w = csv.writer(fp)
        w.writerow(["id", "verdict"] + [f"c{n}" for n in range(1, 11)])
        for f in sorted(out.glob("*.json")):
            r = json.loads(f.read_text(encoding="utf-8"))
            w.writerow([r["id"], r["verdict"]] + [CODE.get(r["criteria"][str(n)]["result"], "NA") for n in range(1, 11)])
    print(f"이번 실행 추정 비용 ${total_cost:.4f} · {out / 'summary.csv'}")


if __name__ == "__main__":
    main()
