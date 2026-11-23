"""채점 에이전트들의 결과를 모아 기준별 합의(다수결)와 채점자끼리 맞는 정도를 낸다.

    python tools/consensus.py

읽는 것: data/labels/viewer-*.csv
쓰는 것: data/labels/consensus.csv (기준별 다수결과 판정), data/labels/review.md (사람이 확인할 대본 목록)
"""

import csv
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LABELS = ROOT / "data" / "labels"
CRITERIA = ["c1", "c2", "c3", "c4", "c5", "c6", "c8", "c9", "c10"]
FACT = {"c1", "c2"}          # 걸리면 탈락
HOLD = {"c3", "c4", "c5"}    # 하나라도 걸리면 보류 (c5는 data/labels/c5.csv에서 읽음)
STYLE = {"c6", "c8", "c9"}   # 2개 이상이면 보류 (c10은 진단만, c7은 코드로 셈)


def verdict(hit: dict) -> str:
    if any(hit.get(c) for c in FACT):
        return "탈락"
    if any(hit.get(c) for c in HOLD) or sum(bool(hit.get(c)) for c in STYLE) >= 2:
        return "보류"
    return "통과"


def fleiss_kappa(rows: list[list[int]], raters: int) -> float | None:
    """rows: 대본마다 [안 걸림 수, 걸림 수]."""
    n = len(rows)
    if n == 0:
        return None
    p = [sum(r[j] for r in rows) / (n * raters) for j in range(2)]
    pe = sum(x * x for x in p)
    pbar = sum((sum(x * x for x in r) - raters) / (raters * (raters - 1)) for r in rows) / n
    if pe == 1:
        return None
    return (pbar - pe) / (1 - pe)


def main() -> None:
    files = sorted(LABELS.glob("viewer-*.csv"))
    raters = {f.stem: {r["id"]: r for r in csv.DictReader(f.open())} for f in files}
    names = list(raters)
    ids = sorted(set.intersection(*(set(v) for v in raters.values())))
    c5 = {r["id"]: int(r["c5"]) for r in csv.DictReader((LABELS / "c5.csv").open())}
    for n in names:
        for i in ids:
            raters[n][i]["c5"] = c5[i]
    k = len(names)
    print(f"채점자 {k}명: {', '.join(names)} / 대본 {len(ids)}개\n")

    print("| 기준 | 걸린 대본(채점자별) | 셋 다 같음 | Fleiss κ |")
    print("|---|---|---|---|")
    for c in CRITERIA:
        counts = [sum(int(raters[n][i][c]) for i in ids) for n in names]
        rows = [[k - s, s] for s in (sum(int(raters[n][i][c]) for n in names) for i in ids)]
        same = sum(1 for r in rows if 0 in r)
        kappa = fleiss_kappa(rows, k)
        print(f"| {c} | {' / '.join(map(str, counts))} | {same}/{len(ids)} | {'-' if kappa is None else f'{kappa:.2f}'} |")

    out, review = [], []
    for i in ids:
        votes = {c: sum(int(raters[n][i][c]) for n in names) for c in CRITERIA}
        hit = {c: votes[c] * 2 > k for c in CRITERIA}
        each = [verdict({c: int(raters[n][i][c]) for c in CRITERIA}) for n in names]
        v = verdict(hit)
        out.append({"id": i, "verdict": v, **{c: int(hit[c]) for c in CRITERIA}})
        split = [c for c in CRITERIA if 0 < votes[c] < k]
        if len(set(each)) > 1 or v == "탈락":
            review.append((i, v, each, split))

    with (LABELS / "consensus.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["id", "verdict", *CRITERIA])
        w.writeheader()
        w.writerows(out)

    dist = {x: sum(1 for r in out if r["verdict"] == x) for x in ("통과", "보류", "탈락")}
    print(f"\n합의 판정: {dist}")
    print(f"사람이 확인할 대본(채점자 판정이 갈림 또는 합의 탈락): {len(review)}개")

    lines = ["# 확인할 대본", "", "채점자끼리 판정이 갈렸거나 합의가 탈락인 대본입니다. 넣은 글과 대본은 `input/<id>.md`에 있습니다.", "",
             f"| 대본 | 합의 판정 | 채점자별 판정 ({', '.join(names)}) | 의견이 갈린 기준 |", "|---|---|---|---|"]
    for i, v, each, split in review:
        lines.append(f"| {i} | {v} | {' / '.join(each)} | {', '.join(split) or '-'} |")
    (LABELS / "review.md").write_text("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
