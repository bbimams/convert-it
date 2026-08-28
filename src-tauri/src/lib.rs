use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use parking_lot::Mutex;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

struct ConvertState {
    child: Option<Child>,
    probed_input: Option<String>,
}

/// Resolves a binary from the dirs a GUI app can rely on (Finder launches get
/// a minimal PATH) plus the caller's PATH for CLI launches and exotic
/// installs. `None` when the binary can't be found anywhere.
fn find_bin(name: &str) -> Option<PathBuf> {
    let mut dirs = vec![
        "/opt/homebrew/bin".to_string(),
        "/usr/local/bin".to_string(),
        "/usr/bin".to_string(),
    ];
    if let Ok(path) = std::env::var("PATH") {
        dirs.extend(std::env::split_paths(&path).map(|d| d.to_string_lossy().into_owned()));
    }
    dirs.into_iter()
        .map(|d| std::path::Path::new(&d).join(name))
        .find(|p| p.is_file())
}

fn require_bin(name: &str) -> Result<PathBuf, String> {
    find_bin(name).ok_or_else(|| {
        format!("{name} not found — install FFmpeg (e.g. `brew install ffmpeg`)")
    })
}

/// Probes media metadata and grants the asset protocol access to this file
/// so the WebView can preview it. Scope is per-file at runtime instead of a
/// blanket `**` filesystem grant, and the grant happens only after ffprobe
/// confirms the path is readable media.
#[tauri::command]
fn probe_media(
    app: AppHandle,
    state: State<Arc<Mutex<ConvertState>>>,
    path: String,
) -> Result<serde_json::Value, String> {
    let out = Command::new(require_bin("ffprobe")?)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            &path,
        ])
        .output()
        .map_err(|e| format!("failed to run ffprobe: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    let info: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())?;
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|e| e.to_string())?;
    state.inner().lock().probed_input = Some(path);
    Ok(info)
}

/// Returns which optional ffmpeg filters are available (e.g. drawtext needs freetype).
#[tauri::command]
fn ffmpeg_capabilities() -> Result<Vec<String>, String> {
    let out = Command::new(require_bin("ffmpeg")?)
        .args(["-hide_banner", "-filters"])
        .output()
        .map_err(|e| format!("failed to run ffmpeg: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut caps = Vec::new();
    for f in ["drawtext", "hqdn3d", "palettegen", "paletteuse"] {
        if text.lines().any(|l| l.split_whitespace().nth(1) == Some(f)) {
            caps.push(f.to_string());
        }
    }
    Ok(caps)
}

#[derive(Serialize, Clone)]
struct ProgressPayload {
    ratio: f64,
    out_time: f64,
}

#[derive(Serialize, Clone)]
struct DonePayload {
    ok: bool,
    cancelled: bool,
    message: String,
}

const VALUELESS_OPTS: &[&str] = &["-vn", "-an"];
const VALUE_OPTS: &[&str] = &[
    "-ss", "-to", "-c", "-c:v", "-c:a", "-b:a", "-crf", "-preset",
    "-vf", "-filter_complex", "-map", "-loop",
];

/// The WebView supplies ffmpeg options; enforce a strict allowlist so a
/// compromised script can't reach other argv surfaces (a second `-i` for
/// arbitrary reads, `-f` demuxer override, `-filter_script`, …).
fn validate_options(opts: &[String]) -> Result<(), String> {
    let mut i = 0;
    while i < opts.len() {
        let opt = opts[i].as_str();
        if VALUELESS_OPTS.contains(&opt) {
            i += 1;
        } else if VALUE_OPTS.contains(&opt) {
            if i + 1 >= opts.len() || opts[i + 1].starts_with('-') {
                return Err(format!("missing value for {opt}"));
            }
            i += 2;
        } else {
            return Err(format!("disallowed ffmpeg option: {opt}"));
        }
    }
    Ok(())
}

#[tauri::command]
fn start_convert(
    app: AppHandle,
    state: State<Arc<Mutex<ConvertState>>>,
    input: String,
    output: String,
    pre: Vec<String>,
    post: Vec<String>,
    duration: f64,
) -> Result<(), String> {
    validate_options(&pre)?;
    validate_options(&post)?;
    if output.is_empty() {
        return Err("output path required".into());
    }
    if input == output {
        return Err("input and output paths must differ".into());
    }

    let mut guard = state.inner().lock();
    if guard.child.is_some() {
        return Err("A conversion is already running".into());
    }
    // Reads are bound to the file the user opened; never let the WebView
    // point ffmpeg at arbitrary paths.
    if guard.probed_input.as_deref() != Some(input.as_str()) {
        return Err("input must be the currently loaded file".into());
    }

    let mut child = Command::new(require_bin("ffmpeg")?)
        .args(["-y", "-hide_banner", "-nostats", "-progress", "pipe:1"])
        .args(&pre)
        .arg("-i")
        .arg(&input)
        .args(&post)
        .arg(&output)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run ffmpeg: {e}"))?;

    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    guard.child = Some(child);
    drop(guard);

    let err_buf = Arc::new(Mutex::new(String::new()));
    let err_thread = {
        let err_buf = err_buf.clone();
        std::thread::spawn(move || {
            let mut s = String::new();
            let _ = stderr.read_to_string(&mut s);
            *err_buf.lock() = s;
        })
    };

    let slot = state.inner().clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(v) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = v.trim().parse::<i64>() {
                    let out_time = us as f64 / 1_000_000.0;
                    let ratio = if duration > 0.0 {
                        (out_time / duration).clamp(0.0, 1.0)
                    } else {
                        0.0
                    };
                    let _ = app.emit("convert-progress", ProgressPayload { ratio, out_time });
                }
            }
        }
        // stdout closed: either finished or was cancelled (cancel emits its own event)
        let child = slot.lock().child.take();
        if let Some(mut child) = child {
            let ok = child.wait().map(|s| s.success()).unwrap_or(false);
            // join the stderr reader before reading its buffer so the error
            // text is deterministic
            let _ = err_thread.join();
            let stderr_text = err_buf.lock().clone();
            let message = if ok {
                String::new()
            } else {
                stderr_text.lines().rev().take(6).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n")
            };
            let _ = app.emit(
                "convert-done",
                DonePayload {
                    ok,
                    cancelled: false,
                    message,
                },
            );
        }
    });

    Ok(())
}

#[tauri::command]
fn cancel_convert(app: AppHandle, state: State<Arc<Mutex<ConvertState>>>) {
    let child = state.inner().lock().child.take();
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
        let _ = app.emit(
            "convert-done",
            DonePayload {
                ok: false,
                cancelled: true,
                message: "Cancelled".into(),
            },
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            app.manage(Arc::new(Mutex::new(ConvertState {
                child: None,
                probed_input: None,
            })));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            probe_media,
            ffmpeg_capabilities,
            start_convert,
            cancel_convert
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
