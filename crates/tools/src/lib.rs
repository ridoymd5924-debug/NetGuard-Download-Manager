//! Verified, pinned installs of helper tools (D-011). yt-dlp is never updated by itself
//! (`yt-dlp -U`): we fetch a release from its GitHub page, verify its `SHA2-256SUMS` against
//! yt-dlp's OpenPGP signing key (pinned in `keys/yt-dlp.asc`), verify the program against that
//! list, install it next to earlier versions (`tools/yt-dlp/<version>/`), switch to it
//! atomically, never downgrade, and keep the previous version for rollback.

pub mod chosen;
pub mod ffmpeg;
pub mod gallery;
mod macos;
mod openpgp;
pub mod pages;
pub mod playlist;
pub mod proc;
pub mod relay;
pub mod resolve;
pub mod servers;
pub mod update;
pub mod video;

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// yt-dlp's release signing key, from its repository (`public.key`).
const YTDLP_KEY: &str = include_str!("../keys/yt-dlp.asc");
/// Where releases come from.
const RELEASES: &str = "https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("network: {0}")]
    Http(#[from] reqwest::Error),
    /// A server answered a small request (a release's data, its checksums) with an error status.
    #[error("the server answered HTTP {0}")]
    Status(u16),
    #[error("disk: {0}")]
    Io(#[from] std::io::Error),
    #[error("the release's checksum list is not signed by its publisher's key")]
    BadSignature,
    #[error("the downloaded program doesn't match its signed checksum")]
    BadChecksum,
    #[error("the release has no {0}")]
    Missing(String),
    #[error("unexpected release data: {0}")]
    BadRelease(String),
    /// A program chosen as yt-dlp or ffmpeg (`chosen`) didn't answer as one.
    #[error("this program isn't {0}")]
    NotTheProgram(&'static str),
    /// A program chosen as a helper is a release NetGuard can't drive (#236: gallery-dl before 1.20).
    #[error("{name} {version} is too old: it needs {oldest} or newer")]
    TooOld {
        name: &'static str,
        version: String,
        oldest: &'static str,
    },
    /// NetGuard's engine could not download it (its own words).
    #[error("{0}")]
    Download(String),
    /// The chosen network adapter is down or can't reach the server (#35).
    #[error(transparent)]
    Adapter(#[from] mdm_engine::NetError),
}

/// An installed tool.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Installed {
    pub version: String,
    pub exe: PathBuf,
}

/// `<data dir>/tools`.
pub fn tools_dir() -> Option<PathBuf> {
    mdm_ipc::data_dir().map(|d| d.join("tools"))
}

/// yt-dlp's file name for this platform in its releases. On macOS, its folder build: why, in
/// `macos`.
pub fn ytdlp_asset() -> &'static str {
    if cfg!(windows) {
        "yt-dlp.exe"
    } else if cfg!(target_os = "macos") {
        "yt-dlp_macos.zip"
    } else {
        "yt-dlp_linux"
    }
}

/// Whether `sums` carries a valid signature `sig` (binary OpenPGP) by yt-dlp's key or one of its
/// subkeys.
pub fn signed_by_ytdlp(sums: &[u8], sig: &[u8]) -> bool {
    signed_by(YTDLP_KEY, sums, sig)
}

/// Whether `sums` (a release's SHA256SUMS.txt) carries a valid signature `sig` by NetGuard's
/// release key. NetGuard has no release key yet (updates are switched off in this release), so
/// nothing verifies: a future NetGuard updater pins its public key here.
pub fn signed_by_mdm(sums: &[u8], sig: &[u8]) -> bool {
    // Update now's end-to-end tests (feature `test-update`, never in a release): a fake
    // release on a lab server, signed with a test key of their own.
    #[cfg(feature = "test-update")]
    if let Some(key) =
        std::env::var_os("MDM_TEST_UPDATE_KEY").and_then(|p| std::fs::read_to_string(p).ok())
    {
        return signed_by(&key, sums, sig);
    }
    let _ = (sums, sig);
    false
}

/// Whether `data` carries a valid detached signature `sig` (binary OpenPGP) by the armored
/// public `key` or one of its subkeys.
pub fn signed_by(key: &str, data: &[u8], sig: &[u8]) -> bool {
    openpgp::verify(key.as_bytes(), data, sig)
}

/// How many times a release's small files (its data, its checksums) are asked for before the
/// error is shown.
const ATTEMPTS: u32 = 5;
/// The longest a server's own "try again in" is waited for; asking for more shows the error.
const LONGEST_WAIT: Duration = Duration::from_secs(60);
/// How long a connection to a release's server may take, and a whole small request.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

/// The client for a release's small files: `builder` (its route, DNS and proxy) as NetGuard, with
/// time limits, so a connection that goes quiet fails (and is tried again) instead of hanging.
pub(crate) fn release_client(builder: reqwest::ClientBuilder) -> Result<reqwest::Client, Error> {
    Ok(builder
        .user_agent(USER_AGENT)
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(REQUEST_TIMEOUT)
        .build()?)
}

/// One failed try at a small file: why, whether another try may pass, and how long the server
/// asked to wait.
struct Failed {
    error: Error,
    retry: bool,
    wait: Option<Duration>,
}

impl From<reqwest::Error> for Failed {
    fn from(e: reqwest::Error) -> Self {
        // A connection that failed or was cut, a timeout, a body that stopped: another try may
        // pass. A request that can't be built, or a redirect that never ends, will not.
        Failed {
            retry: !e.is_builder() && !e.is_redirect(),
            error: Error::Http(e),
            wait: None,
        }
    }
}

/// Whether a server's answer is one to ask again after: it was busy or failing (408, 425, 429,
/// 500, 502, 503, 504), or GitHub said the rate limit ran out (403 with no requests left, or a
/// Retry-After). A 404, 401 or 410 is final, and so is any other 403.
fn status_passes(status: reqwest::StatusCode, headers: &reqwest::header::HeaderMap) -> bool {
    match status.as_u16() {
        408 | 425 | 429 | 500 | 502 | 503 | 504 => true,
        403 => {
            let left = headers.get("x-ratelimit-remaining");
            left.is_some_and(|v| v == "0") || headers.contains_key(reqwest::header::RETRY_AFTER)
        }
        _ => false,
    }
}

/// The seconds a server's Retry-After asks for (a date isn't understood: the usual pause applies).
fn asked_wait(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    let seconds = headers.get(reqwest::header::RETRY_AFTER)?.to_str().ok()?;
    let seconds = seconds.trim().parse::<u64>().ok();
    seconds.map(Duration::from_secs)
}

/// One try at `url`'s body.
async fn get_once(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, Failed> {
    let response = client.get(url).send().await?;
    let status = response.status();
    if !status.is_success() {
        return Err(Failed {
            retry: status_passes(status, response.headers()),
            wait: asked_wait(response.headers()),
            error: Error::Status(status.as_u16()),
        });
    }
    Ok(response.bytes().await?.to_vec())
}

/// `url`'s body, asked for again when the failure may pass (a connection that failed or was cut, a
/// timeout, a busy or failing server, a rate limit that resets soon): after 2, 4, 8 and 16
/// seconds, or what the server asked for, up to `ATTEMPTS` tries. An answer that won't change (a
/// 404) is shown at once.
pub(crate) async fn get_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, Error> {
    get_bytes_paced(client, url, Duration::from_secs(1)).await
}

/// [`get_bytes`] with `unit` as the first pause's half (the tests use a short one).
async fn get_bytes_paced(
    client: &reqwest::Client,
    url: &str,
    unit: Duration,
) -> Result<Vec<u8>, Error> {
    let mut attempt = 1;
    loop {
        let failed = match get_once(client, url).await {
            Ok(body) => return Ok(body),
            Err(failed) => failed,
        };
        let wait = failed.wait;
        let pause = wait.unwrap_or(unit * (1 << attempt));
        if !failed.retry || attempt >= ATTEMPTS || pause > LONGEST_WAIT {
            return Err(failed.error);
        }
        tokio::time::sleep(pause).await;
        attempt += 1;
    }
}

/// A release's checksum list (`hash  name` lines), fetched with its detached signature and
/// accepted only when `signed` (the publisher's key) says so.
pub(crate) async fn signed_list(
    client: &reqwest::Client,
    sums_url: &str,
    sig_url: &str,
    signed: fn(&[u8], &[u8]) -> bool,
) -> Result<String, Error> {
    let sums = get_bytes(client, sums_url).await?;
    let sig = get_bytes(client, sig_url).await?;
    if !signed(&sums, &sig) {
        return Err(Error::BadSignature);
    }
    Ok(String::from_utf8_lossy(&sums).into_owned())
}

/// NetGuard's own name, sent when it fetches its helpers and its updates.
pub const USER_AGENT: &str = concat!("MisterDownloadManager/", env!("CARGO_PKG_VERSION"));

/// How NetGuard downloads its helpers and its updates: through its own engine (several connections,
/// resumable), as NetGuard itself, through `proxy` (Options → Proxy / Socks).
pub fn net(proxy: mdm_engine::Proxy) -> mdm_engine::Options {
    mdm_engine::Options {
        user_agent: USER_AGENT.to_owned(),
        proxy,
        ..Default::default()
    }
}

/// Download `url` into `path` with NetGuard's own engine (`net`: its connections, the user's proxy),
/// counting into `progress`, and accept it only when its SHA-256 is `expected` (the engine checks
/// it, and so do we, on the finished file). An earlier attempt cut off is resumed from where it
/// stopped. A file that doesn't match is removed.
pub(crate) async fn fetch_verified(
    url: &str,
    path: &Path,
    expected: [u8; 32],
    net: &mdm_engine::Options,
    progress: Option<&update::Progress>,
) -> Result<(), Error> {
    // The engine retries a connection that fails or is cut. A file that arrives whole but is not
    // the one signed for (a flaky connection or proxy altered it) is fetched again, up to three
    // times in all; one that does not match is never kept, and neither is a half file.
    let mut attempt = 1;
    loop {
        match fetch_verified_once(url, path, expected, net, progress).await {
            Err(Error::BadChecksum) if attempt < 3 => {
                attempt += 1;
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            done => return done,
        }
    }
}

/// One try of [`fetch_verified`].
async fn fetch_verified_once(
    url: &str,
    path: &Path,
    expected: [u8; 32],
    net: &mdm_engine::Options,
    progress: Option<&update::Progress>,
) -> Result<(), Error> {
    use mdm_engine::verify::{Algo, Hash};
    let url = url::Url::parse(url).map_err(|e| Error::BadRelease(e.to_string()))?;
    let opts = mdm_engine::Options {
        checksum: Some(Hash {
            algo: Algo::Sha256,
            value: expected.to_vec(),
        }),
        ..net.clone()
    };
    let got = mdm_engine::fetch(url, path, opts, |done, total| {
        if let Some(p) = progress {
            use std::sync::atomic::Ordering::Relaxed;
            p.got.store(done, Relaxed);
            p.total.store(total.unwrap_or(0), Relaxed);
        }
    })
    .await;
    let state = mdm_engine::state::state_path(path);
    let forget = || {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(mdm_engine::naming::part_path(path));
        let _ = std::fs::remove_file(&state);
    };
    match got {
        Ok(_) if sha256_of(path)? == expected => Ok(()),
        Ok(_) | Err(mdm_engine::Error::ChecksumMismatch(_)) => {
            forget();
            Err(Error::BadChecksum)
        }
        Err(e) => Err(Error::Download(e.to_string())),
    }
}

/// The SHA-256 of the file at `path`.
fn sha256_of(path: &Path) -> Result<[u8; 32], Error> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut buf = vec![0u8; 1 << 16];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            return Ok(hash.finalize().into());
        }
        hash.update(&buf[..n]);
    }
}

