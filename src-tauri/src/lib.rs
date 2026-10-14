mod ascii;

use serde::Serialize;
use std::sync::Mutex;
use tauri::Manager;

/// An error returned to the UI. `code` is a sidecar exit code
/// (app/util/exitCodes.ts); `message` is shown to the user.
#[derive(Serialize)]
pub struct SidecarError {
    code: i32,
    message: String,
}

/// An error with no sidecar exit code, for a failure in the app itself.
fn unavailable(message: String) -> SidecarError {
    SidecarError { code: -1, message }
}

/// EXIT.ACTION_REFUSED in app/util/exitCodes.ts.
const ACTION_REFUSED: i32 = 7;

/// Runs the Bun sidecar and returns the spec JSON from its stdout.
#[tauri::command]
async fn get_spec(app: tauri::AppHandle) -> Result<String, SidecarError> {
    run_sidecar(&app, Vec::new()).await
}

/// Runs `lcu-sidecar player <args>`. The sidecar owns the command list and
/// checks ownership and limits before any write. It reads options only before
/// the command, so these arguments cannot change how it runs; this check only
/// keeps them to plain words and numbers.
#[tauri::command]
async fn player(app: tauri::AppHandle, args: Vec<String>) -> Result<String, SidecarError> {
    let plain = args
        .iter()
        .all(|a| a.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    if args.is_empty() || !plain {
        return Err(SidecarError {
            code: ACTION_REFUSED,
            message: "player command not allowed".into(),
        });
    }
    let mut full = vec!["player".to_string()];
    full.extend(args);
    run_sidecar(&app, full).await
}

/// Copies client pictures into `folder` of the app's cache folder, through the sidecar command
/// `command` (see app/util/player.ts). The folder is chosen here, never by the page.
async fn cache_art(app: tauri::AppHandle, command: &str, folder: &str, ids: &[u32]) -> Result<String, SidecarError> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| unavailable(format!("no cache folder: {e}")))?
        .join(folder);
    let mut args = vec!["player".to_string(), command.into(), dir.to_string_lossy().into_owned()];
    args.extend(ids.iter().map(u32::to_string));
    run_sidecar(&app, args).await
}

/// The profile icons, for the Icon tab.
#[tauri::command]
async fn icon_cache(app: tauri::AppHandle) -> Result<String, SidecarError> {
    cache_art(app, "icon-cache", "profile-icons", &[]).await
}

/// The loading pictures of the skins with these ids, for the Background tab. Only the ones on
/// screen are asked for.
#[tauri::command]
async fn skin_cache(app: tauri::AppHandle, ids: Vec<u32>) -> Result<String, SidecarError> {
    cache_art(app, "skin-cache", "skin-art", &ids).await
}

/// Where the sidecar executable is. On macOS and Linux it is a separate file next to the app.
#[cfg(not(windows))]
fn sidecar_path(_app: &tauri::AppHandle) -> Result<std::path::PathBuf, SidecarError> {
    Ok(std::env::current_exe()
        .map_err(|e| unavailable(format!("no app location: {e}")))?
        .parent()
        .ok_or_else(|| unavailable("no app folder".into()))?
        .join("lcu-sidecar"))
}

/// On Windows the sidecar is built into this executable. It is written to the app's
/// cache folder on first use, always under the same name: Windows Firewall remembers the
/// user's "Allow" for that path, so the phone page keeps working after an update. A stamp
/// file records which app version wrote it, so an update replaces the old copy.
#[cfg(windows)]
const SIDECAR_EXE: &[u8] = include_bytes!("../binaries/lcu-sidecar-x86_64-pc-windows-msvc.exe");

#[cfg(windows)]
fn sidecar_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, SidecarError> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| unavailable(format!("no cache folder: {e}")))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| unavailable(format!("could not create {}: {e}", dir.display())))?;
    // Commands can run at the same time; one at a time checks and writes the file.
    static UNPACK: Mutex<()> = Mutex::new(());
    let _one_at_a_time = UNPACK.lock().unwrap_or_else(|e| e.into_inner());
    let exe = dir.join("lcu-sidecar.exe");
    let stamp = dir.join("lcu-sidecar.version");
    let want = format!("{} {}", env!("CARGO_PKG_VERSION"), SIDECAR_EXE.len());
    let current = std::fs::read_to_string(&stamp).ok() == Some(want.clone())
        && std::fs::metadata(&exe).map(|m| m.len()).ok() == Some(SIDECAR_EXE.len() as u64);
    if !current {
        // Write to a temporary name first, so a half-written file is never run.
        let tmp = dir.join(format!("lcu-sidecar.{}.tmp", std::process::id()));
        std::fs::write(&tmp, SIDECAR_EXE)
            .and_then(|_| std::fs::rename(&tmp, &exe))
            .and_then(|_| std::fs::write(&stamp, &want))
            .map_err(|e| unavailable(format!("could not write the sidecar (is an old copy still running?): {e}")))?;
    }
    Ok(exe)
}

