"""판정 선 (기준표 「판정」 표). 모델이 아니라 이 코드가 정한다.

  탈락  기준 1 또는 2에 걸림
  보류  탈락이 아니고, 기준 3·4 중 하나 이상 또는 기준 6·8·9 중 2개 이상에 걸림
  통과  그 밖
  기준 7, 10은 진단만 낸다. 기준 5(표기)는 고친 대본을 함께 내고, 자동으로 못 고치는 표기가 있을 때만 보류로 낸다(2.3판, D25).
  모델 답을 받지 못한 기준(판정 못 함)이 있으면, 탈락이 아닌 한 보류로 낸다.
  탈락 기준이 「탈락 의심」(여러 번 물어 갈림)이면, 탈락이 아닌 한 보류로 낸다(D15).
"""
from . import config

FAIL_ON = (1, 2)
HOLD_ANY = (3, 4)
HOLD_TWO = (6, 8, 9)
DIAG_ONLY = (5, 7, 10)


def decide(results, doubt=(), unfixable=()):
    """results: {번호: "걸림"|"안 걸림"|"판정 못 함"}, doubt: 탈락 의심인 기준 번호, unfixable: 자동으로 못 고치는 표기 → (판정, 까닭 목록, 진단 목록)
    진단은 걸렸지만 판정을 정하는 데 쓰이지 않은 기준이다."""
    hit = lambda n: results.get(n) == config.HIT
    hits = [n for n in sorted(results) if hit(n)]
    diag = lambda used: [n for n in hits if n not in used]
    if any(hit(n) for n in FAIL_ON):
        used = [n for n in FAIL_ON if hit(n)]
        return config.FAIL, [f"기준 {n} 걸림" for n in used], diag(used)
    used = [n for n in HOLD_ANY if hit(n)]
    why = [f"기준 {n} 걸림" for n in used]
    two = [n for n in HOLD_TWO if hit(n)]
    if len(two) >= 2:
        used += two
        why.append("기준 " + "·".join(map(str, two)) + " 중 2개 이상 걸림")
    why += [f"기준 {n} 탈락 의심(물을 때마다 갈림)" for n in sorted(doubt) if n in FAIL_ON]
    if unfixable:
        used.append(5)
        why.append("기준 5 자동으로 못 고치는 표기: " + ", ".join(unfixable))
    if why:
        return config.HOLD, why, diag(used)
    unknown = [n for n, r in sorted(results.items()) if r == config.UNKNOWN and n not in DIAG_ONLY]
    if unknown:
        return config.HOLD, ["판정 못 한 기준: " + ", ".join(map(str, unknown))], diag([])
    return config.PASS, [], diag([])