/// The SHA-256 a `hash  name` list gives for `name`.
pub fn sum_for(sums: &str, name: &str) -> Option<[u8; 32]> {
    sums.lines().find_map(|line| {
        let (hash, file) = line.trim().split_once(char::is_whitespace)?;
        if file.trim().trim_start_matches('*') != name {
            return None;
        }
        hex::decode(hash).ok()?.try_into().ok()
    })
}

/// The yt-dlp to use: the person's own (`chosen`), else NetGuard's install in `dir`
/// (`dir/yt-dlp/current.json`), if any and still there.
pub fn installed(dir: &Path) -> Option<Installed> {
    chosen::chosen(dir, chosen::Helper::YtDlp).or_else(|| own_ytdlp(dir))
}

fn own_ytdlp(dir: &Path) -> Option<Installed> {
    let text = std::fs::read(dir.join("yt-dlp").join("current.json")).ok()?;
    let i: Installed = serde_json::from_slice(&text).ok()?;
    // macOS: the one-file build earlier versions installed can't run from a downloaded app (`macos`).
    if cfg!(target_os = "macos") && macos::one_file_build(&i.exe) {
        return None;
    }
    i.exe.is_file().then_some(i)
}

/// Versions are release dates (`2026.10.26`, maybe `.1`): numeric parts compare in order.
pub(crate) fn newer(a: &str, b: &str) -> bool {
    let parts = |v: &str| -> Vec<u64> { v.split('.').filter_map(|p| p.parse().ok()).collect() };
    parts(a) > parts(b)
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

/// Install the latest yt-dlp release into `dir` unless the installed one is as new, the program
/// downloaded with NetGuard's engine (`net`), counted into `progress`. Returns what is installed
/// afterwards.
pub async fn install_latest(
    dir: &Path,
    net: &mdm_engine::Options,
    progress: Option<&update::Progress>,
) -> Result<Installed, Error> {
    // The person's own copy: theirs to update (#51).
    if let Some(mine) = chosen::chosen(dir, chosen::Helper::YtDlp) {
        return Ok(mine);
    }
    let builder = mdm_engine::net::client_builder(&net.dns, &net.route, RELEASES)?;
    let client = release_client(builder)?;
    let body = get_bytes(&client, RELEASES).await?;
    let release: Release =
        serde_json::from_slice(&body).map_err(|e| Error::BadRelease(e.to_string()))?;
    if let Some(current) = own_ytdlp(dir)
        && !newer(&release.tag_name, &current.version)
    {
        return Ok(current); // never the same again, never older
    }
    let url = |name: &str| {
        release
            .assets
            .iter()
            .find(|a| a.name == name)
            .map(|a| a.browser_download_url.clone())
            .ok_or_else(|| Error::Missing(name.to_owned()))
    };
    let sums = signed_list(
        &client,
        &url("SHA2-256SUMS")?,
        &url("SHA2-256SUMS.sig")?,
        signed_by_ytdlp,
    )
    .await?;
    let asset = ytdlp_asset();
    let expected =
        sum_for(&sums, asset).ok_or_else(|| Error::Missing(format!("checksum for {asset}")))?;
    let exe_url = url(asset)?;
    let root = dir.join("yt-dlp");
    std::fs::create_dir_all(&root)?;
    // Named by its checksum: one release's cut-off download resumes, never another's.
    let download = root.join(format!("yt-dlp-{}.download", hex::encode(&expected[..8])));
    fetch_verified(&exe_url, &download, expected, net, progress).await?;
    let program = std::fs::read(&download)?;
    let _ = std::fs::remove_file(&download);
    if Sha256::digest(&program).as_slice() != expected {
        return Err(Error::BadChecksum);
    }
    #[cfg(target_os = "macos")]
    return macos::put_folder(dir, &release.tag_name, &program);
    #[cfg(not(target_os = "macos"))]
    put(dir, "yt-dlp", &release.tag_name, asset, &program, &exe_url)
}

/// Install verified `program` as `version` of `tool` (`dir/<tool>/<version>/<asset>`) and make it
/// current (atomically), keeping the previous version for rollback and removing older ones.
pub(crate) fn put(
    dir: &Path,
    tool: &str,
    version: &str,
    asset: &str,
    program: &[u8],
    from: &str,
) -> Result<Installed, Error> {
    if version.is_empty() || version.contains(['/', '\\', ':']) || version.starts_with('.') {
        return Err(Error::BadRelease(format!("version {version:?}")));
    }
    let root = dir.join(tool);
    let folder = root.join(version);
    std::fs::create_dir_all(&folder)?;
    let exe = folder.join(asset);
    craft_atomic::atomic_write(&exe, program)?;
    mark_downloaded(&exe, from);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&exe, std::fs::Permissions::from_mode(0o755))?;
    }
    make_current(
        &root,
        Installed {
            version: version.to_owned(),
            exe,
        },
    )
}

