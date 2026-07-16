#!/usr/bin/env python3
"""Generate CompetitorScout app icons (PNG / ICNS / ICO). Requires Pillow + macOS iconutil for .icns."""
from __future__ import annotations

import io
import math
import os
import struct
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "build"
DOCS = ROOT / "docs"
SIZE = 1024


def lerp(a, b, t):
    return a + (b - a) * t


def lerp_color(c1, c2, t):
    return tuple(int(lerp(c1[i], c2[i], t)) for i in range(3))


def rounded_mask(size, radius):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    return m


def make_icon(size=SIZE):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    px = img.load()
    c_top = (18, 28, 56)
    c_bot = (8, 10, 20)
    c_glow = (91, 140, 255)
    c_accent = (167, 139, 250)
    for y in range(size):
        t = y / (size - 1)
        base = lerp_color(c_top, c_bot, t)
        for x in range(size):
            g = (x + y) / (2 * (size - 1))
            r = int(lerp(base[0], lerp(c_glow[0], c_accent[0], g) * 0.35 + base[0] * 0.65, 0.25))
            gg = int(lerp(base[1], lerp(c_glow[1], c_accent[1], g) * 0.35 + base[1] * 0.65, 0.25))
            b = int(lerp(base[2], lerp(c_glow[2], c_accent[2], g) * 0.35 + base[2] * 0.65, 0.25))
            dx, dy = x / size - 0.25, y / size - 0.2
            glow = math.exp(-(dx * dx + dy * dy) * 6) * 0.35
            r = min(255, int(r + c_glow[0] * glow * 0.4))
            gg = min(255, int(gg + c_glow[1] * glow * 0.4))
            b = min(255, int(b + c_glow[2] * glow * 0.4))
            px[x, y] = (r, gg, b, 255)

    draw = ImageDraw.Draw(img, "RGBA")
    cx = cy = size // 2
    s = size

    for i, rad in enumerate([0.22, 0.34, 0.46]):
        r = int(s * rad)
        a = 55 - i * 12
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=(91, 140, 255, a), width=max(2, s // 180))

    sweep = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sweep, "RGBA")
    R = int(s * 0.46)
    steps = 40
    pts = [(cx, cy)]
    for i in range(steps + 1):
        ang = math.radians(-95 + 55 * (i / steps))
        pts.append((cx + R * math.cos(ang), cy + R * math.sin(ang)))
    sd.polygon(pts, fill=(91, 140, 255, 45))
    ang0 = math.radians(-40)
    sd.line(
        [(cx, cy), (cx + R * math.cos(ang0), cy + R * math.sin(ang0))],
        fill=(167, 139, 250, 180),
        width=max(3, s // 160),
    )
    sweep = sweep.filter(ImageFilter.GaussianBlur(radius=s // 80))
    img = Image.alpha_composite(img, sweep)
    draw = ImageDraw.Draw(img, "RGBA")

    dots = [
        (-0.72, -0.38, (244, 63, 94)),
        (0.55, -0.55, (251, 191, 36)),
        (0.78, 0.22, (45, 212, 191)),
        (-0.48, 0.68, (167, 139, 250)),
        (0.15, 0.82, (56, 189, 248)),
    ]
    ring_r = s * 0.34
    for nx, ny, col in dots:
        x = cx + nx * ring_r
        y = cy + ny * ring_r
        rad = max(10, s // 28)
        for g in range(3, 0, -1):
            gr = rad + g * (s // 90)
            draw.ellipse([x - gr, y - gr, x + gr, y + gr], fill=(*col, 25 * g))
        draw.ellipse([x - rad, y - rad, x + rad, y + rad], fill=(*col, 255))
        hr = rad * 0.35
        draw.ellipse(
            [x - rad * 0.4, y - rad * 0.45, x - rad * 0.4 + hr * 2, y - rad * 0.45 + hr * 2],
            fill=(255, 255, 255, 120),
        )

    diamond_r = s * 0.11
    diamond = [
        (cx, cy - diamond_r * 1.15),
        (cx + diamond_r, cy),
        (cx, cy + diamond_r * 1.15),
        (cx - diamond_r, cy),
    ]
    draw.polygon(diamond, fill=(91, 140, 255, 255))
    inner = s * 0.055
    diamond2 = [
        (cx, cy - inner * 1.1),
        (cx + inner, cy),
        (cx, cy + inner * 1.1),
        (cx - inner, cy),
    ]
    draw.polygon(diamond2, fill=(167, 200, 255, 255))
    draw.line(diamond + [diamond[0]], fill=(200, 220, 255, 220), width=max(2, s // 200))

    spec = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(spec, "RGBA")
    sd.ellipse([s * 0.1, -s * 0.15, s * 0.9, s * 0.45], fill=(255, 255, 255, 28))
    spec = spec.filter(ImageFilter.GaussianBlur(radius=s // 20))
    img = Image.alpha_composite(img, spec)

    radius = int(size * 0.223)
    mask = rounded_mask(size, radius)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0))
    out.putalpha(mask)
    border = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    bd = ImageDraw.Draw(border, "RGBA")
    bd.rounded_rectangle(
        [1, 1, size - 2, size - 2],
        radius=radius,
        outline=(255, 255, 255, 35),
        width=max(2, size // 256),
    )
    return Image.alpha_composite(out, border)


def write_ico(icon: Image.Image, path: Path):
    sizes = [16, 32, 48, 64, 128, 256]
    png_blobs = []
    for s in sizes:
        im = icon.resize((s, s), Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        png_blobs.append((s, buf.getvalue()))
    count = len(sizes)
    header = struct.pack("<HHH", 0, 1, count)
    entries = b""
    offset = 6 + 16 * count
    data = b""
    for s, blob in png_blobs:
        w = 0 if s >= 256 else s
        h = 0 if s >= 256 else s
        entries += struct.pack("<BBBBHHII", w, h, 0, 0, 1, 32, len(blob), offset)
        data += blob
        offset += len(blob)
    path.write_bytes(header + entries + data)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    DOCS.mkdir(parents=True, exist_ok=True)
    icon = make_icon(1024)
    icon.save(OUT / "icon.png")
    for s in (512, 256, 128):
        icon.resize((s, s), Image.Resampling.LANCZOS).save(OUT / f"icon-{s}.png")
    icon.resize((192, 192), Image.Resampling.LANCZOS).save(DOCS / "icon-192.png")
    icon.resize((32, 32), Image.Resampling.LANCZOS).save(DOCS / "favicon.png")
    write_ico(icon, OUT / "icon.ico")

    iconset = OUT / "icon.iconset"
    iconset.mkdir(exist_ok=True)
    mac_map = {
        "icon_16x16.png": 16,
        "diana.k@example.org": 32,
        "icon_32x32.png": 32,
        "ivan.p@example.net": 64,
        "icon_128x128.png": 128,
        "wendy.h@example.net": 256,
        "icon_256x256.png": 256,
        "wendy.h@example.net": 512,
        "icon_512x512.png": 512,
        "walt.e@example.net": 1024,
    }
    for name, px in mac_map.items():
        icon.resize((px, px), Image.Resampling.LANCZOS).save(iconset / name, format="PNG")

    if sys.platform == "darwin":
        subprocess.check_call(["iconutil", "-c", "icns", str(iconset), "-o", str(OUT / "icon.icns")])
        print("wrote", OUT / "icon.icns")
    else:
        print("skip icns (not macOS); PNG/ICO ready")

    print("wrote", OUT / "icon.png")
    print("wrote", OUT / "icon.ico")
    print("wrote", DOCS / "favicon.png")


if __name__ == "__main__":
    main()
