#!/usr/bin/env python3
"""Builds distributable browser-extension packages from the single shared source in extension/chrome.
Output: dist/extensions/netguard-chromium-<ver>.zip   (Chrome, Edge, Brave, Opera, Vivaldi)
        dist/extensions/netguard-firefox-<ver>.zip    (Firefox >= 115, Manifest V3)
Stdlib only. Run: python3 scripts/package_extensions.py"""
import json, os, zipfile, shutil
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "extension", "chrome")
OUT = os.path.join(ROOT, "dist", "extensions")
SHARED = ["ng-core.js", "background.js", "content.js", "inject.js", "popup.html", "popup.js"]
ICONS = ["icon16.png", "icon48.png", "icon128.png", "icon16-off.png", "icon48-off.png"]

def build(name, manifest_path):
    ver = json.load(open(manifest_path))["version"]
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, f"netguard-{name}-{ver}.zip")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(manifest_path, "manifest.json")
        for f in SHARED: z.write(os.path.join(SRC, f), f)
        for f in ICONS: z.write(os.path.join(SRC, "icons", f), f"icons/{f}")
        z.write(os.path.join(ROOT, "LICENSE"), "LICENSE")   # keep upstream MIT notice in every package
        z.write(os.path.join(ROOT, "NOTICE.md"), "NOTICE.md")
    return path

if os.path.isdir(OUT): shutil.rmtree(OUT)
for n, m in (("chromium", os.path.join(SRC, "manifest.json")),
             ("firefox", os.path.join(ROOT, "extension", "firefox", "manifest.json"))):
    print(build(n, m))
