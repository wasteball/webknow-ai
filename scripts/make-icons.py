#!/usr/bin/env python3
"""生成扩展图标（纯标准库，无需 Pillow）。

图形：圆角方块 + 白色对话气泡 + 三个点，表示“在旁边说话的 AI”。
16px 下也能辨认，所以细节一律砍掉。

    python3 scripts/make-icons.py
"""

import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "icon"
SIZES = (16, 32, 48, 128)

ACCENT = (0x8A, 0x3B, 0x12)
INK = (0xFF, 0xFF, 0xFF)


def rounded_rect(x, y, left, top, right, bottom, radius):
    if not (left <= x <= right and top <= y <= bottom):
        return False
    cx = min(max(x, left + radius), right - radius)
    cy = min(max(y, top + radius), bottom - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius**2


def in_triangle(x, y, a, b, c):
    def side(p, q):
        return (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0])

    d1, d2, d3 = side(a, b), side(b, c), side(c, a)
    return not ((d1 < 0 or d2 < 0 or d3 < 0) and (d1 > 0 or d2 > 0 or d3 > 0))


def render(size, scale=8):
    """超采样再降采样，得到平滑边缘。"""
    n = size * scale
    # 每个像素的 (r,g,b,a)，先画底板再画气泡，最后按 scale×scale 取平均。
    rows = []
    for py in range(n):
        row = []
        y = py + 0.5
        for px in range(n):
            x = px + 0.5
            a_bg = rounded_rect(x, y, 0.02 * n, 0.02 * n, 0.98 * n, 0.98 * n, 0.24 * n)
            if not a_bg:
                row.append((0, 0, 0, 0))
                continue
            bubble = rounded_rect(x, y, 0.20 * n, 0.22 * n, 0.80 * n, 0.60 * n, 0.20 * n)
            tail = in_triangle(
                x, y, (0.34 * n, 0.58 * n), (0.28 * n, 0.76 * n), (0.52 * n, 0.58 * n)
            )
            dot = any(
                (x - cx * n) ** 2 + (y - 0.41 * n) ** 2 <= (0.052 * n) ** 2
                for cx in (0.36, 0.50, 0.64)
            )
            if dot:
                row.append((*ACCENT, 255))
            elif bubble or tail:
                row.append((*INK, 255))
            else:
                row.append((*ACCENT, 255))
        rows.append(row)

    pixels = bytearray()
    for by in range(size):
        for bx in range(size):
            r = g = b = a = 0
            for dy in range(scale):
                for dx in range(scale):
                    pr, pg, pb, pa = rows[by * scale + dy][bx * scale + dx]
                    r += pr * pa
                    g += pg * pa
                    b += pb * pa
                    a += pa
            total = scale * scale
            if a == 0:
                pixels += bytes((0, 0, 0, 0))
            else:
                pixels += bytes((r // a, g // a, b // a, a // total))
    return bytes(pixels)


def write_png(path, size, pixels):
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    raw = b"".join(
        b"\x00" + pixels[y * size * 4 : (y + 1) * size * 4] for y in range(size)
    )
    png = (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )
    path.write_bytes(png)
    return len(png)


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        written = write_png(OUT_DIR / f"{size}.png", size, render(size))
        print(f"public/icon/{size}.png  {written} bytes")


if __name__ == "__main__":
    main()
