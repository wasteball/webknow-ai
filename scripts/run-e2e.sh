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
import pathlib, sys
text = pathlib.Path(sys.argv[1]).read_text(errors="replace")
tail = text[-3000:].replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
print(f"::error::{tail}")
PY
  exit "$code"
fi
