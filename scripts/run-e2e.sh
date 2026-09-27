#!/usr/bin/env bash
# 安装浏览器并跑端到端。失败时把日志尾部打成一条 GitHub 检查注释。
set -u

pnpm exec playwright install --with-deps chromium

mkdir -p test-results
set +e
pnpm test:e2e > test-results/e2e.log 2>&1
code=$?
set -e
cat test-results/e2e.log
if [ "$code" -ne 0 ]; then
  python3 - test-results/e2e.log << 'PY'
import os, pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text(errors="replace")
lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
picked = [ln for ln in lines if re.search(r"Error:|✘|failed|Expected|Received|Timeout", ln)]
if not picked:
    picked = lines[-20:]

def esc(s: str) -> str:
    return s.replace("%", "%25").replace("\r", "").replace("\n", "")[:300]

for ln in picked[-8:]:
    print(f"::error::{esc(ln)}")
summary = os.environ.get("GITHUB_STEP_SUMMARY")
if summary:
    pathlib.Path(summary).write_text("```\n" + "\n".join(lines[-80:]) + "\n```\n")
PY
  exit "$code"
fi