/// A command for the sidecar. On Windows it runs without a console window.
fn sidecar_command(exe: &std::path::Path) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(exe);
    // The compiled sidecar can run out of executable memory and exit with code 133 while its
    // JIT is on (seen on macOS 26). It does light work, so the JIT is turned off.
    cmd.env("BUN_JSC_useJIT", "0");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Runs the sidecar to the end and keeps its output.
async fn sidecar_output(app: &tauri::AppHandle, args: Vec<String>) -> Result<std::process::Output, SidecarError> {
    let exe = sidecar_path(app)?;
    tauri::async_runtime::spawn_blocking(move || {
        sidecar_command(&exe).args(&args).stdin(std::process::Stdio::null()).output()
    })
    .await
    .map_err(|e| unavailable(format!("sidecar task failed: {e}")))?
    .map_err(|e| unavailable(format!("could not run the sidecar: {e}")))
}

/// Logs and errors arrive on stderr; on a non-zero exit the stderr text is
/// returned as the error message.
async fn run_sidecar(app: &tauri::AppHandle, args: Vec<String>) -> Result<String, SidecarError> {
    let out = sidecar_output(app, args).await?;
    if out.status.success() {
        // Reuse the stdout buffer (it can be over 1 MB) instead of copying it.
        Ok(String::from_utf8(out.stdout)
            .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
    } else {
        Err(SidecarError {
            code: out.status.code().unwrap_or(-1),
            message: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        })
    }
}

/// The last lines the phone server wrote, newest last: the reason it stopped, when it does.
type Log = std::sync::Arc<Mutex<std::collections::VecDeque<String>>>;
const LOG_LINES: usize = 20;

/// A phone server that came up, with its port and its recent log lines.
#[derive(Debug)]
struct Running {
    child: std::process::Child,
    port: u16,
    log: Log,
}

/// The phone page's server process, if one is running.
#[derive(Default)]
struct PhoneServer {
    child: Mutex<Option<Running>>,
    /// Held for a whole start, so two starts never overlap and lose track of a server.
    starting: Mutex<()>,
    /// Set by a stop. A start still waiting for its server stops that server instead of keeping it.
    cancelled: std::sync::atomic::AtomicBool,
}

/// Kills a server process and waits for it to exit, so it is not left behind as a zombie.
fn reap(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

/// Stops the phone server, and any start still in progress.
fn stop_phone(server: &PhoneServer) {
    server.cancelled.store(true, std::sync::atomic::Ordering::SeqCst);
    if let Some(mut running) = server.child.lock().unwrap_or_else(|e| e.into_inner()).take() {
        reap(&mut running.child);
    }
}

/// How the phone server is doing, for the Phone tab to show and to restart it.
#[derive(Serialize, Debug, PartialEq)]
struct PhoneHealth {
    /// "off" (not started or stopped from the app), "ok", "stopped" (the process ended) or
    /// "not-answering" (it runs but does not answer; it is stopped so it can be restarted).
    state: &'static str,
    /// Why it stopped: the exit code and its last log lines.
    reason: String,
}

/// Checks the phone server: that its process still runs and that it answers on its port.
fn check_phone(server: &PhoneServer) -> PhoneHealth {
    let mut slot = server.child.lock().unwrap_or_else(|e| e.into_inner());
    let Some(running) = slot.as_mut() else {
        return PhoneHealth { state: "off", reason: String::new() };
    };
    let last_lines = |log: &Log| {
        let lines = log.lock().unwrap_or_else(|e| e.into_inner());
        lines.iter().rev().take(3).rev().cloned().collect::<Vec<_>>().join(" | ")
    };
    if let Ok(Some(status)) = running.child.try_wait() {
        let code = status.code().map_or("no exit code".to_string(), |c| format!("exit code {c}"));
        let lines = last_lines(&running.log);
        *slot = None;
        let reason = if lines.is_empty() { code } else { format!("{code}: {lines}") };
        return PhoneHealth { state: "stopped", reason };
    }
    if ping(running.port) {
        return PhoneHealth { state: "ok", reason: String::new() };
    }
    let lines = last_lines(&running.log);
    reap(&mut running.child);
    *slot = None;
    let reason = if lines.is_empty() { "it stopped answering".to_string() } else { format!("it stopped answering: {lines}") };
    PhoneHealth { state: "not-answering", reason }
}

/// True when the phone server answers `GET /api/ping` on `port` within two seconds.
fn ping(port: u16) -> bool {
    use std::io::{Read, Write};
    let wait = std::time::Duration::from_secs(2);
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = std::net::TcpStream::connect_timeout(&addr, wait) else { return false };
    let _ = stream.set_read_timeout(Some(wait));
    let _ = stream.set_write_timeout(Some(wait));
    if stream.write_all(b"GET /api/ping HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_err() {
        return false;
    }
    let mut head = [0u8; 12];
    stream.read_exact(&mut head).is_ok() && head.starts_with(b"HTTP/1.1 200")
}

/// Starts the phone server from `cmd`, replacing one already running. A stop that comes while it
/// starts wins: the new server is stopped and the start fails.
fn start_phone(server: &PhoneServer, cmd: std::process::Command, port: u16, timeout: std::time::Duration) -> Result<(), SidecarError> {
    let _one_at_a_time = server.starting.lock().unwrap_or_else(|e| e.into_inner());
    stop_phone(server);
    server.cancelled.store(false, std::sync::atomic::Ordering::SeqCst);
    let mut running = spawn_phone(cmd, port, timeout)?;
    let mut slot = server.child.lock().unwrap_or_else(|e| e.into_inner());
    // Checked under the lock stop_phone takes, so a stop either sees this server or cancels it here.
    if server.cancelled.load(std::sync::atomic::Ordering::SeqCst) {
        reap(&mut running.child);
        return Err(unavailable("the phone page was stopped".into()));
    }
    *slot = Some(running);
    Ok(())
}

/// This computer's address on the local network, for the QR code. No packets are sent: a UDP
/// socket only picks the route.
#[tauri::command]
fn phone_lan_ip() -> Result<String, SidecarError> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0")
        .map_err(|e| unavailable(format!("no network socket: {e}")))?;
    socket
        .connect("8.8.8.8:80")
        .map_err(|e| unavailable(format!("no network route: {e}")))?;
    let addr = socket
        .local_addr()
        .map_err(|e| unavailable(format!("no local address: {e}")))?;
    Ok(addr.ip().to_string())
}

/// How long the phone page may take to start: finding the client can take up to 8 s.
const PHONE_START_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// Starts the phone page on `port`. Replaces any server already running. Returns once the
/// page is listening, or with the sidecar's own message when it stops first (no
/// client running, port in use).
#[tauri::command]
async fn phone_start(app: tauri::AppHandle, port: u16, token: String) -> Result<(), SidecarError> {
    if port < 1024 {
        return Err(SidecarError { code: ACTION_REFUSED, message: "port must be 1024 or higher".into() });
    }
    // The token is the QR code's secret: 32 hex characters, from the page.
    if token.len() != 32 || !token.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(SidecarError { code: ACTION_REFUSED, message: "the phone token must be 32 hex characters".into() });
    }
    let exe = sidecar_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = sidecar_command(&exe);
        cmd.args(["serve", &port.to_string(), &token]);
        start_phone(&app.state::<PhoneServer>(), cmd, port, PHONE_START_TIMEOUT)
    })
    .await
    .map_err(|e| unavailable(format!("phone task failed: {e}")))?
}

