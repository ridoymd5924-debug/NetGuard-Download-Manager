"""Builds every app icon size from art/NetGuard Download Manager.png (tools/icon/make_netguard_logo.py).

- 48 px and up: the full logo (shield, download arrow and tray line).
- 16-32 px: the same shield with a heavier rim and arrow, and no tray line, which turns to
  noise at small sizes (drawn by make_netguard_logo.draw(simple=True)).

Writes crates/app/assets/icons/app/mdm-<size>.png, mdm.ico (all sizes; the file names are
internal identifiers and stay) and the browser extension's icons. Run from the repository
root: python -I tools/icon/build_icon.py
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "art" / "NetGuard Download Manager.png"
APP = ROOT / "crates" / "app" / "assets" / "icons" / "app"
EXT = ROOT / "extension" / "icons"
SIZES = [16, 20, 24, 32, 48, 64, 128, 256]


def main() -> None:
    import importlib.util

    spec = importlib.util.spec_from_file_location("logo", Path(__file__).with_name("make_netguard_logo.py"))
    logo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(logo)
    full = Image.open(SRC).convert("RGBA")
    simple = logo.draw(simple=True)
    icons = {}
    for size in SIZES:
        base = simple if size <= 32 else full
        icons[size] = base.resize((size, size), Image.LANCZOS)
        icons[size].save(APP / f"mdm-{size}.png")
    big = icons[256]
    big.save(
        APP / "mdm.ico",
        sizes=[(s, s) for s in SIZES],
        append_images=[icons[s] for s in SIZES if s != 256],
    )
    for size in (16, 32, 48, 128):
        icons[size].save(EXT / f"icon-{size}.png")
    print("wrote", ", ".join(str(s) for s in SIZES), "+ mdm.ico + extension icons")


if __name__ == "__main__":
    main()
