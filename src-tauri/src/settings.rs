use std::path::PathBuf;

use serde_json::{json, Value};

use crate::state::AppState;

/// 设置文件: 存在 data_dir 下, 损坏时整体退回默认值而不是崩溃或部分生效。
/// 读写只在这一个模块里做, 调用方拿到的永远是 AppState 里的字段。
fn settings_path(app: &tauri::AppHandle) -> PathBuf {
    crate::commands::data_dir(app).join("settings.json")
}

pub fn load(app: &tauri::AppHandle, state: &std::sync::Mutex<AppState>) {
    let Ok(text) = std::fs::read_to_string(settings_path(app)) else {
        return;
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return;
    };
    let mut guard = state.lock().unwrap();
    if let Some(speed) = value.get("speed").and_then(Value::as_u64) {
        if matches!(speed, 115200 | 230400 | 460800 | 921600) {
            guard.current_speed = speed as u32;
        }
    }
    if let Some(theme) = value.get("theme").and_then(Value::as_str) {
        if matches!(theme, "light" | "dark" | "system") {
            guard.theme = theme.to_string();
        }
    }
    if let Some(auto) = value.get("autoSelectDevice").and_then(Value::as_bool) {
        guard.auto_select_device = auto;
    }
    if let Some(silent) = value.get("silentSaveDump").and_then(Value::as_bool) {
        guard.silent_save_dump = silent;
    }
    if let Some(full) = value.get("fullEncEnabled").and_then(Value::as_bool) {
        guard.full_enc_enabled = full;
    }
}

pub fn save(app: &tauri::AppHandle, state: &std::sync::Mutex<AppState>) {
    let guard = state.lock().unwrap();
    let value = json!({
        "speed": guard.current_speed,
        "theme": guard.theme,
        "autoSelectDevice": guard.auto_select_device,
        "silentSaveDump": guard.silent_save_dump,
        "fullEncEnabled": guard.full_enc_enabled,
    });
    drop(guard);
    let text = match serde_json::to_string_pretty(&value) {
        Ok(text) => text,
        Err(_) => return,
    };
    let _ = std::fs::write(settings_path(app), text);
}

/// 设置窗口打开时下发的当前值
pub fn payload(state: &std::sync::Mutex<AppState>) -> Value {
    let guard = state.lock().unwrap();
    json!({
        "speed": guard.current_speed,
        "theme": guard.theme,
        "autoSelectDevice": guard.auto_select_device,
        "silentSaveDump": guard.silent_save_dump,
        "fullEncEnabled": guard.full_enc_enabled,
    })
}
