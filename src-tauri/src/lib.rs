use serde::Serialize;
use tauri_plugin_shell::ShellExt;

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

/// Logs and errors arrive on stderr; on a non-zero exit the stderr text is
/// returned as the error message.
async fn run_sidecar(app: &tauri::AppHandle, args: Vec<String>) -> Result<String, SidecarError> {
    let unavailable = |e: String| SidecarError { code: -1, message: e };
    let output = app
        .shell()
        .sidecar("lcu-sidecar")
        .map_err(|e| unavailable(format!("sidecar not available: {e}")))?
        .args(args)
        .output()
        .await
        .map_err(|e| unavailable(format!("could not run the sidecar: {e}")))?;

    if output.status.success() {
        // Reuse the stdout buffer (it can be over 1 MB) instead of copying it.
        Ok(String::from_utf8(output.stdout)
            .unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned()))
    } else {
        Err(SidecarError {
            code: output.status.code().unwrap_or(-1),
            message: String::from_utf8_lossy(&output.stderr).trim().to_string(),
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
