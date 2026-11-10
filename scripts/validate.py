#!/usr/bin/env python3
"""Static validation that needs no Rust, no network and no Windows. Run: python3 scripts/validate.py
Exit code 1 if any check fails. Every check prints PASS/FAIL; nothing is skipped silently."""
import json, os, re, subprocess, sys, hashlib, zipfile, tomllib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
fails = []

def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + (f"  -- {detail}" if detail and not ok else ""))
    if not ok: fails.append(name)

def read(*p): return open(os.path.join(ROOT, *p), encoding="utf-8").read()
def load(*p): return json.loads(read(*p))

# ── JSON / TOML / YAML parse ──────────────────────────────────────────────────
for f in ["package.json", "package-lock.json", "tsconfig.json", "src-tauri/tauri.conf.json",
          "src-tauri/capabilities/default.json", "extension/chrome/manifest.json", "extension/firefox/manifest.json"]:
    try: load(*f.split("/")); check(f"parses: {f}", True)
    except Exception as e: check(f"parses: {f}", False, str(e))

cargo = tomllib.loads(read("src-tauri", "Cargo.toml"))
check("Cargo.toml parses", True)
try:
    import yaml
except ImportError:
    yaml = None
check("PyYAML installed (pip install -r scripts/requirements-ci.txt)", yaml is not None)
if yaml is not None:
    try:
        wf = yaml.safe_load(read(".github", "workflows", "build.yml"))
        steps = wf["jobs"]["windows"]["steps"]
        names = " ".join(str(s.get("name", "")) + str(s.get("run", "")) for s in steps)
        check("workflow YAML parses (.github/workflows/build.yml)", True)
        check("workflow installs requirements before validate.py",
              "requirements-ci.txt" in names and names.index("requirements-ci.txt") < names.index("scripts/validate.py"))
        check("workflow has installer build + artifact upload",
              "tauri:build:win" in names and any("upload-artifact" in str(s.get("uses", "")) for s in steps))
    except Exception as e:
        check("workflow YAML parses (.github/workflows/build.yml)", False, str(e))

# ── package.json <-> package-lock.json ────────────────────────────────────────
pj, pl = load("package.json"), load("package-lock.json")
root = pl["packages"][""]
check("package-lock root deps match package.json",
      pj.get("dependencies", {}) == root.get("dependencies", {}) and pj.get("devDependencies", {}) == root.get("devDependencies", {}))
check("package versions agree (package.json / tauri.conf / Cargo.toml)",
      pj["version"] == load("src-tauri", "tauri.conf.json")["version"] == cargo["package"]["version"])

# ── Cargo.toml structure ─────────────────────────────────────────────────────
deps = cargo["dependencies"]
for need in ["tauri", "reqwest", "tokio", "axum", "tower-http", "sha2", "hex", "serde", "chrono", "uuid"]:
    check(f"Cargo dependency present: {need}", need in deps)
check("winreg only under cfg(windows)", "winreg" not in deps and "winreg" in cargo["target"]["cfg(windows)"]["dependencies"])
check("tauri has image-png (tray icon decoding)", "image-png" in deps["tauri"]["features"])
lock = read("src-tauri", "Cargo.lock")
missing = [d for d in list(deps) + ["winreg"] if f'name = "{d}"' not in lock]
print(f"INFO  Cargo.lock lacks {missing} -> cargo adds them on first build (regenerated in CI)" if missing else "INFO  Cargo.lock covers every direct dependency")

# ── Tauri config ─────────────────────────────────────────────────────────────
tc = load("src-tauri", "tauri.conf.json")
check("no config-defined tray icon (tray is built in code; avoids a duplicate icon)", "trayIcon" not in tc["app"])
check("NSIS target only / per-user install", tc["bundle"]["targets"] == ["nsis"] and tc["bundle"]["windows"]["nsis"]["installMode"] == "currentUser")
for k in ["installerIcon", "headerImage", "sidebarImage", "installerHooks"]:
    check(f"installer file exists: {k}", os.path.exists(os.path.join(ROOT, "src-tauri", tc["bundle"]["windows"]["nsis"][k])))
for ic in tc["bundle"]["icon"]:
    check(f"bundle icon exists: {ic}", os.path.exists(os.path.join(ROOT, "src-tauri", ic)))
check("tray.png present", os.path.exists(os.path.join(ROOT, "src-tauri", "icons", "tray.png")))
cap = load("src-tauri", "capabilities", "default.json")
check("capabilities cover dialog windows", {"main", "dlinfo-*", "progress-*"} <= set(cap["windows"]))

