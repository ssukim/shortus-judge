"""쇼더스 대본의 장면을 쇼더스 목소리로 받아, 숫자·단위·기호가 어떻게 들렸는지 사람이 적는 확인표를 만든다.

  python tools/listen_sheet.py            # 표기 뽑기 + 소리 받기 + 확인표 만들기
  python tools/listen_sheet.py --no-audio # 소리는 받지 않고 표기 목록과 확인표만

만드는 것
  audio/<대본id>-s<장면번호>.wav   장면 소리(이미 있으면 다시 받지 않음)
  data/listen/tokens.csv          뽑은 표기 목록(대본 id, 장면, 표기, 종류)
  data/listen/sheet.html          확인표. 브라우저로 열어 듣고 적은 뒤 CSV로 내려받는다.

부르는 API: POST /v1/tts/preview(목소리 미리 듣기), GET /v1/meta/quota-status(잔액 확인).
잔액이 줄면 그 자리에서 멈춘다.
"""
import csv
import glob
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE_URL = "https://shortus.viewus.co.kr"
VOICE = {"provider": "internal", "model": "supertonic-3", "voice": "F1",
         "speed": 1.1, "language": "ko", "normalize_numbers": False}
GAP_SEC = 3.5            # 호출 사이 간격. 1분에 17번 남짓으로 20번을 넘지 않는다.
CHECK_EVERY = 20         # 소리를 이만큼 받을 때마다 잔액을 다시 본다.

STRIP = "\"'“”‘’「」『』()[]<>.,!?…·:;"
SYMBOLS = "%~/×℃"
MONEY_NEXT = re.compile(r"^(원|달러|엔|위안)")


def load_key():
    key = os.environ.get("SHORTUS_API_KEY")
    if not key and (ROOT / ".env").exists():
        for line in (ROOT / ".env").read_text().splitlines():
            if line.startswith("SHORTUS_API_KEY="):
                key = line.split("=", 1)[1].strip().strip("'\"")
    if not key:
        sys.exit("SHORTUS_API_KEY가 없습니다(.env).")
    return key


def needs_check(w):
    return bool(re.search(r"[0-9A-Za-z]", w)) or any(c in w for c in SYMBOLS)


def kind_of(t):
    has_num = bool(re.search(r"[0-9]", t))
    if has_num and (re.search(r"[0-9조억만천]\s?(원|달러|엔|위안)", t) or "$" in t or "₩" in t):
        return "금액"
    if has_num and re.search(r"[0-9](년|월|일)", t):
        return "날짜"
    if re.match(r"[A-Za-z]", t):
        return "영문"      # AF-55 같은 모델명
    if has_num:
        return "숫자+단위"
    if re.search(r"[A-Za-z]", t):
        return "영문"
    return "기호"


def extract(text):
    """문장을 낱말로 나누고 확인할 표기를 뽑는다. (낱말 목록, [(표기, 낱말 번호들)])"""
    words = text.split()
    clean = [w.strip(STRIP) for w in words]
    tokens, i = [], 0
    while i < len(words):
        t = clean[i]
        if t and needs_check(t):
            idx = [i]
            # "61만 원을", "3만 5,000원에", "2조 3788억 원을"처럼 띄어 쓴 한 숫자는 한 표기로 묶는다.
            while idx[-1] + 1 < len(words) and re.search(r"[0-9조억만천]$", t):
                nxt = clean[idx[-1] + 1]
                if not (MONEY_NEXT.match(nxt) or (re.search(r"[조억만천]$", t) and re.match(r"[0-9]", nxt))):
                    break
                t = t + " " + nxt
                idx.append(idx[-1] + 1)
            tokens.append((t, idx))
            i = idx[-1] + 1
        else:
            i += 1
    return words, tokens


