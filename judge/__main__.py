"""python -m judge data/scripts/<id>.json [--json]"""
import argparse
import json

from . import core


def main():
    ap = argparse.ArgumentParser(prog="python -m judge", description="쇼더스 대본 하나를 판정합니다.")
    ap.add_argument("script", help="data/scripts/<id>.json")
    ap.add_argument("--json", action="store_true", help="JSON으로 출력")
    ap.add_argument("--no-revise", action="store_true", help="보류·탈락이어도 고쳐 다시 판정하지 않음")
    a = ap.parse_args()
    r = core.judge_file(a.script, fix=False if a.no_revise else None)
    print(json.dumps(r, ensure_ascii=False, indent=1) if a.json else core.render(r))


if __name__ == "__main__":
    main()
