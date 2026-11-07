#!/usr/bin/env python3
"""生成扩展图标（纯标准库，无需 Pillow）。

图形：光点——靛紫径向渐变圆 + 白色内核 + 右上金色星点，与侧栏 logo、划词按钮一致。
16px 下也能辨认，所以光晕砍掉。

    python3 scripts/make-icons.py
"""

import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent.parent / "public" / "icon"
SIZES = (16, 32, 48, 128)

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


def lerp(c1, c2, t):
    return tuple(round(a + (b - a) * t) for a, b in zip(c1, c2))


STOPS = ((0xA5, 0xB4, 0xFC), (0x63, 0x66, 0xF1), (0x5B, 0x21, 0xB6))
STAR = (0xFB, 0xBF, 0x24)


def orb_color(x, y, n):
    """与 BrandMark 同构：r=12/32 的渐变圆、r=4.6 白核、(23.2, 8.8) r=2.3 星点；整体放大到铺满画布。"""
    k = n / 26  # 圆直径 24/32 → 放大让圆约占 92%
    cx = cy = n / 2
    sx, sy = cx + 7.2 * k, cy - 7.2 * k
    if (x - sx) ** 2 + (y - sy) ** 2 <= (2.6 * k) ** 2:
        return STAR
    d = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
    if d > 12 * k:
        return None
    if d <= 4.6 * k:
        return INK
    gx, gy = cx - 0.32 * 12 * k, cy - 0.40 * 12 * k
    t = min(1.0, ((x - gx) ** 2 + (y - gy) ** 2) ** 0.5 / (18 * k))
    return lerp(STOPS[0], STOPS[1], t / 0.55) if t < 0.55 else lerp(STOPS[1], STOPS[2], (t - 0.55) / 0.45)


def render(size, scale=8):
    """超采样再降采样，得到平滑边缘。"""
    n = size * scale
    rows = []
    for py in range(n):
        row = []
        for px in range(n):
            color = orb_color(px + 0.5, py + 0.5, n)
            row.append((0, 0, 0, 0) if color is None else (*color, 255))
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