def call(key, method, path, body=None):
    headers = {"Authorization": f"Bearer {key}"}
    data = None
    if body is not None:
        headers.update({"Content-Type": "application/json", "Accept": "audio/wav"})
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(BASE_URL + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def credits(key):
    return json.loads(call(key, "GET", "/v1/meta/quota-status"))["credits"]["remaining"]


def fetch_audio(scenes, key):
    out_dir = ROOT / "audio"
    out_dir.mkdir(exist_ok=True)
    todo = [s for s in scenes if not (out_dir / s["audio"]).exists()]
    before = credits(key)
    print(f"잔액(시작): {before}  받을 장면: {len(todo)} / {len(scenes)}")
    last = 0.0
    for n, s in enumerate(todo, 1):
        wait = GAP_SEC - (time.monotonic() - last)
        if wait > 0:
            time.sleep(wait)
        last = time.monotonic()
        try:
            wav = call(key, "POST", "/v1/tts/preview", {**VOICE, "text": s["text"]})
        except urllib.error.HTTPError as e:
            msg = e.read().decode("utf-8", "replace")[:200]
            sys.exit(f"{s['audio']}: 미리 듣기 {e.code} {msg} — 멈춤")
        if wav[:4] != b"RIFF":
            sys.exit(f"{s['audio']}: 응답이 WAV가 아님 — 멈춤")
        (out_dir / s["audio"]).write_bytes(wav)
        print(f"  [{n}/{len(todo)}] {s['audio']} {len(wav)} bytes", flush=True)
        if n % CHECK_EVERY == 0:
            now = credits(key)
            if now < before:
                sys.exit(f"잔액이 줄었습니다: {before} -> {now} — 멈춤")
    after = credits(key)
    print(f"잔액(끝): {after}")
    if after < before:
        sys.exit(f"잔액이 줄었습니다: {before} -> {after}")
    return before, after


def html_page(scenes):
    data = json.dumps(scenes, ensure_ascii=False).replace("</", "<\\/")
    return HTML.replace("__DATA__", data)


HTML = r"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>숫자 읽기 확인표</title>
<style>
body{font-family:-apple-system,"Apple SD Gothic Neo",sans-serif;margin:0;background:#f6f6f4;color:#222}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:10px 16px;display:flex;gap:16px;align-items:center;flex-wrap:wrap;z-index:1}
header h1{font-size:17px;margin:0}
#progress{font-weight:600}
main{max-width:860px;margin:0 auto;padding:12px 16px 60px}
.scene{background:#fff;border:1px solid #ddd;border-radius:8px;padding:12px 14px;margin:12px 0}
.scene.done{border-color:#7bb07b}
.meta{font-size:13px;color:#666;margin-bottom:6px}
.text{font-size:17px;line-height:1.6;margin:4px 0 8px}
.text b{background:#fff3b0;padding:0 2px}
audio{width:100%;margin:4px 0 8px}
table{width:100%;border-collapse:collapse;font-size:14px}
td{padding:4px 6px;border-top:1px solid #eee;vertical-align:middle}
td.tok{font-weight:600;white-space:nowrap;width:1%}
td input[type=text]{width:100%;box-sizing:border-box;padding:4px 6px;font-size:14px}
td.judge{white-space:nowrap;width:1%}
td.judge label{margin-right:8px}
button{font-size:14px;padding:6px 12px}
</style></head><body>
<header><h1>숫자 읽기 확인표</h1><span id="progress"></span>
<button id="dl">CSV로 내려받기</button></header>
<main id="list"></main>
<script>
const SCENES = __DATA__;
const KEY = "listen-sheet-v1";
const JUDGE = ["바르게 읽음", "잘못 읽음", "애매"];
let store = {};
try { store = JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { store = {}; }
function save() { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) {} }
function esc(s) { return s.replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c])); }
function id(s, j) { return s.script_id + "|" + s.scene + "|" + j; }

const list = document.getElementById("list");
SCENES.forEach((s, si) => {
  const bold = new Set(s.tokens.flatMap(t => t.words));
  const text = s.words.map((w, i) => bold.has(i) ? "<b>" + esc(w) + "</b>" : esc(w)).join(" ");
  const rows = s.tokens.map((t, j) => {
    const k = id(s, j), v = store[k] || {};
    const radios = JUDGE.map(o => `<label><input type="radio" name="r${si}_${j}" value="${o}" data-k="${esc(k)}"${v.judge === o ? " checked" : ""}> ${o}</label>`).join("");
    return `<tr><td class="tok">${esc(t.token)}</td><td><input type="text" placeholder="들린 소리" data-k="${esc(k)}" value="${esc(v.heard || "")}"></td><td class="judge">${radios}</td></tr>`;
  }).join("");
  const div = document.createElement("section");
  div.className = "scene";
  div.innerHTML = `<div class="meta">${esc(s.script_id)} · 장면 ${s.scene}</div><div class="text">${text}</div><audio controls preload="none" src="../../audio/${esc(s.audio)}"></audio><table>${rows}</table>`;
  list.appendChild(div);
});

function filled(k) { const v = store[k]; return v && v.heard && v.heard.trim() && v.judge; }
function refresh() {
  let total = 0, done = 0;
  SCENES.forEach((s, si) => {
    let all = true;
    s.tokens.forEach((t, j) => { total++; if (filled(id(s, j))) done++; else all = false; });
    list.children[si].classList.toggle("done", all);
  });
  document.getElementById("progress").textContent = `${total}개 중 ${done}개 입력 (장면 ${SCENES.length}개)`;
}
list.addEventListener("input", e => {
  const k = e.target.dataset.k; if (!k) return;
  store[k] = store[k] || {};
  if (e.target.type === "text") store[k].heard = e.target.value;
  if (e.target.type === "radio") store[k].judge = e.target.value;
  save(); refresh();
});
document.getElementById("dl").onclick = () => {
  const q = v => '"' + String(v ?? "").replace(/"/g, '""') + '"';
  const lines = [["대본 id", "장면", "표기", "들린 소리", "판정"].map(q).join(",")];
  SCENES.forEach(s => s.tokens.forEach((t, j) => {
    const v = store[id(s, j)] || {};
    lines.push([s.script_id, s.scene, t.token, v.heard, v.judge].map(q).join(","));
  }));
  const blob = new Blob(["﻿" + lines.join("\r\n")], {type: "text/csv;charset=utf-8"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "listen.csv"; a.click();
  URL.revokeObjectURL(a.href);
};
refresh();
</script></body></html>
"""


def main():
    scenes = []
    for f in sorted(glob.glob(str(ROOT / "data" / "scripts" / "*.json"))):
        d = json.loads(Path(f).read_text(encoding="utf-8"))
        for n, sec in enumerate(d["script"]["sections"], 1):
            words, toks = extract(sec["text"])
            if toks:
                scenes.append({"script_id": d["id"], "scene": n, "text": sec["text"], "words": words,
                               "tokens": [{"token": t, "words": idx, "kind": kind_of(t)} for t, idx in toks],
                               "audio": f"{d['id']}-s{n}.wav"})

    out = ROOT / "data" / "listen"
    out.mkdir(parents=True, exist_ok=True)
    with open(out / "tokens.csv", "w", newline="", encoding="utf-8") as fp:
        w = csv.writer(fp)
        w.writerow(["대본 id", "장면", "표기", "종류"])
        for s in scenes:
            for t in s["tokens"]:
                w.writerow([s["script_id"], s["scene"], t["token"], t["kind"]])
    (out / "sheet.html").write_text(html_page(scenes), encoding="utf-8")

    kinds = {}
    for s in scenes:
        for t in s["tokens"]:
            kinds[t["kind"]] = kinds.get(t["kind"], 0) + 1
    n_sym = sum(any(c in t["token"] for c in SYMBOLS) for s in scenes for t in s["tokens"])
    print(f"장면 {len(scenes)}개, 표기 {sum(kinds.values())}개: {kinds}, 기호가 든 표기 {n_sym}개")

    if "--no-audio" not in sys.argv:
        fetch_audio(scenes, load_key())


if __name__ == "__main__":
    main()
