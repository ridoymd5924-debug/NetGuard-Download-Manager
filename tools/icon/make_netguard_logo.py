"""Draws the NetGuard logo (a shield with a download arrow) and writes art/NetGuard Download Manager.png.

Palette: navy #0B1220 / #17243A, emerald #10B981 / #059669, text #F8FAFC.
tools/icon/build_icon.py then makes every app icon size from that file.
Run from the repository root: python -I tools/icon/make_netguard_logo.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "art" / "NetGuard Download Manager.png"
S = 2048  # drawing size; everything is relative to it


def bez(p0, p1, p2, p3, n=48):
    pts = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        pts.append((
            u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
            u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1],
        ))
    return pts


def shield(cx, top, w, h):
    """Outline of a heraldic shield: flat-ish top with a notch, straight sides, curved point."""
    l, r = cx - w / 2, cx + w / 2
    shoulder = top + h * 0.10
    mid = top + h * 0.52
    pts = [(l, shoulder), (cx, top)]                   # left shoulder up to the crest
    pts += [(r, shoulder)]                             # down to the right shoulder
    pts += [(r, mid)]
    pts += bez((r, mid), (r, top + h * 0.80), (cx + w * 0.22, top + h * 0.93), (cx, top + h))
    pts += bez((cx, top + h), (cx - w * 0.22, top + h * 0.93), (l, top + h * 0.80), (l, mid))
    return pts


def vgrad(size, box, c0, c1):
    im = Image.new("RGBA", size)
    d = ImageDraw.Draw(im)
    y0, y1 = box[1], box[3]
    for y in range(size[1]):
        t = min(1, max(0, (y - y0) / max(1, y1 - y0)))
        d.line([(0, y), (size[0], y)], fill=tuple(int(c0[i] + (c1[i] - c0[i]) * t) for i in range(3)) + (255,))
    return im


def draw(simple=False):
    k = 4  # supersample on top of S for clean edges
    N = S * k // 2
    img = Image.new("RGBA", (N, N), (0, 0, 0, 0))
    cx, top, w, h = N / 2, N * 0.055, N * 0.80, N * 0.89
    outer = shield(cx, top, w, h)
    # emerald rim
    mask = Image.new("L", (N, N), 0)
    ImageDraw.Draw(mask).polygon(outer, fill=255)
    rim = vgrad((N, N), (0, int(top), 0, int(top + h)), (0x34, 0xD3, 0x99), (0x05, 0x96, 0x69))
    img.paste(rim, (0, 0), mask)
    # navy face, inset
    inset = N * (0.060 if simple else 0.045)
    inner = shield(cx, top + inset * 1.15, w - 2 * inset, h - inset * 2.1)
    m2 = Image.new("L", (N, N), 0)
    ImageDraw.Draw(m2).polygon(inner, fill=255)
    face = vgrad((N, N), (0, int(top), 0, int(top + h)), (0x17, 0x24, 0x3A), (0x0B, 0x12, 0x20))
    img.paste(face, (0, 0), m2)
    d = ImageDraw.Draw(img)
    green = (0x10, 0xB9, 0x81, 255)
    # download arrow: stem, head, and a tray line
    stem_w = N * (0.150 if simple else 0.120)
    a_top, a_neck = N * 0.235, N * 0.470
    head_w, head_tip = N * (0.470 if simple else 0.440), N * (0.690 if simple else 0.665)
    d.rectangle([cx - stem_w / 2, a_top, cx + stem_w / 2, a_neck + 1], fill=green)
    d.polygon([(cx - head_w / 2, a_neck), (cx + head_w / 2, a_neck), (cx, head_tip)], fill=green)
    if not simple:
        tray_y, tray_w, tray_h = N * 0.735, N * 0.40, N * 0.052
        d.rounded_rectangle([cx - tray_w / 2, tray_y, cx + tray_w / 2, tray_y + tray_h], radius=tray_h / 2, fill=(0xF8, 0xFA, 0xFC, 255))
    return img.resize((S, S), Image.LANCZOS)


def main():
    draw().save(OUT)
    print("wrote", OUT)


if __name__ == "__main__":
    main()
