use serde::Serialize;

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

/// On macOS and Linux the sidecar is a separate file next to the app.
#[cfg(not(windows))]
async fn sidecar_output(app: &tauri::AppHandle, args: Vec<String>) -> Result<Done, SidecarError> {
    use tauri_plugin_shell::ShellExt;
    let unavailable = |e: String| SidecarError { code: -1, message: e };
    let out = app
        .shell()
        .sidecar("lcu-sidecar")
        .map_err(|e| unavailable(format!("sidecar not available: {e}")))?
        .args(args)
        .output()
        .await
        .map_err(|e| unavailable(format!("could not run the sidecar: {e}")))?;
    Ok(Done { success: out.status.success(), code: out.status.code(), stdout: out.stdout, stderr: out.stderr })
}

/// On Windows the sidecar is built into this executable. It is written to the app's
/// cache folder on first use, then run from there without a console window.
#[cfg(windows)]
const SIDECAR_EXE: &[u8] = include_bytes!("../binaries/lcu-sidecar-x86_64-pc-windows-msvc.exe");

#[cfg(windows)]
async fn sidecar_output(app: &tauri::AppHandle, args: Vec<String>) -> Result<Done, SidecarError> {
    use std::os::windows::process::CommandExt;
    use tauri::Manager;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let unavailable = |e: String| SidecarError { code: -1, message: e };
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| unavailable(format!("no cache folder: {e}")))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| unavailable(format!("could not create {}: {e}", dir.display())))?;
    let exe = dir.join("lcu-sidecar.exe");
    if std::fs::metadata(&exe).map(|m| m.len()).ok() != Some(SIDECAR_EXE.len() as u64) {
        std::fs::write(&exe, SIDECAR_EXE)
            .map_err(|e| unavailable(format!("could not write the sidecar: {e}")))?;
    }
    let out = tauri::async_runtime::spawn_blocking(move || {
        std::process::Command::new(&exe).args(&args).creation_flags(CREATE_NO_WINDOW).output()
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![get_spec, player])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
