"""쇼더스 API로 data/sources/의 글마다 대본을 받아 data/scripts/에 저장한다.

부르는 호출은 네 가지뿐이다. 영상 만들기(produce, render)는 부르지 않는다.
  POST /v1/t2s/text-sources   글 등록
  POST /v1/t2s/scripts        대본 만들기
  GET  /v1/t2s/scripts/{id}   대본 조회
  GET  /v1/meta/quota-status  잔액 조회

저장소 루트에서 실행한다.
  python tools/collect.py --per-source 2
  python tools/collect.py --only news-01 --per-source 1
  python tools/collect.py --dry-run
"""

import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

BASE_URL = "https://shortus.viewus.co.kr"
ROOT = Path(__file__).resolve().parent.parent
SOURCES_DIR = ROOT / "data" / "sources"
OUT_DIR = ROOT / "data" / "scripts"
INDEX_PATH = OUT_DIR / "index.csv"
TYPES = ("news", "blog", "community", "product")
KST = timezone(timedelta(hours=9))

# 한도: 분당 60회, 대본 만들기 같은 무거운 호출은 분당 10회, 동시 작업 1개.
GAP_SEC = 8            # 대본 하나 끝나고 다음 대본까지 쉬는 시간
POLL_SEC = 3           # 응답에 poll_after_seconds가 없을 때 조회 간격
POLL_TIMEOUT_SEC = 300
RETRIES = 5            # 429·503일 때 다시 부르는 횟수
RUNNING = {"pending", "queued", "generating", "running", "processing"}
FAILED = {"failed", "error", "cancelled"}


def load_key():
    key = os.environ.get("SHORTUS_API_KEY", "").strip()
    env = ROOT / ".env"
    if not key and env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            name, _, value = line.partition("=")
            if name.strip() == "SHORTUS_API_KEY":
                key = value.strip().strip("'\"")
    if not key:
        sys.exit("SHORTUS_API_KEY가 없습니다. 환경 변수나 .env에 넣어 주세요.")
    return key


def call(key, method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Authorization": f"Bearer {key}", "Accept": "application/json"}
    if data:
        headers["Content-Type"] = "application/json"
    for attempt in range(RETRIES + 1):
        req = urllib.request.Request(BASE_URL + path, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 503) and attempt < RETRIES:
                wait = e.headers.get("Retry-After", "")
                wait = int(wait) if wait.isdigit() else 30
                print(f"  {e.code} 응답, {wait}초 뒤 다시 부릅니다")
                time.sleep(wait)
                continue
            text = e.read().decode("utf-8", "replace")[:300]
            raise RuntimeError(f"{method} {path} -> {e.code} {text}") from None


def daily_left(key):
    """오늘 더 만들 수 있는 대본 수(daily_t2s_starts)와 풀리는 시각."""
    q = call(key, "GET", "/v1/meta/quota-status").get("daily_t2s_starts") or {}
    if "limit" not in q:
        return None, ""
    return max(0, q["limit"] - q.get("used", 0)), q.get("resets_at", "")


def credits(key):
    return call(key, "GET", "/v1/meta/quota-status")["credits"]["remaining"]


def read_source(path):
    """글 파일에는 제목 줄이 따로 없다. 제목은 글 id, 본문은 파일 전체."""
    return path.stem, path.read_text(encoding="utf-8").strip()


def source_type(source_id):
    head = source_id.split("-")[0]
    return head if head in TYPES else "unknown"


def get_script(key, title, body):
    ts = call(key, "POST", "/v1/t2s/text-sources", {"title": title, "body": body, "language": "ko"})
    created = call(key, "POST", "/v1/t2s/scripts", {"text_source_id": ts["id"]})
    start = time.monotonic()
    while True:
        s = call(key, "GET", f"/v1/t2s/scripts/{created['id']}")
        status = s.get("status")
        if status in FAILED or s.get("error"):
            raise RuntimeError(f"대본 실패: status={status} error={s.get('error')}")
        if status not in RUNNING and s.get("poll_after_seconds") is None:
            return s
        if time.monotonic() - start > POLL_TIMEOUT_SEC:
            raise RuntimeError(f"{POLL_TIMEOUT_SEC}초 안에 끝나지 않음: status={status}")
        time.sleep(s.get("poll_after_seconds") or POLL_SEC)


def write_index():
    rows = []
    for p in sorted(OUT_DIR.glob("*.json")):
        d = json.loads(p.read_text(encoding="utf-8"))
        s = d.get("script") or {}
        sections = s.get("sections")
        rows.append([d["id"], d["source_id"], d["type"],
                     len(sections) if isinstance(sections, list) else "",
                     s.get("estimated_duration_sec", ""), d["collected_at"]])
    with INDEX_PATH.open("w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["id", "source_id", "type", "sections", "estimated_duration_sec", "collected_at"])
        w.writerows(rows)
    return len(rows)


def main():
    ap = argparse.ArgumentParser(description="쇼더스 대본 모으기")
    ap.add_argument("--per-source", type=int, default=2, help="글 하나당 받을 대본 수")
    ap.add_argument("--only", nargs="+", help="이 글 id만 (예: news-01 blog-02)")
    ap.add_argument("--dry-run", action="store_true", help="API를 부르지 않고 할 일만 출력")
    args = ap.parse_args()

    sources = sorted(SOURCES_DIR.glob("*.txt"))
    if args.only:
        sources = [p for p in sources if p.stem in args.only]
    if not sources:
        sys.exit("넣을 글이 없습니다: data/sources/")

    todo = []
    for p in sources:
        for n in range(1, args.per_source + 1):
            out_id = f"{p.stem}-g{n}"
            if (OUT_DIR / f"{out_id}.json").exists():
                print(f"건너뜀 {out_id} (이미 있음)")
            else:
                todo.append((out_id, p))
    print(f"할 일 {len(todo)}개")

    if args.dry_run:
        for out_id, p in todo:
            title, body = read_source(p)
            print(f"  {out_id} [{source_type(p.stem)}] 제목 '{title[:30]}', 본문 {len(body)}자")
        return

    key = load_key()
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    start = credits(key)
    print(f"시작 잔액 {start}")
    left, resets = daily_left(key)
    if left is not None:
        print(f"오늘 남은 대본 만들기 {left}번 (풀리는 시각 {resets})")
        if left == 0:
            sys.exit("하루 대본 만들기 한도를 다 썼습니다. 풀린 뒤에 다시 실행하세요.")
        if left < len(todo):
            print(f"할 일 {len(todo)}개 가운데 앞의 {left}개만 받습니다.")
            todo = todo[:left]
    done = 0
    try:
        for i, (out_id, p) in enumerate(todo):
            if i:
                time.sleep(GAP_SEC)
            title, body = read_source(p)
            try:
                script = get_script(key, title, body)
            except RuntimeError as e:
                print(f"실패 {out_id}: {e}")
            else:
                rec = {"id": out_id, "source_id": p.stem, "type": source_type(p.stem),
                       "collected_at": datetime.now(KST).isoformat(timespec="seconds"),
                       "script": script}
                path = OUT_DIR / f"{out_id}.json"
                path.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
                done += 1
                print(f"받음 {out_id}")
            now = credits(key)
            if now < start:
                print(f"잔액이 줄었습니다 ({start} -> {now}). 멈춥니다.")
                break
    finally:
        n = write_index()
        end = credits(key)
        print(f"끝 잔액 {end} (시작 {start}), 이번에 받은 대본 {done}개, 모두 {n}개")
    if end < start:
        sys.exit(1)


if __name__ == "__main__":
    main()