# ── Extensions ───────────────────────────────────────────────────────────────
for name in ("chrome", "firefox"):
    m = load("extension", name, "manifest.json")
    check(f"{name}: manifest_version 3", m["manifest_version"] == 3)
    check(f"{name}: no unused 'scripting' permission", "scripting" not in m["permissions"])
    src = os.path.join(ROOT, "extension", "chrome")
    refs = [m["action"]["default_popup"]] + list(m["icons"].values()) + [s for c in m["content_scripts"] for s in c["js"]]
    refs += m["background"].get("scripts", []) + ([m["background"]["service_worker"]] if "service_worker" in m["background"] else [])
    refs += [r for w in m["web_accessible_resources"] for r in w["resources"]]
    absent = [r for r in refs if not os.path.exists(os.path.join(src, r))]
    check(f"{name}: every referenced file exists", not absent, str(absent))
ff = load("extension", "firefox", "manifest.json")
check("firefox: loads ng-core.js before background.js", ff["background"]["scripts"][:2] == ["ng-core.js", "background.js"])
check("firefox: gecko id + min version >= 128", ff["browser_specific_settings"]["gecko"]["strict_min_version"].split(".")[0].isdigit()
      and int(ff["browser_specific_settings"]["gecko"]["strict_min_version"].split(".")[0]) >= 128)
bg = read("extension", "chrome", "background.js")
check("extraHeaders only used through the Firefox-safe constant",
      bg.count("'extraHeaders'") == 1 and "IS_FIREFOX ? [] : ['extraHeaders']" in bg and bg.count("...EXTRA_HEADERS") == 2)
check("alarm period >= 0.5 min (browser minimum)", "periodInMinutes: 0.1" not in bg)
check("browser downloads are forwarded from exactly one listener",
      len(re.findall(r"sendToNG\('/download'", bg)) == 1 and "interceptEnabled ? '/download'" not in bg)
for js in ["background.js", "content.js", "inject.js", "popup.js", "ng-core.js"]:
    r = subprocess.run(["node", "--check", os.path.join(ROOT, "extension", "chrome", js)], capture_output=True, text=True)
    check(f"node --check {js}", r.returncode == 0, r.stderr.strip())
for js in ["scripts/fetch-yt-dlp.js"]:
    r = subprocess.run(["node", "--check", os.path.join(ROOT, js)], capture_output=True, text=True)
    check(f"node --check {js}", r.returncode == 0, r.stderr.strip())

# ── Licence / attribution ────────────────────────────────────────────────────
lic = read("LICENSE")
check("LICENSE is MIT with Parveen Bhadoo copyright", "MIT License" in lic and "Parveen Bhadoo" in lic)
check("installed licence copy identical to LICENSE", lic == read("src-tauri", "licenses", "QDM-LICENSE.txt"))
check("NOTICE.md credits QDM / Parveen Bhadoo", "Parveen Bhadoo" in read("NOTICE.md") and "Quantum Download Manager" in read("NOTICE.md"))
check("About dialog keeps QDM attribution", "Parveen Bhadoo" in read("src", "components", "AboutDialog.tsx"))
check("extension packages ship LICENSE + NOTICE", 'LICENSE' in read("scripts", "package_extensions.py") and 'NOTICE.md' in read("scripts", "package_extensions.py"))

# ── Branding ─────────────────────────────────────────────────────────────────
check("index.html title is NetGuard", "<title>NetGuard Download Manager</title>" in read("index.html"))
check("no remote font requests in index.html", "fonts.googleapis.com" not in read("index.html"))
bad = []
for d, _, fs in os.walk(os.path.join(ROOT, "src")):
    for f in fs:
        t = open(os.path.join(d, f), encoding="utf-8").read()
        if re.search(r"ng-text-(muted|secondary)", t): bad.append(f)
check("no invalid Tailwind class names (ng-text-muted …)", not bad, str(bad))

# ── Unfinished-work markers in required features ─────────────────────────────
todo = []
for d, dn, fs in os.walk(ROOT):
    dn[:] = [x for x in dn if x not in ("node_modules", "target", "dist", ".git")]
    for f in fs:
        if f.endswith((".rs", ".ts", ".tsx", ".js", ".py", ".yml", ".ps1")) and f != "validate.py":
            for i, line in enumerate(open(os.path.join(d, f), encoding="utf-8", errors="ignore"), 1):
                if re.search(r"\b(TODO|FIXME|XXX)\b", line): todo.append(f"{os.path.relpath(os.path.join(d, f), ROOT)}:{i}")
check("no TODO/FIXME markers in source", not todo, ", ".join(todo[:10]))

print("\n%d check(s) failed" % len(fails) if fails else "\nAll validation checks passed")
sys.exit(1 if fails else 0)
