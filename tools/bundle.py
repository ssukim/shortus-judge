"""채점용 묶음 파일을 만든다. 대본마다 넣은 글과 장면별 문장을 한 파일에 나란히 둔다.

    python tools/bundle.py            # data/labels/input/<대본 id>.md
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "data" / "scripts"
SOURCES = ROOT / "data" / "sources"
OUT = ROOT / "data" / "labels" / "input"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    n = 0
    for path in sorted(SCRIPTS.glob("*.json")):
        d = json.loads(path.read_text())
        s = d["script"]
        source = (SOURCES / f"{d['source_id']}.txt").read_text().strip()
        lines = [
            f"# {d['id']}",
            "",
            f"글 종류: {d['type']}",
            "",
            "## 넣은 글",
            "",
            source,
            "",
            "## 대본",
            "",
            "| 장면 | 역할 | 읽는 문장 |",
            "|---|---|---|",
        ]
        for i, sec in enumerate(s["sections"], 1):
            text = sec["text"].strip().replace("|", "\\|")
            lines.append(f"| {i} | {sec['role']} | {text} |")
        (OUT / f"{d['id']}.md").write_text("\n".join(lines) + "\n")
        n += 1
    print(f"묶음 {n}개 → {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
