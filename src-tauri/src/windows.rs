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
        // Windows 下 tauri 的 parent() 实际建的是 owner 窗口(WS_POPUP, 不是 WS_CHILD),
        // 所以 position() 是屏幕绝对坐标。若上游改成真子窗口, 坐标会变成父客户区内
        // 相对值, 这段算法必须整体重写。
        // outer_position/outer_size 返回物理像素, 而 position() 收逻辑像素,
        // 所以先把父窗口几何各自换算到逻辑空间, 再在逻辑空间做居中减法。
        // 注意不能写成 (size.width - width)/2/scale: 那样物理与逻辑像素会在
        // 除 scale 之前混合相加, 只在 scale==1 时凑巧正确, 高缩放下会整体偏移。
        // 取不到几何就跳过定位, 退回系统默认位置, 不能因此打不开窗口。
        // 已知偏差: position() 定位的是窗口边框左上角, 而 width/height 是客户区
        // 尺寸, 故 about 这类带标题栏的窗口居中后会比几何中心偏上约半个标题栏。
        // 另: 父窗口横跨不同 DPI 的多屏时, tao 按落点所在显示器的 scale 反算,
        // 与这里用的父窗口 scale 可能不一致, 会带来少量偏移。
        if let (Ok(pos), Ok(size), Ok(scale)) = (
            parent.outer_position(),
            parent.outer_size(),
            parent.scale_factor(),
        ) {
            if scale > 0.0 {
                let parent_w = size.width as f64 / scale;
                let parent_h = size.height as f64 / scale;
                let x = pos.x as f64 / scale + (parent_w - width as f64) / 2.0;
                let y = pos.y as f64 / scale + (parent_h - height as f64) / 2.0;
                builder = builder.position(x, y);
            }
        }
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