/// Starts `cmd` (the sidecar's `serve`) and waits until it says it is listening. Returns
/// the sidecar's own message when it stops first, and stops it when it takes too long.
fn spawn_phone(
    mut cmd: std::process::Command,
    port: u16,
    timeout: std::time::Duration,
) -> Result<Running, SidecarError> {
    let mut child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| unavailable(format!("could not start the phone page: {e}")))?;
    // Read stderr until the sidecar exits, so it never blocks on a full pipe. The line
    // `phone page on port N` means the server is listening; the end of stderr means it stopped.
    // Every line also goes to the log, which keeps only the last few, so it never grows.
    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
    let log: Log = Default::default();
    if let Some(stderr) = child.stderr.take() {
        let log = log.clone();
        std::thread::spawn(move || {
            let mut text = String::new();
            let mut ready = false;
            for line in std::io::BufRead::lines(std::io::BufReader::new(stderr)).map_while(Result::ok) {
                if !ready && line.starts_with("phone page on port") {
                    ready = true;
                    let _ = tx.send(None);
                    continue;
                }
                if !ready {
                    text.push_str(&line);
                    text.push('\n');
                }
                let mut lines = log.lock().unwrap_or_else(|e| e.into_inner());
                lines.push_back(line);
                while lines.len() > LOG_LINES {
                    lines.pop_front();
                }
            }
            let _ = tx.send(Some(text));
        });
    }
    match rx.recv_timeout(timeout) {
        Ok(None) => Ok(Running { child, port, log }),
        Ok(Some(text)) => {
            let status = child.wait().ok();
            let text = text.trim();
            Err(SidecarError {
                code: status.and_then(|s| s.code()).unwrap_or(-1),
                message: if text.is_empty() { "the phone page stopped".into() } else { text.to_string() },
            })
        }
        Err(_) => {
            reap(&mut child);
            Err(unavailable(format!("the phone page did not start on port {port}")))
        }
    }
}

