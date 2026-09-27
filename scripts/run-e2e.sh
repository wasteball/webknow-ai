#!/usr/bin/env bash
# 安装浏览器并跑端到端。失败时把日志尾部打成一条 GitHub 检查注释。
set -u

pnpm exec playwright install --with-deps chromium

mkdir -p test-results
set +e
pnpm test:e2e > test-results/e2e.log 2>&1
code=$?
set -e
if [ "$code" -ne 0 ]; then
  # 不要把整份日志倒进 Actions 输出：太大时后面的检查注释会被丢掉。
  echo "::error::e2e failed with exit ${code}"
  python3 - test-results/e2e.log << 'PY'
import os, pathlib, re, sys
text = pathlib.Path(sys.argv[1]).read_text(errors="replace")
pathlib.Path("e2e-failure.txt").write_text(text)
lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
picked = [ln for ln in lines if re.search(r"Error:|✘|failed|Expected|Received|Timeout", ln)]
if not picked:
    picked = lines[-20:]

def esc(s: str) -> str:
    return s.replace("%", "%25").replace("\r", "").replace("\n", "")[:240]

for ln in picked[-6:]:
    print(f"::error::{esc(ln)}")
summary = os.environ.get("GITHUB_STEP_SUMMARY")
if summary:
    pathlib.Path(summary).write_text("```\n" + "\n".join(lines[-60:]) + "\n```\n")
PY
  exit "$code"
fi
