"""Build NetGuard Download Manager application and browser-extension icons.

Run from the repository root: python -I tools/icon/build_icon.py
"""
from pathlib import Path
from PIL import Image
ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "art" / "NetGuard Download Manager.png"
APP = ROOT / "crates" / "app" / "assets" / "icons" / "app"
EXT = ROOT / "extension" / "icons"
SIZES = [16, 20, 24, 32, 48, 64, 128, 256]
def main():
    source = Image.open(SRC).convert("RGBA")
    icons = {}
    for size in SIZES:
        icons[size] = source.resize((size, size), Image.Resampling.LANCZOS)
        icons[size].save(APP / f"mdm-{size}.png")
    icons[256].save(APP / "mdm.ico", format="ICO", sizes=[(s, s) for s in SIZES])
    for size in (16, 32, 48, 128):
        icons[size].save(EXT / f"icon-{size}.png")
    print("Built NetGuard app and extension icons")
if __name__ == "__main__":
    main()