/// How the phone page is doing. The Phone tab asks every few seconds and restarts it when it stopped.
#[tauri::command]
async fn phone_status(app: tauri::AppHandle) -> Result<PhoneHealth, SidecarError> {
    tauri::async_runtime::spawn_blocking(move || check_phone(&app.state::<PhoneServer>()))
        .await
        .map_err(|e| unavailable(format!("phone task failed: {e}")))
}

/// Stops the phone page.
#[tauri::command]
fn phone_stop(server: tauri::State<PhoneServer>) {
    stop_phone(&server);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(PhoneServer::default())
        .invoke_handler(tauri::generate_handler![get_spec, player, icon_cache, skin_cache, phone_lan_ip, phone_start, phone_status, phone_stop, ascii::ascii_art])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");
    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            stop_phone(&handle.state::<PhoneServer>());
        }
    });
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Duration;

    /// The sidecar built for this machine (`bun run sidecar`); the tests are skipped without it.
    fn sidecar() -> Option<PathBuf> {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
        std::fs::read_dir(dir).ok()?.filter_map(|e| e.ok().map(|e| e.path())).find(|p| {
            let name = p.file_name().unwrap_or_default().to_string_lossy().into_owned();
            name.starts_with("lcu-sidecar-") && !name.ends_with(".exe")
        })
    }

    /// A lockfile for a client that is not running; `serve` only needs it to parse.
    fn lockfile(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(name);
        std::fs::write(&path, "LeagueClient:1:1:pw:https").unwrap();
        path
    }

    const TEST_TOKEN: &str = "00112233445566778899aabbccddeeff";

    fn serve(exe: &std::path::Path, lock: &std::path::Path, port: u16) -> std::process::Command {
        let mut cmd = sidecar_command(exe);
        cmd.arg("--lockfile").arg(lock).args(["serve", &port.to_string(), TEST_TOKEN]);
        cmd
    }

    #[test]
    fn every_sidecar_command_turns_the_jit_off() {
        let cmd = sidecar_command(std::path::Path::new("lcu-sidecar"));
        let jit = cmd.get_envs().find(|(key, _)| *key == "BUN_JSC_useJIT").and_then(|(_, v)| v);
        assert_eq!(jit, Some(std::ffi::OsStr::new("0")));
    }

    /// Exit code 133 is "Ran out of executable memory". The built sidecar must start past that;
    /// without a client, `player profile` fails with another code.
    #[test]
    fn the_built_sidecar_does_not_run_out_of_executable_memory() {
        let Some(exe) = sidecar() else { return };
        let out = sidecar_command(&exe)
            .arg("--lockfile")
            .arg(lockfile("rift-explorer-no-client.lock"))
            .args(["player", "profile"])
            .output()
            .unwrap();
        assert_ne!(out.status.code(), Some(133), "{}", String::from_utf8_lossy(&out.stderr));
    }

    #[test]
    fn phone_page_starts_then_a_second_one_reports_the_busy_port() {
        let Some(exe) = sidecar() else { return };
        let lock = lockfile("rift-phone-test-lockfile");
        let port = 18787;
        let mut first = spawn_phone(serve(&exe, &lock, port), port, Duration::from_secs(15)).ok().expect("first server starts").child;
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_ok(), "the page answers once ready");
        let err = spawn_phone(serve(&exe, &lock, port), port, Duration::from_secs(15)).expect_err("second server fails");
        assert!(err.message.contains("already in use"), "{}", err.message);
        let _ = first.kill();
        let _ = first.wait();
    }

    /// A stand-in server that says it is listening after `delay` seconds, then runs until stopped.
    fn slow_server(delay: &str) -> std::process::Command {
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", &format!("sleep {delay}; echo 'phone page on port 1' >&2; exec sleep 60")]);
        cmd
    }

    #[test]
    fn a_stop_during_a_start_cancels_it_and_leaves_no_server() {
        let server = std::sync::Arc::new(PhoneServer::default());
        let starting = {
            let server = server.clone();
            std::thread::spawn(move || start_phone(&server, slow_server("1"), 1, Duration::from_secs(15)))
        };
        // The start is waiting for its server to come up; the panel closes now.
        std::thread::sleep(Duration::from_millis(200));
        stop_phone(&server);
        let started = starting.join().unwrap();
        assert_eq!(started.err().map(|e| e.message), Some("the phone page was stopped".to_string()));
        assert!(server.child.lock().unwrap().is_none());
    }

    #[test]
    fn a_stop_after_a_start_stops_the_server() {
        let server = PhoneServer::default();
        start_phone(&server, slow_server("0"), 1, Duration::from_secs(15)).ok().expect("starts");
        assert!(server.child.lock().unwrap().is_some());
        stop_phone(&server);
        assert!(server.child.lock().unwrap().is_none());
    }

    #[test]
    fn a_server_that_exits_is_reported_with_its_last_words() {
        let server = PhoneServer::default();
        let mut cmd = std::process::Command::new("sh");
        cmd.args(["-c", "echo 'phone page on port 1' >&2; sleep 0.2; echo 'lockfile not readable' >&2; exit 7"]);
        start_phone(&server, cmd, 1, Duration::from_secs(5)).ok().expect("starts");
        std::thread::sleep(Duration::from_millis(600));
        assert_eq!(
            check_phone(&server),
            PhoneHealth { state: "stopped", reason: "exit code 7: lockfile not readable".into() }
        );
        // Reported once; after that it is off, so the tab can start it again.
        assert_eq!(check_phone(&server).state, "off");
    }

    #[test]
    fn a_server_that_runs_but_does_not_answer_is_stopped_and_reported() {
        let server = PhoneServer::default();
        // Says it is ready, but nothing listens on the port.
        start_phone(&server, slow_server("0"), 18797, Duration::from_secs(5)).ok().expect("starts");
        let health = check_phone(&server);
        assert_eq!(health.state, "not-answering");
        assert!(server.child.lock().unwrap().is_none(), "the stuck process is stopped");
    }

    #[test]
    fn a_healthy_phone_server_answers_its_ping() {
        let Some(exe) = sidecar() else { return };
        let lock = lockfile("rift-phone-test-lockfile-ping");
        let port = 18798;
        let server = PhoneServer::default();
        start_phone(&server, serve(&exe, &lock, port), port, Duration::from_secs(15)).ok().expect("starts");
        assert_eq!(check_phone(&server), PhoneHealth { state: "ok", reason: String::new() });
        stop_phone(&server);
        assert_eq!(check_phone(&server).state, "off");
    }

    #[test]
    fn a_second_start_replaces_the_first_server() {
        let Some(exe) = sidecar() else { return };
        let lock = lockfile("rift-phone-test-lockfile-twice");
        let port = 18790;
        let server = PhoneServer::default();
        start_phone(&server, serve(&exe, &lock, port), port, Duration::from_secs(15)).ok().expect("first start");
        let first = server.child.lock().unwrap().as_ref().map(|r| r.child.id());
        // The first is stopped before the second binds the same port, so the second does not fail.
        start_phone(&server, serve(&exe, &lock, port), port, Duration::from_secs(15)).ok().expect("second start");
        let second = server.child.lock().unwrap().as_ref().map(|r| r.child.id());
        assert_ne!(first, second);
        stop_phone(&server);
        assert!(server.child.lock().unwrap().is_none());
    }

    #[test]
    fn a_missing_lockfile_is_reported() {
        let Some(exe) = sidecar() else { return };
        let missing = std::env::temp_dir().join("rift-phone-test-no-such-lockfile");
        let err = spawn_phone(serve(&exe, &missing, 18788), 18788, Duration::from_secs(15)).expect_err("fails");
        assert_eq!(err.code, 3);
        assert!(err.message.contains("lockfile not found"), "{}", err.message);
    }
}
