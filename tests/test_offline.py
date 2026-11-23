"""모델을 부르지 않는 부분의 테스트.  python3 -m unittest discover tests"""
import json
import tempfile
import unittest
from pathlib import Path

from judge import checks_code, config, verdict
from judge.checks_llm import parse, vote
from judge.run_all import _failed

H, O, U = config.HIT, config.OK, config.UNKNOWN


def results(**hit):
    """results(c1=H, c6=H) → 기준 1~10, 나머지는 안 걸림."""
    return {n: hit.get(f"c{n}", O) for n in range(1, 11)}


class Verdict(unittest.TestCase):
    def test_pass(self):
        self.assertEqual(verdict.decide(results())[0], config.PASS)

    def test_fact_fails(self):
        for c in ("c1", "c2"):
            self.assertEqual(verdict.decide(results(**{c: H}))[0], config.FAIL)

    def test_hold_any(self):
        for c in ("c3", "c4"):
            self.assertEqual(verdict.decide(results(**{c: H}))[0], config.HOLD)

    def test_notation_fixable_passes(self):
        v, _, diag = verdict.decide(results(c5=H))  # 2.3판(D25): 모두 자동으로 고쳐지면 고친 대본을 내고 진단만
        self.assertEqual((v, diag), (config.PASS, [5]))

    def test_notation_unfixable_holds(self):
        v, why, _ = verdict.decide(results(c5=H), unfixable=["61만 원을"])
        self.assertEqual(v, config.HOLD)
        self.assertIn("61만 원을", why[0])

    def test_style_needs_two(self):
        v, _, diag = verdict.decide(results(c6=H))
        self.assertEqual((v, diag), (config.PASS, [6]))
        self.assertEqual(verdict.decide(results(c6=H, c9=H))[0], config.HOLD)

    def test_diag_only(self):
        v, _, diag = verdict.decide(results(c7=H, c10=H))
        self.assertEqual((v, diag), (config.PASS, [7, 10]))

    def test_unknown_never_passes(self):
        self.assertEqual(verdict.decide(results(c1=U))[0], config.HOLD)
        self.assertEqual(verdict.decide(results(c1=U, c2=H))[0], config.FAIL)
        self.assertEqual(verdict.decide(results(c10=U))[0], config.PASS)  # 진단만인 기준은 판정에 안 씀


class Doubt(unittest.TestCase):
    def test_doubt_holds_not_fails(self):
        v, why, _ = verdict.decide(results(), doubt=[1])
        self.assertEqual(v, config.HOLD)
        self.assertIn("탈락 의심", why[0])

    def test_clear_fail_wins(self):
        self.assertEqual(verdict.decide(results(c2=H), doubt=[1])[0], config.FAIL)


class Notation(unittest.TestCase):
    def check(self, text):
        return checks_code.check_notation([{"text": text}])

    def test_wrong(self):
        for t in ("250g 넣어요", "12,500원입니다", "2.5% 올랐어요", "1,800W의 힘"):
            self.assertEqual(self.check(t)["result"], H, t)

    def test_ok(self):
        for t in ("250그램 넣어요", "3만 원입니다", "12월에 열려요"):
            self.assertEqual(self.check(t)["result"], O, t)

    def test_suggest(self):
        self.assertEqual(checks_code.suggest("1.2kg"), "1.2킬로그램")
        self.assertEqual(checks_code.suggest("124,020원에"), "12만 4020원에")
        self.assertEqual(checks_code.suggest("2.5%"), "2.5퍼센트")
        self.assertIsNone(checks_code.suggest("KTX"))

    def test_fix_script(self):
        secs = [{"text": "무게는 1.2kg이고 124,020원에 팝니다"}, {"text": "그대로"}]
        r = checks_code.check_notation(secs)
        self.assertEqual(r["unfixable"], [])
        self.assertEqual(checks_code.fix_script(secs, r["findings"]),
                         ["무게는 1.2킬로그램이고 12만 4020원에 팝니다", "그대로"])

    def test_vague_is_not_hit(self):
        r = self.check("KTX로 2~3일 걸려요")
        self.assertEqual(r["result"], O)
        self.assertEqual(len(r["vague"]), 2)


class Parse(unittest.TestCase):
    def test_reads_json_in_text(self):
        text = '설명\n{"6": {"hit": true, "findings": [{"scene": 9, "quote": "a"}]}, "8": {"hit": false}, ' \
               '"9": {"hit": false}, "10": {"hit": false}}'
        out = parse(text, "flow", n_scenes=5)
        self.assertEqual(out["criteria"][6]["result"], H)
        self.assertIsNone(out["criteria"][6]["findings"][0]["scene"])  # 없는 장면 번호는 버림

    def test_missing_hit_raises(self):
        with self.assertRaises(ValueError):
            parse('{"6": {}}', "flow", 5)


class Vote(unittest.TestCase):
    def one(self, hit, error=None):
        crit = {1: {"result": H if hit else O, "findings": []}}
        return {"criteria": crit, "grounding": None, "calls": [], "usage": {"input_tokens": 1}, "error": error}

    def test_majority(self):
        self.assertEqual(vote([self.one(True), self.one(False), self.one(False)])["criteria"][1]["result"], O)
        three = lambda hit: {**self.one(hit), "criteria": {3: {"result": H if hit else O, "findings": []}}}
        self.assertEqual(vote([three(True), three(True), three(False)])["criteria"][3]["result"], H)  # 탈락 기준이 아니면 과반

    def test_unanimous_option(self):
        """config.UNANIMOUS에 넣은 기준은 모두 걸림일 때만 걸고, 갈리면 의심(4판, D15). 5판은 비워 둠(D19)."""
        saved = config.UNANIMOUS
        try:
            config.UNANIMOUS = (1,)
            r = vote([self.one(True), self.one(True), self.one(False)])["criteria"][1]
            self.assertEqual((r["result"], r.get("doubt")), (O, True))
            r = vote([self.one(True)] * 3)["criteria"][1]
            self.assertEqual((r["result"], r.get("doubt")), (H, None))
            config.UNANIMOUS = ()
            r = vote([self.one(True), self.one(True), self.one(False)])["criteria"][1]
            self.assertEqual((r["result"], r.get("doubt")), (H, None))
        finally:
            config.UNANIMOUS = saved

    def test_errors_left_out(self):
        r = vote([self.one(True), self.one(False, error="x"), self.one(False, error="x")])
        self.assertEqual((r["criteria"][1]["result"], r["criteria"][1]["votes"]), (H, "1/1"))


class Failed(unittest.TestCase):
    def test_failed_results_are_redone(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "a.json"
            p.write_text(json.dumps({"criteria": {"1": {"result": U, "error": "끊김"}}}))
            self.assertTrue(_failed(p))
            p.write_text(json.dumps({"criteria": {"1": {"result": O, "findings": []}}}))
            self.assertFalse(_failed(p))
            p.write_text("{깨진")
            self.assertTrue(_failed(p))


if __name__ == "__main__":
    unittest.main()
