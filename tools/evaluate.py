"""판정기 결과를 채점자 합의와 견준다.

    python tools/evaluate.py results/v1            # 개발용(data/labels/test.txt에 없는 것)
    python tools/evaluate.py results/v1 --set test # 시험용만
    python tools/evaluate.py results/v4-test --set test --test-list data/labels/test-1.txt  # 예전 시험용 목록으로

판정 일치(몇 개 중 몇 개, 95% Wilson 구간), 기준선(모든 대본을 가장 흔한 판정으로 냈을 때),
기준마다 「합의가 건 것을 걸었나(놓침)」와 「합의가 안 건 것을 걸었나(잘못 걸음)」를 낸다.
기준 5는 정답도 같은 규칙에서 나오므로 일치를 따로 세지 않는다.

    python tools/evaluate.py results/v3 --redecide # 저장한 표 수로 지금 판정 선을 다시 적용(모델을 다시 부르지 않음)
"""

import argparse
import csv
import math
from collections import Counter
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LABELS = ROOT / "data" / "labels"
CRITERIA = ["c1", "c2", "c3", "c4", "c6", "c8", "c9"]
sys.path.insert(0, str(ROOT))


def redecide(result_dir: Path) -> dict:
    """결과 JSON의 기준별 표 수(votes)로 지금 config·verdict의 규칙을 다시 적용해 summary.csv와 같은 꼴로 돌려준다."""
    from judge import config, verdict
    out = {}
    for f in sorted(result_dir.glob("*.json")):
        r = json.loads(f.read_text(encoding="utf-8"))
        res, doubt = {}, []
        for k, c in r["criteria"].items():
            n, v = int(k), c["result"]
            if c.get("votes"):
                hits, total = map(int, c["votes"].split("/"))
                major = hits * 2 > total
                hit = hits == total if n in config.UNANIMOUS else major
                v = config.HIT if hit else config.OK
                if major and not hit:
                    doubt.append(n)
            res[n] = v
        from judge.checks_code import suggest
        unfixable = [f["quote"] for f in r["criteria"]["5"].get("findings", []) if not suggest(f["quote"])]
        code = {config.HIT: "1", config.OK: "0"}
        out[r["id"]] = {"id": r["id"], "verdict": verdict.decide(res, doubt=doubt, unfixable=unfixable)[0],
                        **{f"c{n}": code.get(res[n], "NA") for n in res}}
    return out


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
    ap.add_argument("--test-list", default=str(LABELS / "test.txt"), help="시험용 대본 목록 파일")
    ap.add_argument("--redecide", action="store_true", help="저장한 표 수로 지금 판정 선을 다시 적용")
    a = ap.parse_args()

    test_ids = set(Path(a.test_list).read_text().split())
    gold = {r["id"]: r for r in csv.DictReader((LABELS / "consensus.csv").open())}
    pred = (redecide(Path(a.result_dir)) if a.redecide else
            {r["id"]: r for r in csv.DictReader((Path(a.result_dir) / "summary.csv").open())})
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

    fail = [i for i in ids if gold[i]["verdict"] == "탈락"]
    leak = [i for i in fail if pred[i]["verdict"] == "통과"]
    false_fail = [i for i in ids if pred[i]["verdict"] == "탈락" and gold[i]["verdict"] != "탈락"]
    print(f"\n치명 오류(합의 탈락 {len(fail)}개): 탈락 {sum(pred[i]['verdict'] == '탈락' for i in fail)}, "
          f"보류 {sum(pred[i]['verdict'] == '보류' for i in fail)}, 통과로 샘 {len(leak)}"
          + (f" {leak}" if leak else ""))
    print(f"잘못 탈락(합의는 통과·보류): {len(false_fail)}" + (f" {false_fail}" if false_fail else ""))

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
