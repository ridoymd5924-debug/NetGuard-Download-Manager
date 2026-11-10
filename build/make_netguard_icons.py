#!/usr/bin/env python3
"""Generates all original NetGuard artwork (app/tray/extension icons, NSIS installer images).
Run:  python3 build/make_netguard_icons.py      (requires Pillow)"""
from PIL import Image, ImageDraw, ImageFilter, ImageOps
import os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAVY, BLUE, CYAN = (8, 15, 31), (37, 126, 255), (34, 211, 238)

def lerp(a, b, t): return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def logo(size=1024, grey=False, bg=True):
    """Shield + download arrow. Drawn at 1024 and downsampled for crisp edges."""
    S = 1024
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    if bg:  # rounded-square app tile, navy
        tile = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        m = Image.new("L", (S, S), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, S - 1, S - 1], radius=210, fill=255)
        g = Image.new("RGBA", (S, S))
        gd = ImageDraw.Draw(g)
        for y in range(S): gd.line([(0, y), (S, y)], fill=lerp((14, 30, 62), NAVY, y / S) + (255,))
        tile.paste(g, (0, 0), m); img = tile
    # shield polygon (smooth via bezier-ish sampling)
    cx, top, bot = S / 2, 170, 880
    pts = []
    import math
    for i in range(0, 101):
        t = i / 100
        # right side from top-centre down to the tip
        x = cx + 300 * math.sin(math.pi * t * 0.5) ** 0.9 * (1 - t ** 3) + 0
        y = top + (bot - top) * t
        pts.append((x, y))
    right = pts
    left = [(2 * cx - x, y) for x, y in reversed(pts)]
    poly = right + left
    # flatten the top into the classic shield shoulders
    shield = Image.new("L", (S, S), 0)
    sd = ImageDraw.Draw(shield)
    sd.polygon([(cx, top), (cx + 300, top + 70), (cx + 300, 520)] +
               [(cx + 300 * math.cos(math.pi / 2 * k / 30), 520 + 360 * math.sin(math.pi / 2 * k / 30) * 1.0) for k in range(31)][1:] +
               [(cx, bot)], fill=255)
    sd.polygon([(2 * cx - x, y) for x, y in
                [(cx, top), (cx + 300, top + 70), (cx + 300, 520)] +
                [(cx + 300 * math.cos(math.pi / 2 * k / 30), 520 + 360 * math.sin(math.pi / 2 * k / 30)) for k in range(31)][1:] +
                [(cx, bot)]], fill=255)
    sd.rectangle([cx - 300, top + 70, cx + 300, 520], fill=255)
    sd.polygon([(cx - 300, top + 70), (cx, top), (cx + 300, top + 70)], fill=255)
    grad = Image.new("RGBA", (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S): gd.line([(0, y), (S, y)], fill=lerp(BLUE, CYAN, max(0, (y - top) / (bot - top))) + (255,))
    img.paste(grad, (0, 0), shield)
    # inner dark shield plate
    inner = shield.resize((S, S)).filter(ImageFilter.MinFilter(41))
    plate = Image.new("RGBA", (S, S), NAVY + (255,))
    img.paste(plate, (0, 0), inner)
    # download arrow
    d = ImageDraw.Draw(img)
    w = 74
    d.line([(cx, 330), (cx, 600)], fill=(255, 255, 255, 255), width=w)
    d.polygon([(cx - 150, 560), (cx + 150, 560), (cx, 720)], fill=(255, 255, 255, 255))
    d.rounded_rectangle([cx - 175, 745, cx + 175, 745 + 52], radius=26, fill=CYAN + (255,))
    if grey:
        a = img.split()[3]
        img = ImageOps.grayscale(img.convert("RGB")).convert("RGBA")
        img.putalpha(a)
        img = Image.blend(img, Image.new("RGBA", img.size, (120, 120, 120, 0)), 0.0)
    return img.resize((size, size), Image.LANCZOS)

def save(img, *parts):
    p = os.path.join(ROOT, *parts); os.makedirs(os.path.dirname(p), exist_ok=True); img.save(p); return p

# Tauri app icons
base = logo(1024)
for name, s in {"32x32.png": 32, "128x128.png": 128, "128x128@2x.png": 256, "icon.png": 512,
                "Square30x30Logo.png": 30, "Square44x44Logo.png": 44, "Square71x71Logo.png": 71,
                "Square89x89Logo.png": 89, "Square107x107Logo.png": 107, "Square142x142Logo.png": 142,
                "Square150x150Logo.png": 150, "Square284x284Logo.png": 284, "Square310x310Logo.png": 310,
                "StoreLogo.png": 50}.items():
    save(base.resize((s, s), Image.LANCZOS), "src-tauri", "icons", name)
ico = os.path.join(ROOT, "src-tauri", "icons", "icon.ico")
base.resize((256, 256), Image.LANCZOS).save(ico, sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])
base.resize((512, 512), Image.LANCZOS).save(os.path.join(ROOT, "src-tauri", "icons", "icon.icns"))
# tray: no tile, bigger glyph reads better at 16-32px
save(logo(32, bg=False), "src-tauri", "icons", "tray.png")
# Browser extension icons (+ greyed "not connected" variants)
for s in (16, 48, 128):
    save(logo(s), "extension", "chrome", "icons", f"icon{s}.png")
for s in (16, 48):
    save(logo(s, grey=True), "extension", "chrome", "icons", f"icon{s}-off.png")
# NSIS installer artwork (BMP, as required by NSIS)
hdr = Image.new("RGB", (150, 57), NAVY); hdr.paste(logo(48), (96, 4), logo(48))
save(hdr, "src-tauri", "installer", "header.bmp")
side = Image.new("RGB", (164, 314), NAVY); sd = ImageDraw.Draw(side)
for y in range(314): sd.line([(0, y), (164, y)], fill=lerp((14, 30, 62), NAVY, y / 314))
side.paste(logo(120), (22, 40), logo(120))
sd.rectangle([0, 300, 164, 314], fill=BLUE)
save(side, "src-tauri", "installer", "sidebar.bmp")
# SVG master
open(os.path.join(ROOT, "build", "icon.svg"), "w").write('''<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#257eff"/><stop offset="1" stop-color="#22d3ee"/></linearGradient></defs>
  <rect width="512" height="512" rx="105" fill="#0b1a36"/>
  <path d="M256 85 L406 120 V260 C406 340 340 400 256 440 C172 400 106 340 106 260 V120 Z" fill="url(#g)"/>
  <path d="M256 115 L376 143 V258 C376 322 324 372 256 405 C188 372 136 322 136 258 V143 Z" fill="#080f1f"/>
  <path d="M256 165 V300 M196 280 L256 360 L316 280 Z" stroke="#fff" stroke-width="37" stroke-linecap="round" stroke-linejoin="round" fill="#fff"/>
  <rect x="168" y="372" width="176" height="26" rx="13" fill="#22d3ee"/>
</svg>''')
print("icons generated")
