#!/usr/bin/env python3
"""视觉读图基准：拿有标准答案的图表截图，测 DeepSeek 视觉模型读数字的准确率、费用与延迟。

    npx playwright test tests/e2e/chart-fixture.spec.ts   # 先造图
    DEEPSEEK_KEY=sk-... python3 scripts/vision-bench.py

为什么要这个：在把视觉纳入产品之前，需要知道它读错有多频繁。
读错是“哑的失败”——用户看不出来，比明说“读不到”危险得多。
"""

import base64
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHART_DIR = ROOT / ".bench" / "charts"
MODEL = "deepseek-v4-flash-vision-exp"
ENDPOINT = "https://api.deepseek.com/chat/completions"

PROMPT = (
    "这张图表里，每个数据点上标注的数值分别是多少？"
    "按从左到右的顺序列出，只返回 JSON：{\"values\":[数字,...]}。"
    "不要包含坐标轴上的刻度数字，不要包含标题里的数字。"
)


def numbers_in(text: str) -> list[float]:
    try:
        parsed = json.loads(text)
        if isinstance(parsed, dict) and isinstance(parsed.get("values"), list):
            return [float(v) for v in parsed["values"] if isinstance(v, (int, float, str))]
    except (json.JSONDecodeError, ValueError, TypeError):
        pass
    found = re.findall(r"-?\d+(?:\.\d+)?", text)
    return [float(v) for v in found]


def same(a: float, b: float) -> bool:
    return abs(a - b) < 0.05


def covers(truth: list[float], got: list[float]) -> tuple[int, int]:
    """返回（读对的个数，应有总数）；允许答案里多出其它数字。"""
    hit = 0
    remaining = list(got)
    for value in truth:
        for index, candidate in enumerate(remaining):
            if same(value, candidate):
                hit += 1
                remaining.pop(index)
                break
    return hit, len(truth)


def call(image: Path, key: str) -> dict:
    payload = {
        "model": MODEL,
        # 思考模式在视觉任务上会把输出预算烧光——实测堆叠柱那张图
        # 烧掉 2000 token 后返回空答案。关闭后 0.4–0.9 秒、答案正确。
        "thinking": {"type": "disabled"},
        "max_tokens": 800,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT},
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": "data:image/png;base64,"
                            + base64.b64encode(image.read_bytes()).decode()
                        },
                    },
                ],
            }
        ],
    }
    request = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=180) as response:
            data = json.load(response)
    except urllib.error.HTTPError as error:
        return {"error": f"HTTP {error.code}: {error.read().decode()[:200]}"}
    elapsed = int((time.time() - started) * 1000)
    content = data["choices"][0]["message"]["content"] or ""
    usage = data.get("usage", {})
    return {
        "content": content,
        "ms": elapsed,
        "prompt_tokens": usage.get("prompt_tokens", 0),
        "completion_tokens": usage.get("completion_tokens", 0),
        "reasoning_tokens": (usage.get("completion_tokens_details") or {}).get(
            "reasoning_tokens", 0
        ),
    }


def main() -> None:
    key = os.environ.get("DEEPSEEK_KEY", "").strip()
    if not key:
        raise SystemExit("需要 DEEPSEEK_KEY 环境变量")
    manifest = json.loads((CHART_DIR / "manifest.json").read_text(encoding="utf-8"))

    rows = []
    for chart in manifest:
        result = call(Path(chart["file"]), key)
        if "error" in result:
            print(f"{chart['id']}: {result['error']}")
            continue
        got = numbers_in(result["content"])
        hit, total = covers(chart["truth"], got)
        exact = hit == total and len(got) == total
        rows.append(
            {
                "id": chart["id"],
                "note": chart["note"],
                "hit": hit,
                "total": total,
                "exact": exact,
                "got": got,
                **{k: v for k, v in result.items() if k != "content"},
            }
        )
        print(
            f"{chart['id']:<22} 读对 {hit}/{total}"
            f"{'  完全正确' if exact else '  ' + str(got)}"
            f"  |  {result['ms']}ms  {result['prompt_tokens']}+{result['completion_tokens']} tokens"
        )

    if not rows:
        return
    hits = sum(r["hit"] for r in rows)
    total = sum(r["total"] for r in rows)
    exact_count = sum(1 for r in rows if r["exact"])
    avg_ms = sum(r["ms"] for r in rows) / len(rows)
    avg_in = sum(r["prompt_tokens"] for r in rows) / len(rows)
    avg_out = sum(r["completion_tokens"] for r in rows) / len(rows)

    print("\n=== 汇总 ===")
    print(f"数值读对率：{hits}/{total} = {hits / total:.0%}")
    print(f"整图全对：{exact_count}/{len(rows)} = {exact_count / len(rows):.0%}")
    print(f"平均延迟：{avg_ms / 1000:.1f}s")
    print(f"平均每张图：输入 {avg_in:.0f} tokens，输出 {avg_out:.0f} tokens")
    (CHART_DIR / "result.json").write_text(
        json.dumps(rows, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"明细已写入 {CHART_DIR / 'result.json'}")


if __name__ == "__main__":
    main()
