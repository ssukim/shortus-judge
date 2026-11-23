"""모델 호출 경로 두 가지. 답 글과 토큰 수를 돌려준다.

  claude-cli (기본)  이 컴퓨터의 Claude Code 로그인으로 `claude -p`를 띄운다.
  api               Anthropic API를 표준 라이브러리(urllib)로 부른다. 키는 .env의 ANTHROPIC_API_KEY.
"""
import json
import os
import subprocess
import tempfile
import urllib.error
import urllib.request

from . import config


class CallFailed(Exception):
    """호출 자체가 실패함(시간 초과, 오류 응답). JSON 읽기 실패와는 다르다."""


# 띄우는 claude에 넘기는 환경 변수. 이 목록에 없는 것(ANTHROPIC_* 키, 이 판정기를 띄운 Claude Code 세션 표시,
# 터미널의 알림 훅 표시 CMUX_* 등)은 넘기지 않는다.
_PASS_ENV = ("PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG", "TERM",
             "CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "XDG_CONFIG_HOME",
             "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
             "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy")


def _cli_env():
    env = {k: v for k, v in os.environ.items() if k in _PASS_ENV or k.startswith("LC_")}
    # 터미널의 claude 감싸기 스크립트가 알림 훅을 끼워 넣지 않게 한다.
    env["CMUX_CLAUDE_HOOKS_DISABLED"] = "1"
    return env


def _cli_command(model):
    """도구 없음, 턴 하나, JSON 출력. 사용자·프로젝트 설정, MCP, 스킬, 훅을 쓰지 않고 세션을 저장하지 않는다."""
    return [config.CLI_COMMAND, "-p", "--output-format", "json", "--model", model,
            "--tools", "", "--max-turns", "1",
            "--system-prompt", config.SYSTEM_PROMPT,
            "--setting-sources", "", "--settings", '{"disableAllHooks": true}',
            "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
            "--disable-slash-commands", "--no-session-persistence",
            "--effort", config.EFFORT, "--permission-prompts", "none"]


def _usage(u):
    return {k: int(u.get(k) or 0) for k in
            ("input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")}


def call_cli(model, prompt):
    # 빈 임시 폴더에서 띄워 저장소의 CLAUDE.md 등을 읽지 않게 한다.
    with tempfile.TemporaryDirectory(prefix="judge-cli-") as cwd:
        try:
            proc = subprocess.run(_cli_command(model), input=prompt, capture_output=True, text=True,
                                  timeout=config.CLI_TIMEOUT_SEC, cwd=cwd, env=_cli_env())
        except subprocess.TimeoutExpired:
            raise CallFailed("timeout")
    try:
        out = json.loads(proc.stdout)
    except json.JSONDecodeError:
        raise CallFailed(f"claude 출력이 JSON이 아님 (종료 코드 {proc.returncode})")
    if out.get("is_error") or out.get("subtype") != "success":
        raise CallFailed(f"claude 오류: {str(out.get('result', ''))[:120]}")
    return str(out.get("result", "")), _usage(out.get("usage") or {})


def _api_key():
    key = os.environ.get("ANTHROPIC_API_KEY")
    env_file = config.ROOT / ".env"
    if not key and env_file.exists():
        for line in env_file.read_text().splitlines():
            if line.startswith("ANTHROPIC_API_KEY="):
                key = line.split("=", 1)[1].strip().strip("'\"")
    if not key:
        raise CallFailed("ANTHROPIC_API_KEY가 없습니다(.env)")
    return key


def call_api(model, prompt):
    body = {"model": model, "max_tokens": config.MAX_TOKENS, "system": config.SYSTEM_PROMPT,
            "output_config": {"effort": config.EFFORT},
            "messages": [{"role": "user", "content": prompt}]}
    req = urllib.request.Request(config.API_URL, data=json.dumps(body).encode("utf-8"), method="POST",
                                 headers={"x-api-key": _api_key(), "anthropic-version": config.API_VERSION,
                                          "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=config.API_TIMEOUT_SEC) as r:
            out = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise CallFailed(f"API {e.code}")
    except (urllib.error.URLError, TimeoutError) as e:
        raise CallFailed(f"API 연결 실패: {e}")
    text = "".join(b.get("text", "") for b in out.get("content", []) if b.get("type") == "text")
    return text, _usage(out.get("usage") or {})


def call(model, prompt):
    return (call_api if config.BACKEND == "api" else call_cli)(model, prompt)


def cost_usd(model, usage):
    p = config.PRICE_PER_MTOK[model]
    inp = (usage["input_tokens"] + usage["cache_creation_input_tokens"] * config.CACHE_WRITE_RATIO
           + usage["cache_read_input_tokens"] * config.CACHE_READ_RATIO)
    return (inp * p["input"] + usage["output_tokens"] * p["output"]) / 1_000_000
