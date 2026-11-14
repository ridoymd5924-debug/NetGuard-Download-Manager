"""Draws the NetGuard Download Manager logo and builds every app icon size from it.

The logo is a shield (dark navy, emerald rim) holding a download arrow over a tray. It is
drawn here, in code, so the whole icon set can be rebuilt from this one file:

- art/NetGuard Download Manager.png      1024 px master artwork
- crates/app/assets/icons/app/mdm-<size>.png and mdm.ico (the file names are technical ids)
- extension/icons/icon-<size>.png        the browser extension's icons
- docs/images/logo.png                   the README logo (320 px)
- docs/images/social-preview.png         the repository's social preview (1280 x 640)

16-32 px use a bolder variant (thicker rim and arrow): fine lines turn to noise at small sizes.

Colors: navy #0B1220 / #17243A, emerald #10B981 / #34D399, text #F8FAFC.
Run from the repository root: python -I tools/icon/build_icon.py
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / "art" / "NetGuard Download Manager.png"
APP = ROOT / "crates" / "app" / "assets" / "icons" / "app"
EXT = ROOT / "extension" / "icons"
DOCS = ROOT / "docs" / "images"
SIZES = [16, 20, 24, 32, 48, 64, 128, 256]

NAVY_BG = (11, 18, 32)
NAVY_SURFACE = (23, 36, 58)
EMERALD = (16, 185, 129)
EMERALD_LIGHT = (52, 211, 153)
EMERALD_DARK = (5, 150, 105)
TEXT = (248, 250, 252)
MUTED = (148, 163, 184)

SS = 4  # supersampling factor for the master drawing
BASE = 1024


def bezier(p0, p1, p2, p3, n=64):
    pts = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        x = u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0]
        y = u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1]
        pts.append((x, y))
    return pts


def shield(scale=1.0, cx=512.0, cy=520.0):
    """The shield outline as a polygon in 1024-px space, scaled about (cx, cy)."""
    right = bezier((900, 200), (900, 560), (760, 830), (512, 972))
    left = [(1024 - x, y) for x, y in reversed(right)]
    pts = [(512, 56)] + right + left + [(124, 200)]
    return [(cx + (x - cx) * scale, cy + (y - cy) * scale) for x, y in pts]


def gradient(size, top, bottom):
    g = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / max(size - 1, 1)
        g.putpixel((0, y), tuple(round(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return g.resize((size, size))


def render(size, bold=False):
    s = BASE * SS
    k = SS

    def sc(pts):
        return [(x * k, y * k) for x, y in pts]

    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))

    # Rim: emerald gradient shield; face: navy gradient shield inset from it.
    rim_mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(rim_mask).polygon(sc(shield(1.0)), fill=255)
    canvas.paste(gradient(s, EMERALD_LIGHT, EMERALD_DARK).convert("RGBA"), (0, 0), rim_mask)

    inset = 0.86 if bold else 0.915
    face_mask = Image.new("L", (s, s), 0)
    ImageDraw.Draw(face_mask).polygon(sc(shield(inset)), fill=255)
    canvas.paste(gradient(s, NAVY_SURFACE, NAVY_BG).convert("RGBA"), (0, 0), face_mask)

    # Download arrow and tray, emerald, over the navy face.
    arrow = Image.new("L", (s, s), 0)
    d = ImageDraw.Draw(arrow)
    half = 78 if bold else 56
    head = 215 if bold else 190
    top, neck, tip = 250, 470, 650
    d.rectangle([(512 - half) * k, top * k, (512 + half) * k, neck * k], fill=255)
    d.polygon(sc([(512 - head, neck - 6), (512 + head, neck - 6), (512, tip)]), fill=255)
    tray_h = 58 if bold else 46
    d.rounded_rectangle(
        [(512 - 190) * k, 712 * k, (512 + 190) * k, (712 + tray_h) * k],
        radius=(tray_h // 2) * k,
        fill=255,
    )
    canvas.paste(gradient(s, EMERALD_LIGHT, EMERALD).convert("RGBA"), (0, 0), arrow)

    return canvas.resize((size, size), Image.LANCZOS)


def font(size, bold=True):
    name = "DejaVuSans-Bold.ttf" if bold else "DejaVuSans.ttf"
    for base in ("/usr/share/fonts/truetype/dejavu/", "C:/Windows/Fonts/"):
        try:
            return ImageFont.truetype(base + name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def social_preview():
    w, h = 1280, 640
    bg = gradient(h, NAVY_SURFACE, NAVY_BG).resize((w, h))
    im = bg.convert("RGBA")
    logo = render(400)
    im.paste(logo, (110, 120), logo)
    d = ImageDraw.Draw(im)
    d.text((560, 190), "NetGuard", font=font(110), fill=TEXT)
    d.text((560, 320), "Download Manager", font=font(62), fill=EMERALD)
    d.text((564, 420), "Fast, free and open source (GPL-3.0)", font=font(34, False), fill=MUTED)
    d.text((564, 480), "Version 2.2.1.9  -  Made by Torik", font=font(30, False), fill=MUTED)
    return im.convert("RGB")


def main() -> None:
    master = render(BASE)
    ART.parent.mkdir(exist_ok=True)
    master.save(ART)
    icons = {}
    for size in SIZES:
        icons[size] = render(size, bold=size <= 32)
        icons[size].save(APP / f"mdm-{size}.png")
    icons[256].save(
        APP / "mdm.ico",
        sizes=[(s, s) for s in SIZES],
        append_images=[icons[s] for s in SIZES if s != 256],
    )
    for size in (16, 32, 48, 128):
        icons[size].save(EXT / f"icon-{size}.png")
    render(320).save(DOCS / "logo.png")
    social_preview().save(DOCS / "social-preview.png")
    print("wrote the master, sizes", ", ".join(str(s) for s in SIZES), "+ mdm.ico, extension icons, docs images")


if __name__ == "__main__":
    main()
