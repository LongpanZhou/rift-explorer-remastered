/// The Windows sidecar and ASCII converter are embedded in the executable. They are packed with
/// zstd here, at build time, so the single portable .exe is about half the size; the app
/// decompresses each into its cache folder on first use. The other platforms ship them as
/// separate files next to the app.
#[cfg(windows)]
fn pack(name: &str, out_name: &str) {
    let src = std::path::Path::new("binaries").join(name);
    println!("cargo:rerun-if-changed={}", src.display());
    let data = std::fs::read(&src)
        .unwrap_or_else(|e| panic!("could not read {}: {e}. Build it first.", src.display()));
    // Level 10 is about 3 s for the sidecar and within a few MB of the slowest setting.
    let packed = zstd::stream::encode_all(std::io::Cursor::new(&data), 10)
        .unwrap_or_else(|e| panic!("could not compress {}: {e}", src.display()));
    let out = std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("OUT_DIR")).join(out_name);
    std::fs::write(&out, &packed).unwrap_or_else(|e| panic!("could not write {}: {e}", out.display()));
    // The app checks this against the unpacked file, so a half-written copy is not run.
    std::fs::write(out.with_extension("len"), data.len().to_string())
        .unwrap_or_else(|e| panic!("could not write the length of {}: {e}", src.display()));
}

fn main() {
    #[cfg(windows)]
    {
        pack("lcu-sidecar-x86_64-pc-windows-msvc.exe", "lcu-sidecar.exe.zst");
        pack("ascii-image-converter-x86_64-pc-windows-msvc.exe", "ascii-image-converter.exe.zst");
    }
    tauri_build::build()
}
