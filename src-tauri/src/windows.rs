use std::sync::Mutex;

use serde_json::json;
use tauri::{
    webview::PageLoadEvent, AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::state::AppState;

const BRIDGE_JS: &str = include_str!("embedded.js");

fn init_script(state: &Mutex<AppState>) -> String {
    let lang = state.lock().unwrap().lang.clone();
    let json = crate::i18n::locale_json(&lang);
    format!(
        "window.__I18N__ = {json};\nwindow.__I18N_LANG__ = {lang:?};\n{BRIDGE_JS}"
    )
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("main")
}

fn create(
    app: &AppHandle,
    state: &Mutex<AppState>,
    label: &str,
    html: &str,
    width: u32,
    height: u32,
    parent: Option<WebviewWindow>,
    decorations: bool,
    resizable: bool,
    maximizable: bool,
    minimizable: bool,
    always_on_top: bool,
    payload: Option<(String, serde_json::Value)>,
) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(label) {
        existing.set_focus().ok();
        if let Some((channel, value)) = &payload {
            app.emit_to(label, channel, value).ok();
        }
        return Ok(());
    }
    let mut builder = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(format!("html/{html}.html").into()),
    )
    .title("NFCToolsGUI")
    .inner_size(width as f64, height as f64)
    .visible(false)
    .decorations(decorations)
    .resizable(resizable)
    .maximizable(maximizable)
    .minimizable(minimizable)
    .always_on_top(always_on_top)
    .initialization_script(&init_script(state));
    if let Some(parent) = &parent {
        builder = builder.parent(parent).map_err(|err| err.to_string())?;
    }
    if let Some((channel, value)) = payload {
        let handle = app.clone();
        let window_label = label.to_string();
        builder = builder.on_page_load(move |_window, page| {
            if matches!(page.event(), PageLoadEvent::Finished) {
                let handle = handle.clone();
                let channel = channel.clone();
                let value = value.clone();
                let window_label = window_label.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    handle.emit_to(&window_label, &channel, &value).ok();
                });
            }
        });
    }
    builder.build().map_err(|err| err.to_string())?;
    Ok(())
}

pub fn create_main_window(app: &AppHandle, state: &Mutex<AppState>) -> Result<(), String> {
    create(
        app,
        state,
        "main",
        "index",
        800,
        740,
        None,
        false,
        false,
        false,
        true,
        false,
        None,
    )
}

pub fn create_settings_window(app: &AppHandle, state: &Mutex<AppState>) -> Result<(), String> {
    let speed = state.lock().unwrap().current_speed;
    create(
        app,
        state,
        "settings",
        "settings",
        400,
        470,
        main_window(app),
        false,
        false,
        false,
        false,
        false,
        Some(("settings-speed".to_string(), json!({ "speed": speed }))),
    )
}

pub fn create_input_keys_window(app: &AppHandle, state: &Mutex<AppState>) -> Result<(), String> {
    create(
        app,
        state,
        "inputKeys",
        "inputkeys",
        400,
        160,
        main_window(app),
        false,
        false,
        false,
        false,
        false,
        None,
    )
}

pub fn create_uid_input_window(app: &AppHandle, state: &Mutex<AppState>) -> Result<(), String> {
    create(
        app,
        state,
        "uidInput",
        "uidInput",
        400,
        200,
        main_window(app),
        false,
        false,
        false,
        false,
        false,
        None,
    )
}

pub fn create_hard_nested_window(
    app: &AppHandle,
    state: &Mutex<AppState>,
    config: Option<serde_json::Value>,
) -> Result<(), String> {
    create(
        app,
        state,
        "hardNested",
        "hardNested",
        500,
        570,
        main_window(app),
        false,
        false,
        false,
        false,
        false,
        Some((
            "update-hard-nested-config".to_string(),
            config.unwrap_or(serde_json::Value::Null),
        )),
    )
}

pub fn create_dict_test_window(
    app: &AppHandle,
    state: &Mutex<AppState>,
    config: Option<serde_json::Value>,
) -> Result<(), String> {
    create(
        app,
        state,
        "dictTest",
        "dictTest",
        450,
        350,
        main_window(app),
        false,
        false,
        false,
        false,
        false,
        Some((
            "update-dict-test-config".to_string(),
            config.unwrap_or(serde_json::Value::Null),
        )),
    )
}

pub fn create_dump_editor_window(
    app: &AppHandle,
    state: &Mutex<AppState>,
    file: Option<String>,
) -> Result<(), String> {
    create(
        app,
        state,
        "dumpEditor",
        "dumpEditor",
        380,
        720,
        None,
        true,
        false,
        false,
        false,
        false,
        Some((
            "update-dump-editor-file".to_string(),
            serde_json::Value::from(file),
        )),
    )
}

pub fn create_dump_comparator_window(
    app: &AppHandle,
    state: &Mutex<AppState>,
    dumps: Option<serde_json::Value>,
) -> Result<(), String> {
    create(
        app,
        state,
        "dumpComparator",
        "dumpComparator",
        380,
        720,
        None,
        true,
        false,
        false,
        false,
        false,
        dumps.map(|value| ("update-dump-comparator-files".to_string(), value)),
    )
}

pub fn create_dump_history_window(
    app: &AppHandle,
    state: &Mutex<AppState>,
    dumps: Vec<String>,
) -> Result<(), String> {
    create(
        app,
        state,
        "dumpHistory",
        "dumpHistory",
        380,
        720,
        None,
        true,
        false,
        false,
        false,
        false,
        Some((
            "update-dump-history".to_string(),
            serde_json::Value::from(dumps),
        )),
    )
}

pub fn create_phone_wristband_window(
    app: &AppHandle,
    state: &Mutex<AppState>,
) -> Result<(), String> {
    create(
        app,
        state,
        "phoneWristband",
        "phoneWristband",
        400,
        380,
        main_window(app),
        false,
        false,
        false,
        false,
        false,
        None,
    )
}

pub fn create_about_window(app: &AppHandle, state: &Mutex<AppState>) -> Result<(), String> {
    create(
        app,
        state,
        "about",
        "about",
        600,
        480,
        main_window(app),
        true,
        false,
        false,
        false,
        false,
        None,
    )
}