/// Make `now` (installed in `root/<version>/`) the current version of a tool: `current.json`
/// switched atomically, the previous version kept for rollback, older ones removed.
pub(crate) fn make_current(root: &Path, now: Installed) -> Result<Installed, Error> {
    let previous = std::fs::read(root.join("current.json"))
        .ok()
        .and_then(|t| serde_json::from_slice::<Installed>(&t).ok());
    let json = serde_json::to_vec_pretty(&now).map_err(std::io::Error::other)?;
    craft_atomic::atomic_write(&root.join("current.json"), &json)?;
    // Keep the new and the previous version; older ones go.
    let keep: Vec<String> = [Some(now.version.clone()), previous.map(|p| p.version)]
        .into_iter()
        .flatten()
        .collect();
    if let Ok(entries) = std::fs::read_dir(root) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if e.path().is_dir() && !keep.contains(&name) {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    Ok(now)
}

/// Mark-of-the-Web: the program came from the internet (Windows checks it like a browser
/// download).
pub(crate) fn mark_downloaded(path: &Path, from: &str) {
    #[cfg(windows)]
    {
        let mut stream = path.as_os_str().to_owned();
        stream.push(":Zone.Identifier");
        let _ = std::fs::write(
            stream,
            format!("[ZoneTransfer]\r\nZoneId=3\r\nHostUrl={from}\r\n"),
        );
    }
    #[cfg(not(windows))]
    let _ = (path, from);
}

#[cfg(test)]
mod tests {
    use super::*;

    const SUMS: &[u8] = include_bytes!("../tests/fixtures/SHA2-256SUMS");
    const SIG: &[u8] = include_bytes!("../tests/fixtures/SHA2-256SUMS.sig");

    type Seen = std::sync::Arc<std::sync::atomic::AtomicUsize>;

    /// A local server: each request gets the next of `script` (the last repeats), a whole answer,
    /// or None to hang up without one. Returns its address and how many requests it has seen.
    async fn serve(script: Vec<Option<String>>) -> (String, Seen) {
        use std::sync::atomic::Ordering::SeqCst;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let seen = Seen::default();
        let count = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let k = count.fetch_add(1, SeqCst);
                let reply = script[k.min(script.len() - 1)].clone();
                let mut head = [0u8; 2048];
                let _ = socket.read(&mut head).await;
                if let Some(text) = reply {
                    let _ = socket.write_all(text.as_bytes()).await;
                }
                let _ = socket.shutdown().await;
            }
        });
        (base, seen)
    }

    /// An answer with `status_and_headers` (after "HTTP/1.1 ") and no body.
    fn bare(status_and_headers: &str) -> Option<String> {
        let tail = "Content-Length: 0\r\nConnection: close\r\n\r\n";
        Some(format!("HTTP/1.1 {status_and_headers}\r\n{tail}"))
    }

    /// A good answer: the two bytes "ok".
    fn fine() -> Option<String> {
        Some("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".into())
    }

    /// Asks the server `script` describes for `/file`, with 1 ms pauses: the outcome and how many
    /// requests it took.
    async fn ask(script: Vec<Option<String>>) -> (Result<Vec<u8>, Error>, usize) {
        let (base, seen) = serve(script).await;
        let client = reqwest::Client::builder().no_proxy().build().unwrap();
        let url = format!("{base}/file");
        let got = get_bytes_paced(&client, &url, Duration::from_millis(1)).await;
        (got, seen.load(std::sync::atomic::Ordering::SeqCst))
    }

    #[tokio::test]
    async fn a_busy_server_is_asked_again_until_it_answers() {
        let busy = bare("503 Service Unavailable");
        let (got, requests) = ask(vec![busy.clone(), busy, fine()]).await;
        assert_eq!(got.unwrap(), b"ok");
        assert_eq!(requests, 3);
    }

    #[tokio::test]
    async fn a_server_that_never_recovers_is_given_up_on() {
        let (got, requests) = ask(vec![bare("503 Service Unavailable")]).await;
        assert!(matches!(got, Err(Error::Status(503))), "{got:?}");
        assert_eq!(requests, ATTEMPTS as usize);
    }

    #[tokio::test]
    async fn a_permanent_error_is_not_retried() {
        let (got, requests) = ask(vec![bare("404 Not Found"), fine()]).await;
        assert!(matches!(got, Err(Error::Status(404))), "{got:?}");
        assert_eq!(requests, 1);
        // A 403 with no rate limit behind it is a refusal, not a wait.
        let (got, requests) = ask(vec![bare("403 Forbidden"), fine()]).await;
        assert!(matches!(got, Err(Error::Status(403))), "{got:?}");
        assert_eq!(requests, 1);
    }

    #[tokio::test]
    async fn a_spent_github_rate_limit_is_waited_out() {
        let limit = bare("403 Forbidden\r\nx-ratelimit-remaining: 0");
        let (got, requests) = ask(vec![limit, fine()]).await;
        assert_eq!(got.unwrap(), b"ok");
        assert_eq!(requests, 2);
    }

    #[tokio::test]
    async fn a_wait_the_server_asks_for_is_kept_unless_it_is_too_long() {
        let soon = bare("429 Too Many Requests\r\nRetry-After: 0");
        let (got, requests) = ask(vec![soon, fine()]).await;
        assert_eq!(got.unwrap(), b"ok");
        assert_eq!(requests, 2);
        let later = bare("429 Too Many Requests\r\nRetry-After: 3600");
        let (got, requests) = ask(vec![later, fine()]).await;
        assert!(matches!(got, Err(Error::Status(429))), "{got:?}");
        assert_eq!(requests, 1);
    }

    #[tokio::test]
    async fn a_connection_that_is_cut_is_asked_again() {
        // Hung up without an answer, then an answer that stops short of its length.
        let short = "HTTP/1.1 200 OK\r\nContent-Length: 10\r\nConnection: close\r\n\r\nab";
        let (got, requests) = ask(vec![None, Some(short.into()), fine()]).await;
        assert_eq!(got.unwrap(), b"ok");
        assert!(requests >= 3, "{requests}");
    }

    #[tokio::test]
    async fn a_redirect_is_followed() {
        let (got, requests) = ask(vec![bare("302 Found\r\nLocation: /final"), fine()]).await;
        assert_eq!(got.unwrap(), b"ok");
        assert_eq!(requests, 2);
    }

    #[test]
    fn a_real_release_checksum_list_is_signed_by_the_pinned_key() {
        assert!(signed_by_ytdlp(SUMS, SIG));
    }

    #[test]
    fn no_release_verifies_until_netguard_pins_its_own_key() {
        assert!(!signed_by_mdm(SUMS, SIG));
    }

    #[test]
    fn a_changed_list_fails_the_signature() {
        let mut forged = SUMS.to_vec();
        forged[0] = if forged[0] == b'0' { b'1' } else { b'0' };
        assert!(!signed_by_ytdlp(&forged, SIG));
        assert!(!signed_by_ytdlp(SUMS, b"not a signature"));
    }

    #[test]
    fn checksums_by_name() {
        let sums = String::from_utf8_lossy(SUMS);
        let exe = sum_for(&sums, "yt-dlp.exe").unwrap();
        assert_eq!(
            hex::encode(exe),
            "f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d"
        );
        assert!(sum_for(&sums, "yt-dlp.ex").is_none());
    }

    #[test]
    fn versions_compare_as_dates() {
        assert!(newer("2026.10.26", "2026.9.30"));
        assert!(newer("2026.10.26.1", "2026.10.26"));
        assert!(!newer("2026.10.26", "2026.10.26"));
    }

    #[test]
    fn installs_switch_and_keep_one_previous_version() {
        let dir = tempfile::tempdir().unwrap();
        let name = "yt-dlp-test-program";
        put(
            dir.path(),
            "yt-dlp",
            "2026.01.01",
            name,
            b"one",
            "https://x/",
        )
        .unwrap();
        put(
            dir.path(),
            "yt-dlp",
            "2026.02.01",
            name,
            b"two",
            "https://x/",
        )
        .unwrap();
        let now = put(
            dir.path(),
            "yt-dlp",
            "2026.03.01",
            name,
            b"three",
            "https://x/",
        )
        .unwrap();
        // macOS installs the folder build (`macos`), with a folder beside the program.
        #[cfg(target_os = "macos")]
        std::fs::create_dir_all(now.exe.with_file_name("_internal")).unwrap();
        assert_eq!(installed(dir.path()).unwrap(), now);
        assert_eq!(std::fs::read(&now.exe).unwrap(), b"three");
        let root = dir.path().join("yt-dlp");
        assert!(
            root.join("2026.02.01").is_dir(),
            "the previous version stays"
        );
        assert!(!root.join("2026.01.01").exists(), "older ones go");
        assert!(put(dir.path(), "yt-dlp", "../evil", name, b"x", "https://x/").is_err());
    }
}
