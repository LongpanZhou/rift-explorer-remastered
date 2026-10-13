//! The ASCII art converter (github.com/TheZoraiz/ascii-image-converter, Apache-2.0), bundled next
//! to the app. The picture goes in on stdin and the art comes out on stdout, one row per line.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use tauri::ipc::{InvokeBody, Request};

const DETAILED: &str = "$@B%8&WM#*oahkbdpqwmZO0QLCJUYXzcvunxrjft/\\|()1{}[]?-_+~<>i!lI;:,\"^`'. ";

/// The characters a picture can be drawn with, darkest first, as (ramp, shown). The converter is given
/// `ramp`, one byte per character, and its output is then shown with the matching characters of `shown`.
/// Only "blocks" differs: the converter reads a multi-byte map wrongly, so it gets ASCII. "standard"
/// leaves out the wide "@" and "%", so its rows keep close to the same width in the status box. The
/// other three are the sets of the site ascii-converter.github.io.
fn character_set(name: &str) -> Option<(&'static str, &'static str)> {
    match name {
        "standard" => Some(("#*+=-:. ", "#*+=-:. ")),
        "detailed" => Some((DETAILED, DETAILED)),
        "blocks" => Some(("#*+- ", "█▓▒░ ")),
        "binary" => Some(("01 ", "01 ")),
        _ => None,
    }
}
const MIN_COLS: u32 = 10;
const MAX_COLS: u32 = 60;

/// The converter bundled next to this app. Tauri puts it beside the app's executable.
fn bundled_converter() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("no app location: {e}"))?;
    let name = if cfg!(windows) { "ascii-image-converter.exe" } else { "ascii-image-converter" };
    Ok(exe.parent().ok_or("no app folder")?.join(name))
}

/// The converter's own message, or a plain one when it gave none.
fn or_failed(message: &str) -> String {
    if message.is_empty() { "the converter failed".into() } else { message.into() }
}

/// Runs the converter on one picture and returns the art, one row per line.
fn convert_with(converter: &Path, picture: &[u8], cols: u32, invert: bool, set: (&str, &str)) -> Result<String, String> {
    let (ramp, shown) = set;
    let mut command = Command::new(converter);
    command.arg("-").arg("-W").arg(cols.clamp(MIN_COLS, MAX_COLS).to_string()).arg("-m").arg(ramp);
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
        return Err(or_failed(String::from_utf8_lossy(&out.stderr).trim()));
    }
    let text = String::from_utf8_lossy(&out.stdout).into_owned();
    // A failed conversion still exits with 0 and prints its message on stdout. Art only uses the
    // characters of its ramp, so any other character means the text is a message.
    if text.chars().any(|c| c != '\n' && !ramp.contains(c)) {
        return Err(or_failed(text.lines().next().unwrap_or("").trim()));
    }
    // Each character of the ramp is shown as the character at the same place in `shown`.
    let shown: Vec<char> = shown.chars().collect();
    Ok(text.chars().map(|c| ramp.chars().position(|r| r == c).map_or(c, |i| shown[i])).collect())
}

/// Converts a picture to ASCII art. The picture is the raw request body. The headers give the width
/// in characters (`x-cols`), whether to invert (`x-invert: 1`) and the character set (`x-chars`,
/// standard when it is not given).
#[tauri::command]
pub fn ascii_art(request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(picture) = request.body() else {
        return Err("the picture was not sent as bytes".into());
    };
    let header = |name: &str| request.headers().get(name).and_then(|v| v.to_str().ok());
    let cols = header("x-cols").and_then(|v| v.parse::<u32>().ok()).ok_or("no width was given")?;
    let invert = header("x-invert") == Some("1");
    let set = character_set(header("x-chars").unwrap_or("standard")).ok_or("unknown character set")?;
    convert_with(&bundled_converter()?, picture, cols, invert, set)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The converter built for this machine (`bun scripts/build-converter.ts`). The tests are skipped without it.
    fn converter() -> Option<PathBuf> {
        let platform = if cfg!(target_os = "macos") {
            "apple-darwin"
        } else if cfg!(windows) {
            "windows-msvc.exe"
        } else {
            "unknown-linux-gnu"
        };
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
        std::fs::read_dir(dir).ok()?.filter_map(|e| e.ok().map(|e| e.path())).find(|p| {
            let name = p.file_name().unwrap_or_default().to_string_lossy().into_owned();
            name.starts_with("ascii-image-converter-") && name.ends_with(platform)
        })
    }

    /// A small real picture, as PNG.
    const PICTURE: &[u8] = include_bytes!("../testdata/picture.png");

    #[test]
    fn every_character_set_gives_rows_of_the_width_asked_for() {
        let Some(exe) = converter() else { return };
        for name in ["standard", "detailed", "blocks", "binary"] {
            let (_, shown) = character_set(name).unwrap();
            let art = convert_with(&exe, PICTURE, 20, false, character_set(name).unwrap()).unwrap();
            assert!(art.lines().count() > 0);
            for row in art.lines() {
                assert_eq!(row.chars().count(), 20, "{name}: {row:?}");
                assert!(row.chars().all(|c| shown.contains(c)), "{name}: {row:?}");
            }
        }
    }

    /// Black on the left, white on the right, as PNG.
    const HALVES: &[u8] = include_bytes!("../testdata/halves.png");

    #[test]
    fn dark_is_drawn_dense_and_light_is_drawn_sparse_in_every_set() {
        let Some(exe) = converter() else { return };
        for name in ["standard", "detailed", "blocks", "binary"] {
            let (_, shown) = character_set(name).unwrap();
            let art = convert_with(&exe, HALVES, 20, false, character_set(name).unwrap()).unwrap();
            let row: Vec<char> = art.lines().next().unwrap().chars().collect();
            assert_eq!(row.len(), 20, "{name}");
            assert_eq!(row[0], shown.chars().next().unwrap(), "{name}");
            assert_eq!(row[19], shown.chars().last().unwrap(), "{name}");
        }
    }

    #[test]
    fn only_the_listed_character_sets_are_known() {
        assert!(character_set("standard").is_some());
        assert!(character_set("wide").is_none());
    }

    #[test]
    fn the_width_is_kept_between_10_and_60() {
        let Some(exe) = converter() else { return };
        let standard = character_set("standard").unwrap();
        let narrow = convert_with(&exe, PICTURE, 1, false, standard).unwrap();
        assert!(narrow.lines().all(|r| r.chars().count() == 10));
        let wide = convert_with(&exe, PICTURE, 500, false, standard).unwrap();
        assert!(wide.lines().all(|r| r.chars().count() == 60));
    }

    #[test]
    fn invert_swaps_dark_and_light() {
        let Some(exe) = converter() else { return };
        let standard = character_set("standard").unwrap();
        let plain = convert_with(&exe, PICTURE, 20, false, standard).unwrap();
        let inverted = convert_with(&exe, PICTURE, 20, true, standard).unwrap();
        assert_ne!(plain, inverted);
    }

    #[test]
    fn bytes_that_are_not_a_picture_are_refused() {
        let Some(exe) = converter() else { return };
        assert!(convert_with(&exe, b"not a picture", 20, false, character_set("standard").unwrap()).is_err());
    }
}
