"""판정기 결과를 채점자 합의와 견준다.

    python tools/evaluate.py results/v1            # 개발용(시험용 10개를 뺀 것)
    python tools/evaluate.py results/v1 --set test # 시험용만

판정 일치(몇 개 중 몇 개, 95% Wilson 구간), 기준선(모든 대본을 가장 흔한 판정으로 냈을 때),
기준마다 「합의가 건 것을 걸었나(놓침)」와 「합의가 안 건 것을 걸었나(잘못 걸음)」를 낸다.
기준 5는 정답도 같은 규칙에서 나오므로 일치를 따로 세지 않는다.
"""

import argparse
import csv
import math
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LABELS = ROOT / "data" / "labels"
CRITERIA = ["c1", "c2", "c3", "c4", "c6", "c8", "c9"]


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return 0.0, 0.0
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return max(0.0, c - h), min(1.0, c + h)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("result_dir")
    ap.add_argument("--set", choices=["dev", "test", "all"], default="dev")
    a = ap.parse_args()

    test_ids = set((LABELS / "test.txt").read_text().split())
    gold = {r["id"]: r for r in csv.DictReader((LABELS / "consensus.csv").open())}
    pred = {r["id"]: r for r in csv.DictReader((Path(a.result_dir) / "summary.csv").open())}
    ids = sorted(i for i in pred if i in gold and (
        a.set == "all" or (a.set == "dev") == (i not in test_ids)))
    n = len(ids)

    hit = sum(pred[i]["verdict"] == gold[i]["verdict"] for i in ids)
    lo, hi = wilson(hit, n)
    common, cnt = Counter(gold[i]["verdict"] for i in ids).most_common(1)[0]
    print(f"대본 {n}개 ({a.set})")
    print(f"판정 일치: {hit}/{n}  (95% 구간 {lo:.0%}~{hi:.0%})")
    print(f"기준선(모두 {common}): {cnt}/{n}")

    print("\n| 합의 \\ 판정기 | 통과 | 보류 | 탈락 |\n|---|---|---|---|")
    for g in ("통과", "보류", "탈락"):
        row = [sum(1 for i in ids if gold[i]["verdict"] == g and pred[i]["verdict"] == p) for p in ("통과", "보류", "탈락")]
        print(f"| {g} | " + " | ".join(map(str, row)) + " |")

    print("\n| 기준 | 합의가 건 수 | 판정기도 걸음 | 놓침 | 잘못 걸음 |\n|---|---|---|---|---|")
    for c in CRITERIA:
        g = {i for i in ids if gold[i][c] == "1"}
        p = {i for i in ids if pred[i][c] == "1"}
        print(f"| {c} | {len(g)} | {len(g & p)} | {len(g - p)} | {len(p - g)} |")

    print("\n판정이 다른 대본")
    for i in ids:
        if pred[i]["verdict"] != gold[i]["verdict"]:
            print(f"- {i}: 합의 {gold[i]['verdict']}, 판정기 {pred[i]['verdict']}")


if __name__ == "__main__":
    main()
