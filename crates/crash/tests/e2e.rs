//! A real freeze, panic and crash, end to end on each system: examples/crashy.rs does it, its
//! monitor writes the minidump, reads it with the example's own debug info, and the report names
//! the function where it happened.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// The profile's folder, target/[<triple>/]<profile>, found from this test program. Cargo keeps
/// the test in `<profile>/deps/` (its older layout) or in `<profile>/build/<crate>/<hash>/out/`
/// (its newer one): the folder above the nearest `deps` or `build`.
fn profile_dir() -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    exe.ancestors()
        .find(|a| a.file_name().is_some_and(|n| n == "deps" || n == "build"))
        .and_then(Path::parent)
        .unwrap_or_else(|| exe.parent().unwrap())
        .to_owned()
}

/// Where cargo puts the profile's examples, whichever layout the test is in: examples/crashy (with
/// the system's program extension, `.exe` on Windows) in the profile's folder.
fn crashy_beside_the_test() -> PathBuf {
    profile_dir()
        .join("examples")
        .join(format!("crashy{}", std::env::consts::EXE_SUFFIX))
}

/// Builds examples/crashy (with this crate's default features, as the test needs its native
/// symbols) in the profile the test itself was built in, and returns the path cargo reports for
/// the program. Whatever the target directory, the current directory, the profile or the
/// extension: cargo names the file itself.
fn build_crashy() -> PathBuf {
    let profile_dir = profile_dir()
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let mut cmd = Command::new(std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into()));
    cmd.arg("build")
        .arg("--manifest-path")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml"))
        .args(["--example", "crashy", "--message-format=json"]);
    match profile_dir.as_str() {
        // `dev` is cargo's name for the directory `debug`.
        "debug" | "" => {}
        "release" => {
            cmd.arg("--release");
        }
        other => {
            cmd.args(["--profile", other]);
        }
    }
    let out = cmd
        .stdin(Stdio::null())
        .stderr(Stdio::inherit())
        .output()
        .expect("cargo starts to build examples/crashy");
    assert!(
        out.status.success(),
        "cargo build --example crashy failed: {}",
        out.status
    );
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .filter(|m| m["reason"] == "compiler-artifact" && m["target"]["name"] == "crashy")
        .find_map(|m| m["executable"].as_str().map(PathBuf::from))
        .unwrap_or_else(crashy_beside_the_test)
}

/// The built example, once for all the tests (they run in parallel): where it already is beside
/// the test program when `cargo test` built it, built here when it isn't.
fn crashy() -> &'static Path {
    static CRASHY: OnceLock<PathBuf> = OnceLock::new();
    CRASHY.get_or_init(|| {
        let beside = crashy_beside_the_test();
        if beside.is_file() {
            beside
        } else {
            build_crashy()
        }
    })
}

/// Run crashy in `mode` and wait (up to 90 s: reading the dump's symbols takes a while in a
/// debug build) for its report.
fn report(mode: &str) -> String {
    let data = tempfile::tempdir().unwrap();
    /// The program, ended and reaped however the test leaves (a failed assert too).
    struct Running(std::process::Child);
    impl Drop for Running {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
    let _child = Running(
        Command::new(crashy())
            .arg(mode)
            .arg(data.path())
            .spawn()
            .unwrap_or_else(|e| panic!("examples/crashy ({}) starts: {e}", crashy().display())),
    );
    let crashes = data.path().join("crashes");
    let deadline = Instant::now() + Duration::from_secs(90);
    loop {
        let txt = std::fs::read_dir(&crashes).ok().and_then(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .find(|p| p.extension().is_some_and(|x| x == "txt"))
        });
        if let Some(t) = txt {
            // Written in one go after the dump was read; give the write a moment.
            std::thread::sleep(Duration::from_millis(300));
            return std::fs::read_to_string(&t).unwrap();
        }
        if Instant::now() > deadline {
            panic!("no report for {mode} in {}", crashes.display());
        }
        std::thread::sleep(Duration::from_millis(200));
    }
}

#[test]
fn a_freeze_reports_the_frozen_function() {
    let r = report("freeze");
    assert!(r.contains("The window stopped responding"), "{r}");
    assert!(r.contains("crashy_frozen_here"), "{r}");
    assert!(
        r.contains("Signature: freeze in crashy::crashy_frozen_here"),
        "{r}"
    );
}

#[test]
fn a_panic_reports_its_message_and_function() {
    let r = report("panic");
    assert!(r.contains("crashy: a test panic"), "{r}");
    assert!(
        r.contains("Signature: panic in crashy::crashy_panics_here"),
        "{r}"
    );
}

#[test]
fn a_native_crash_reports_where_it_crashed() {
    let r = report("crash");
    assert!(r.contains("Description: NetGuard crashed"), "{r}");
    assert!(
        r.contains("Signature: crash in crashy::crashy_crashes_here"),
        "{r}"
    );
}
