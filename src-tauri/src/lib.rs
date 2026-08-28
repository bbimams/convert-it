use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use parking_lot::Mutex;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

struct ConvertState(Arc<Mutex<Option<Child>>>);

fn find_bin(name: &str) -> String {
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        let full = format!("{dir}/{name}");
        if std::path::Path::new(&full).exists() {
            return full;
        }
    }
    name.to_string()
}

#[tauri::command]
fn probe_media(path: String) -> Result<serde_json::Value, String> {
    let out = Command::new(find_bin("ffprobe"))
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
    serde_json::from_slice(&out.stdout).map_err(|e| e.to_string())
}

/// Returns which optional ffmpeg filters are available (e.g. drawtext needs freetype).
#[tauri::command]
fn ffmpeg_capabilities() -> Result<Vec<String>, String> {
    let out = Command::new(find_bin("ffmpeg"))
        .args(["-hide_banner", "-filters"])
        .output()
        .map_err(|e| format!("failed to run ffmpeg: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut caps = Vec::new();
    for f in ["drawtext", "hqdn3d", "palettegen"] {
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

#[tauri::command]
fn start_convert(
    app: AppHandle,
    state: State<ConvertState>,
    args: Vec<String>,
    duration: f64,
) -> Result<(), String> {
    let mut guard = state.0.lock();
    if guard.is_some() {
        return Err("A conversion is already running".into());
    }

    let mut child = Command::new(find_bin("ffmpeg"))
        .args(["-y", "-hide_banner", "-nostats", "-progress", "pipe:1"])
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to run ffmpeg: {e}"))?;

    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    *guard = Some(child);
    drop(guard);

    let err_buf = Arc::new(Mutex::new(String::new()));
    {
        let err_buf = err_buf.clone();
        std::thread::spawn(move || {
            let mut s = String::new();
            let _ = stderr.read_to_string(&mut s);
            *err_buf.lock() = s;
        });
    }

    let slot = state.0.clone();
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
        let child = slot.lock().take();
        if let Some(mut child) = child {
            let ok = child.wait().map(|s| s.success()).unwrap_or(false);
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
fn cancel_convert(app: AppHandle, state: State<ConvertState>) {
    let child = state.0.lock().take();
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
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(ConvertState(Arc::new(Mutex::new(None))));
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
