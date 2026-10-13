//! The ASCII art converter (github.com/TheZoraiz/ascii-image-converter, Apache-2.0), bundled next
//! to the app. The picture goes in on stdin and the art comes out on stdout, one row per line.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::ipc::{InvokeBody, Request};

/// The characters the art uses, darkest first. Wide ones such as "@" and "%" are left out, so the
/// rows keep close to the same width in the status box.
const SHADES: &str = "#*+=-:. ";
const MIN_COLS: u32 = 10;
const MAX_COLS: u32 = 60;

/// The converter bundled next to this app. Tauri puts it beside the app's executable.
fn bundled_converter() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("no app location: {e}"))?;
    let name = if cfg!(windows) { "ascii-image-converter.exe" } else { "ascii-image-converter" };
    Ok(exe.parent().ok_or("no app folder")?.join(name))
}

/// Runs the converter on one picture and returns the art, one row per line.
fn convert_with(converter: &Path, picture: &[u8], cols: u32, invert: bool) -> Result<String, String> {
    let mut command = Command::new(converter);
    command.arg("-").arg("-W").arg(cols.clamp(MIN_COLS, MAX_COLS).to_string()).arg("-m").arg(SHADES);
    if invert {
        command.arg("-n");
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start the converter: {e}"))?;
    // The converter reads the whole picture before it writes anything. If it stops early, the
    // write fails, and its own message in stderr says why.
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(picture);
    }
    let out = child.wait_with_output().map_err(|e| format!("the converter did not finish: {e}"))?;
    if !out.status.success() {
        let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if why.is_empty() { "the converter failed".into() } else { why });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Converts a picture to ASCII art. The picture is the raw request body. The headers give the width
/// in characters (`x-cols`) and whether to invert (`x-invert: 1`).
#[tauri::command]
pub fn ascii_art(request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(picture) = request.body() else {
        return Err("the picture was not sent as bytes".into());
    };
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok());
    let cols = header("x-cols").and_then(|v| v.parse::<u32>().ok()).ok_or("no width was given")?;
    let invert = header("x-invert") == Some("1");
    convert_with(&bundled_converter()?, picture, cols, invert)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The converter built for this machine (`bun scripts/build-converter.ts`). The tests are skipped without it.
    fn converter() -> Option<PathBuf> {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
        std::fs::read_dir(dir).ok()?.filter_map(|e| e.ok().map(|e| e.path())).find(|p| {
            p.file_name().unwrap_or_default().to_string_lossy().starts_with("ascii-image-converter-")
        })
    }

    /// A small real picture, as PNG.
    const PICTURE: &[u8] = include_bytes!("../testdata/picture.png");

    #[test]
    fn every_row_is_the_width_asked_for_and_uses_only_the_shades() {
        let Some(exe) = converter() else { return };
        let art = convert_with(&exe, PICTURE, 20, false).unwrap();
        assert!(art.lines().count() > 0);
        for row in art.lines() {
            assert_eq!(row.chars().count(), 20, "{row:?}");
            assert!(row.chars().all(|c| SHADES.contains(c)), "{row:?}");
        }
    }

    #[test]
    fn the_width_is_kept_between_10_and_60() {
        let Some(exe) = converter() else { return };
        let narrow = convert_with(&exe, PICTURE, 1, false).unwrap();
        assert!(narrow.lines().all(|r| r.chars().count() == 10));
        let wide = convert_with(&exe, PICTURE, 500, false).unwrap();
        assert!(wide.lines().all(|r| r.chars().count() == 60));
    }

    #[test]
    fn invert_swaps_dark_and_light() {
        let Some(exe) = converter() else { return };
        let plain = convert_with(&exe, PICTURE, 20, false).unwrap();
        let inverted = convert_with(&exe, PICTURE, 20, true).unwrap();
        assert_ne!(plain, inverted);
    }

    #[test]
    fn bytes_that_are_not_a_picture_are_refused() {
        let Some(exe) = converter() else { return };
        assert!(convert_with(&exe, b"not a picture", 20, false).is_err());
    }
}
