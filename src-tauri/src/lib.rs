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

/// The sidecar's output. Only what the commands need is kept.
struct Done {
    success: bool,
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// Where the sidecar executable is. On macOS and Linux it is a separate file next to the app.
#[cfg(not(windows))]
fn sidecar_path(_app: &tauri::AppHandle) -> Result<std::path::PathBuf, SidecarError> {
    let unavailable = |e: String| SidecarError { code: -1, message: e };
    Ok(std::env::current_exe()
        .map_err(|e| unavailable(format!("no app location: {e}")))?
        .parent()
        .ok_or_else(|| unavailable("no app folder".into()))?
        .join("lcu-sidecar"))
}

/// On Windows the sidecar is built into this executable. It is written to the app's
/// cache folder on first use, under a name that carries the app version, so an update
/// never runs an old copy and never overwrites one that is still running.
#[cfg(windows)]
const SIDECAR_EXE: &[u8] = include_bytes!("../binaries/lcu-sidecar-x86_64-pc-windows-msvc.exe");

#[cfg(windows)]
fn sidecar_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, SidecarError> {
    let unavailable = |e: String| SidecarError { code: -1, message: e };
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| unavailable(format!("no cache folder: {e}")))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| unavailable(format!("could not create {}: {e}", dir.display())))?;
    let exe = dir.join(format!("lcu-sidecar-{}.exe", env!("CARGO_PKG_VERSION")));
    if std::fs::metadata(&exe).map(|m| m.len()).ok() != Some(SIDECAR_EXE.len() as u64) {
        // Write to a temporary name first, so a half-written file is never run.
        let tmp = exe.with_extension("tmp");
        std::fs::write(&tmp, SIDECAR_EXE)
            .and_then(|_| std::fs::rename(&tmp, &exe))
            .map_err(|e| unavailable(format!("could not write the sidecar: {e}")))?;
    }
    Ok(exe)
}

/// A command for the sidecar. On Windows it runs without a console window.
fn sidecar_command(exe: &std::path::Path) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(exe);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Runs the sidecar to the end and keeps its output.
async fn sidecar_output(app: &tauri::AppHandle, args: Vec<String>) -> Result<Done, SidecarError> {
    let unavailable = |e: String| SidecarError { code: -1, message: e };
    let exe = sidecar_path(app)?;
    let out = tauri::async_runtime::spawn_blocking(move || {
        sidecar_command(&exe).args(&args).stdin(std::process::Stdio::null()).output()
    })
    .await
    .map_err(|e| unavailable(format!("sidecar task failed: {e}")))?
    .map_err(|e| unavailable(format!("could not run the sidecar: {e}")))?;
    Ok(Done { success: out.status.success(), code: out.status.code(), stdout: out.stdout, stderr: out.stderr })
}

/// Logs and errors arrive on stderr; on a non-zero exit the stderr text is
/// returned as the error message.
async fn run_sidecar(app: &tauri::AppHandle, args: Vec<String>) -> Result<String, SidecarError> {
    let done = sidecar_output(app, args).await?;
    if done.success {
        // Reuse the stdout buffer (it can be over 1 MB) instead of copying it.
        Ok(String::from_utf8(done.stdout)
            .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
    } else {
        Err(SidecarError {
            code: done.code.unwrap_or(-1),
            message: String::from_utf8_lossy(&done.stderr).trim().to_string(),
        })
    }
}

/// The phone page's server process, if one is running.
#[derive(Default)]
struct PhoneServer(Mutex<Option<std::process::Child>>);

/// Stops the phone server, if it is running.
fn stop_phone(server: &PhoneServer) {
    if let Some(mut child) = server.0.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// This computer's address on the local network, for the QR code. No packets are sent: a UDP
/// socket only picks the route.
#[tauri::command]
fn phone_lan_ip() -> Result<String, SidecarError> {
    let unavailable = |e: String| SidecarError { code: -1, message: e };
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
async fn phone_start(app: tauri::AppHandle, port: u16) -> Result<(), SidecarError> {
    if port < 1024 {
        return Err(SidecarError { code: ACTION_REFUSED, message: "port must be 1024 or higher".into() });
    }
    let exe = sidecar_path(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let server = app.state::<PhoneServer>();
        stop_phone(&server);
        let mut cmd = sidecar_command(&exe);
        cmd.args(["serve", &port.to_string()]);
        let child = spawn_phone(cmd, port, PHONE_START_TIMEOUT)?;
        *server.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
        Ok(())
    })
    .await
    .map_err(|e| SidecarError { code: -1, message: format!("phone task failed: {e}") })?
}

/// Starts `cmd` (the sidecar's `serve`) and waits until it says it is listening. Returns
/// the sidecar's own message when it stops first, and stops it when it takes too long.
fn spawn_phone(
    mut cmd: std::process::Command,
    port: u16,
    timeout: std::time::Duration,
) -> Result<std::process::Child, SidecarError> {
    let unavailable = |e: String| SidecarError { code: -1, message: e };
    let mut child = cmd
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| unavailable(format!("could not start the phone page: {e}")))?;
    // Read stderr until the sidecar exits, so it never blocks on a full pipe. The line
    // `phone page on port N` means the server is listening; the end of stderr means it stopped.
    let (tx, rx) = std::sync::mpsc::channel::<Option<String>>();
    if let Some(stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut text = String::new();
            for line in std::io::BufRead::lines(std::io::BufReader::new(stderr)).map_while(Result::ok) {
                if line.starts_with("phone page on port") {
                    let _ = tx.send(None);
                } else {
                    text.push_str(&line);
                    text.push('\n');
                }
            }
            let _ = tx.send(Some(text));
        });
    }
    match rx.recv_timeout(timeout) {
        Ok(None) => Ok(child),
        Ok(Some(text)) => {
            let status = child.wait().ok();
            let text = text.trim();
            Err(SidecarError {
                code: status.and_then(|s| s.code()).unwrap_or(-1),
                message: if text.is_empty() { "the phone page stopped".into() } else { text.to_string() },
            })
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(unavailable(format!("the phone page did not start on port {port}")))
        }
    }
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
        .invoke_handler(tauri::generate_handler![get_spec, player, phone_lan_ip, phone_start, phone_stop])
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

    fn serve(exe: &std::path::Path, lock: &std::path::Path, port: u16) -> std::process::Command {
        let mut cmd = sidecar_command(exe);
        cmd.arg("--lockfile").arg(lock).args(["serve", &port.to_string()]);
        cmd
    }

    #[test]
    fn phone_page_starts_then_a_second_one_reports_the_busy_port() {
        let Some(exe) = sidecar() else { return };
        let lock = lockfile("rift-phone-test-lockfile");
        let port = 18787;
        let mut first = spawn_phone(serve(&exe, &lock, port), port, Duration::from_secs(15)).ok().expect("first server starts");
        assert!(std::net::TcpStream::connect(("127.0.0.1", port)).is_ok(), "the page answers once ready");
        let err = spawn_phone(serve(&exe, &lock, port), port, Duration::from_secs(15)).expect_err("second server fails");
        assert!(err.message.contains("already in use"), "{}", err.message);
        let _ = first.kill();
        let _ = first.wait();
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
