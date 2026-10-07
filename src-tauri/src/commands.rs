use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::Local;
use regex::Regex;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::i18n::t;
use crate::state::AppState;
use crate::task::{hidden_command, TaskManager};
use crate::windows;

pub const DEFAULT_KEYS: [&str; 13] = [
    "ffffffffffff",
    "a0a1a2a3a4a5",
    "d3f7d3f7d3f7",
    "000000000000",
    "b0b1b2b3b4b5",
    "4d3a99c351dd",
    "1a982c7e459a",
    "aabbccddeeff",
    "714c5c886e97",
    "587ee5f9350f",
    "a0478cc39091",
    "533cb6c723f6",
    "8fd0a4f256e9",
];

// 扇区号由工具自己打印, 直接捕获; 不用匹配序号反推 (序号只在单次输出内连续,
// 一旦上游增删行就会整体错位)。与 src/keyParser.js 保持一致。
fn key_sector_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"Sector\s+(\d+)\s*-\s*(?:Found|Unknown)\s+Key\s+[AB]").unwrap())
}

// 距离攻击恢复阶段: 扇区上下文。探测进度行 "Sector: N, type A, probe .., distance .."
// 末尾没有换行符 (source/mfoc/src/mfoc.c:555), 点进度 (:568) 与换行 (:571) 之后才
// 输出密钥 (:602) —— 扇区与密钥分处两条物理行, 必须跨行保持上下文, 正则不能加行尾锚定。
fn recover_sector_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"Sector:\s*(\d+),\s*type\s*[AB]").unwrap())
}

fn recover_key_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"Found\s+Key:\s*([AB])\s*\[([0-9a-fA-F]{12})\]").unwrap())
}

fn key_info_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(Found|Unknown)\s+Key\s+([AB]):?\s*([0-9a-fA-F]{12})?").unwrap())
}

fn hex12_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[0-9A-Fa-f]{12}").unwrap())
}

fn sector_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\(sector (\d{1,2})\)").unwrap())
}

pub fn bin_dir() -> PathBuf {
    if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../framework/bin").to_path_buf()
    } else {
        // 退回当前工作目录而不是空 PathBuf: 空的基准会让 spawn 按相对路径查找,
        // 报出的 ENOENT 里连真实路径都没有, 排查不了
        exe_dir()
            .map(|dir| dir.join("framework").join("bin"))
            .unwrap_or_else(|| PathBuf::from("."))
    }
}

pub fn dict_path() -> PathBuf {
    if cfg!(debug_assertions) {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../dict.dic").to_path_buf()
    } else {
        exe_dir()
            .map(|dir| dir.join("dict.dic"))
            .unwrap_or_else(|| PathBuf::from("."))
    }
}

fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe().ok().and_then(|path| path.parent().map(|dir| dir.to_path_buf()))
}

fn now_stamp() -> String {
    Local::now().format("%Y_%m_%d_%H_%M_%S").to_string()
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

fn format_duration(total_seconds: i64) -> String {
    let double = |num: i64| if num < 10 { format!("0{num}") } else { num.to_string() };
    let h = total_seconds / 3600;
    let m = (total_seconds / 60) % 60;
    let s = total_seconds % 60;
    if h > 0 {
        format!("{}:{}:{}", double(h), double(m), double(s))
    } else {
        format!("{}:{}", double(m), double(s))
    }
}

struct Paths {
    keys: PathBuf,
    temp_mfd: PathBuf,
    nonces: PathBuf,
    dump_files: PathBuf,
}

pub fn data_dir(app: &AppHandle) -> PathBuf {
    let dir = match std::env::var_os("APPDATA") {
        Some(roaming) => PathBuf::from(roaming).join("NFCToolsGUI"),
        // 拿不到应用数据目录时退回临时目录下的独立子目录: 空的 PathBuf 会让
        // create_dir_all 失败, 之后所有路径都退化成相对当前工作目录, 密钥和 dump
        // 会写到错误位置。不直接用 temp_dir() 根目录, 否则密钥会和系统临时目录
        // 里其它文件混在一起, 且会被系统定期清理。
        None => app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir().join("NFCToolsGUI")),
    };
    std::fs::create_dir_all(&dir).ok();
    dir
}

fn paths(app: &AppHandle) -> Paths {
    let dir = data_dir(app);
    Paths {
        keys: dir.join("keys.txt"),
        temp_mfd: dir.join("temp.mfd"),
        nonces: dir.join("nonces.bin"),
        dump_files: dir.join("dumpfiles"),
    }
}

fn print_log(app: &AppHandle, text: &str) {
    app.emit("update-log-output", text).ok();
}

fn print_status(app: &AppHandle, state: &Mutex<AppState>, text: &str) {
    app.emit(
        "update-status",
        json!({ "text": text, "indicator": "running" }),
    )
    .ok();
}

fn log_exit(app: &AppHandle, state: &Mutex<AppState>, code: u8) {
    match code {
        1 => {
            app.emit(
                "update-status",
                json!({ "text": t(state, "indicator_error"), "indicator": "error" }),
            )
            .ok();
            print_log(app, &format!("\n{}", t(state, "log_msg_error")));
        }
        _ => {
            app.emit(
                "update-status",
                json!({ "text": t(state, "indicator_free"), "indicator": "free" }),
            )
            .ok();
            print_log(app, &format!("\n{}", t(state, "log_msg_finished")));
        }
    }
}

fn exit_success(app: &AppHandle, state: &Mutex<AppState>) {
    log_exit(app, state, 0)
}

fn show_error(app: &AppHandle, state: &Mutex<AppState>, title_key: &str, message_key: &str) {
    let _ = rfd::MessageDialog::new()
        .set_title(t(state, title_key))
        .set_description(t(state, message_key))
        .set_buttons(rfd::MessageButtons::Ok)
        .set_level(rfd::MessageLevel::Error)
        .show();
}

fn confirm(app: &AppHandle, state: &Mutex<AppState>, title_key: &str, message_key: &str) -> bool {
    let title = t(state, title_key);
    let message = t(state, message_key);
    rfd::MessageDialog::new()
        .set_title(title)
        .set_description(message)
        .set_buttons(rfd::MessageButtons::YesNo)
        .set_level(rfd::MessageLevel::Warning)
        .show()
        == rfd::MessageDialogResult::Yes
}

fn confirm_with_detail(
    app: &AppHandle,
    state: &Mutex<AppState>,
    title_key: &str,
    message_key: &str,
    detail: &str,
) -> bool {
    let title = t(state, title_key);
    let message = format!("{}\n{}", t(state, message_key), detail);
    rfd::MessageDialog::new()
        .set_title(title)
        .set_description(message)
        .set_buttons(rfd::MessageButtons::OkCancel)
        .show()
        == rfd::MessageDialogResult::Ok
}

#[derive(PartialEq, Eq)]
enum TaskOutcome {
    Success,
    Failed,
    Killed,
}

struct TaskClaim<'a>(&'a Mutex<TaskManager>);

impl Drop for TaskClaim<'_> {
    fn drop(&mut self) {
        self.0.lock().unwrap().release();
    }
}

fn run_task(
    app: &AppHandle,
    state: &Mutex<AppState>,
    tasks: &Mutex<TaskManager>,
    cmd: &str,
    args: &[String],
    msg: &str,
    on_line: &mut dyn FnMut(&str),
    finish: &mut dyn FnMut(Option<i32>),
) -> Result<TaskOutcome, String> {
    let need_device = {
        let guard = state.lock().unwrap();
        guard.current_device.is_none() || (!guard.device_connected && cmd != "nfc-list")
    };
    if need_device {
        app.emit(
            "update-status",
            json!({ "text": t(state, "indicator_error"), "indicator": "error" }),
        )
        .ok();
        show_error(app, state, "dialog_title_error", "dialog_msg_not_connected_device");
        return Err("device not connected".into());
    }
    if !tasks.lock().unwrap().claim() {
        show_error(app, state, "dialog_title_device_busy", "dialog_msg_running_task");
        return Err("device busy".into());
    }
    let _claim = TaskClaim(tasks);
    print_log(app, &format!("\n\n### {msg}\n"));
    let dir = data_dir(app);
    let spawn_result = tasks
        .lock()
        .unwrap()
        .spawn(app, &bin_dir(), cmd, args, &dir);
    let mut rx = match spawn_result {
        Ok(rx) => rx,
        Err(err) => {
            print_log(app, &format!("\n{err}"));
            log_exit(app, state, 1);
            return Err(err.to_string());
        }
    };
    let mut last_lines: Vec<String> = Vec::new();
    while let Ok(line) = rx.recv() {
        // 跳过进度重绘与控制码行(以及距离攻击的点进度), 只保留有业务含义的行作为错误上下文
        if !line.contains("\u{1b}[2K") && !line.is_empty() {
            last_lines.push(line.clone());
            while last_lines.len() > 3 {
                last_lines.remove(0);
            }
        }
        on_line(&line);
    }
    let slot = tasks.lock().unwrap().take_child();
    let Some(slot) = slot else {
        finish(None);
        return Ok(TaskOutcome::Killed);
    };
    let mut child = slot.lock().unwrap().take();
    let code = child
        .as_mut()
        .and_then(|child| child.wait().ok())
        .and_then(|status| status.code());
    finish(code);
    let killed = tasks.lock().unwrap().killed.load(Ordering::SeqCst);
    let code = if killed { None } else { code };
    let Some(code) = code else {
        app.emit(
            "update-events",
            json!({ "type": "error", "text": t(state, "event_task_killed") }),
        )
        .ok();
        log_exit(app, state, 2);
        return Ok(TaskOutcome::Killed);
    };
    if code != 0 {
        print_log(app, &format!("\nexit code: {code}"));
        let mut text = format!("{}{}", t(state, "event_task_failed"), code);
        if !last_lines.is_empty() {
            let detail: String = last_lines.join(" ");
            let truncated: String = detail.chars().take(160).collect();
            let ellipsis = if truncated.chars().count() < detail.chars().count() { "…" } else { "" };
            text = format!("{text} | {truncated}{ellipsis}");
        }
        app.emit(
            "update-events",
            json!({ "type": "error", "text": text }),
        )
        .ok();
        log_exit(app, state, 1);
        return Ok(TaskOutcome::Failed);
    }
    Ok(TaskOutcome::Success)
}

fn check_key_file(keys: &Path) {
    if !keys.exists() {
        std::fs::File::create(keys).ok();
    }
}

fn save_keys(app: &AppHandle, state: &Mutex<AppState>, new_keys: &[String]) {
    let p = paths(app);
    check_key_file(&p.keys);
    let existing_text = std::fs::read_to_string(&p.keys).unwrap_or_default();
    let existing: Vec<String> = hex12_re()
        .find_iter(&existing_text)
        .map(|match_| match_.as_str().to_string())
        .collect();
    let existing_set: HashSet<String> = existing.iter().cloned().collect();
    let mut merged = existing;
    merged.extend(new_keys.iter().cloned());
    let mut seen: HashSet<String> = HashSet::new();
    merged.retain(|key| seen.insert(key.clone()));
    for default in DEFAULT_KEYS {
        if let Some(i) = merged.iter().position(|key| key.as_str() == default) {
            merged.remove(i);
        }
    }
    std::fs::write(&p.keys, merged.join("\n")).ok();
    let fresh: Vec<String> = merged
        .iter()
        .filter(|key| !existing_set.contains(*key))
        .cloned()
        .collect();
    if !fresh.is_empty() {
        app.emit(
            "update-events",
            json!({
                "type": "key",
                "text": format!("{}{}", t(state, "event_keys_saved"), fresh.join(", "))
            }),
        )
        .ok();
    }
}

fn key_info_statistic(state: &mut AppState, line: &str) {
    // 阶段一: 内置密钥, 每扇区一行, A/B 两条密钥信息同属该行
    if let Some(caps) = key_sector_re().captures(line) {
        state.key_sector = caps.get(1).and_then(|m| m.as_str().parse::<i64>().ok());
    }
    if let Some(sector) = state.key_sector {
        for caps in key_info_re().captures_iter(line) {
            let key_type = caps.get(2).map(|m| m.as_str()).unwrap_or_default().to_string();
            let key = caps.get(3).map(|m| m.as_str()).map(str::to_lowercase);
            if caps.get(1).map(|m| m.as_str()) == Some("Found") {
                // Found 但没抓到完整 12 位 hex 时跳过, 不把残缺结果当成已知密钥
                if let Some(key) = key {
                    state.known_key_info.push((key.clone(), sector, key_type));
                    state.new_keys.push(key);
                }
            } else {
                state.unknown_key_info.push((sector, key_type));
            }
        }
    }

    // 阶段二: 距离攻击恢复。扇区头与密钥是两条物理行 ——
    // 探测进度行 "Sector: N, type A, probe .., distance .. " 后面先接点进度再换行
    // (source/mfoc/src/mfoc.c:555/568/571), "  Found Key: A [hex]" 在换行之后才输出
    // (同文件 602), 所以扇区上下文必须跨行保持。
    if let Some(caps) = recover_sector_re().captures(line) {
        state.recover_sector = caps.get(1).and_then(|m| m.as_str().parse::<i64>().ok());
    }
    if let Some(sector) = state.recover_sector {
        for caps in recover_key_re().captures_iter(line) {
            let Some(key) = caps.get(2).map(|m| m.as_str()).map(str::to_lowercase) else {
                continue;
            };
            let key_type = caps.get(1).map(|m| m.as_str()).unwrap_or_default().to_string();
            state.known_key_info.push((key.clone(), sector, key_type.clone()));
            state.new_keys.push(key);
            // 恢复出的密钥要同时移出待解列表, 否则自动模式会朝已解开的扇区再采集一轮。
            // 必须按 扇区+键位 精确匹配: 外层循环跑两轮, 同一扇区的 A 和 B 可能分别恢复。
            if let Some(i) = state
                .unknown_key_info
                .iter()
                .position(|u| u.0 == sector && u.1 == key_type)
            {
                state.unknown_key_info.remove(i);
            }
        }
    }
}

fn parse_uid(line: &str) -> Option<String> {
    let i = line.find("UID (NFCID1):")?;
    let start = i + "UID (NFCID1):".len() + 1;
    let end = (start + 14).min(line.len());
    Some(line.get(start..end)?.split_whitespace().collect::<String>())
}

fn send_hard_nested_progress(app: &AppHandle, state: &Mutex<AppState>) {
    let s = state.lock().unwrap();
    if s.total_unknown_keys == 0 {
        return;
    }
    let index = s
        .total_unknown_keys
        .saturating_sub(s.unknown_key_info.len() as i64)
        .saturating_add(1)
        .max(1);
    let percent = ((index as f64 / s.total_unknown_keys as f64) * 100.0)
        .round()
        .min(100.0)
        .max(0.0) as u32;
    app.emit("update-progress", json!({ "percent": percent })).ok();
}

struct MfocEta {
    start: u128,
    last_update: u128,
    done: i64,
    total: i64,
    finished: bool,
}

fn update_mfoc_eta(eta: &mut MfocEta, line: &str, app: &AppHandle, state: &Mutex<AppState>) {
    if eta.finished {
        return;
    }
    eta.done += line.matches("[Key: ").count() as i64;
    if eta.done == 0 {
        return;
    }
    if eta.done >= eta.total {
        eta.finished = true;
        print_status(app, state, &t(state, "indicator_reading_ic_card"));
        app.emit("update-progress", json!({ "percent": 100 })).ok();
        return;
    }
    let now = now_ms();
    if now.saturating_sub(eta.last_update) < 1000 {
        return;
    }
    eta.last_update = now;
    let done = eta.done.max(1);
    let remain = ((now.saturating_sub(eta.start)) as f64 / 1000.0 / done as f64 * (eta.total - eta.done) as f64)
        .round()
        .max(0.0) as i64;
    let text = format!(
        "{} - {} {}",
        t(state, "indicator_reading_ic_card"),
        t(state, "html_eta_remaining"),
        format_duration(remain)
    );
    print_status(app, state, &text);
    let percent = ((eta.done as f64 / eta.total.max(1) as f64) * 100.0)
        .round()
        .min(100.0)
        .max(0.0) as u32;
    app.emit("update-progress", json!({ "percent": percent })).ok();
}

fn mfoc(app: &AppHandle, state: &Mutex<AppState>, tasks: &Mutex<TaskManager>, args: &[String]) {
    let p = paths(app);
    check_key_file(&p.keys);
    let total = {
        let mut s = state.lock().unwrap();
        s.reset_task_state();
        let file_keys = std::fs::read_to_string(&p.keys)
            .map(|text| hex12_re().find_iter(&text).count())
            .unwrap_or(0);
        let arg_keys = args.iter().filter(|arg| arg.starts_with("-k")).count();
        DEFAULT_KEYS.len() as i64 + file_keys as i64 + arg_keys as i64
    };
    let mut eta = MfocEta {
        start: now_ms(),
        last_update: 0,
        done: 0,
        total,
        finished: false,
    };
    let mut card_id: Option<String> = None;
    let mfoc_msg = t(state, "log_msg_start_mfoc");
    let outcome = run_task(
        app,
        state,
        tasks,
        "mfoc",
        args,
        &mfoc_msg,
        &mut |line| {
            {
                let mut s = state.lock().unwrap();
                key_info_statistic(&mut s, line);
            }
            if let Some(uid) = parse_uid(line) {
                card_id = Some(uid);
            }
            update_mfoc_eta(&mut eta, line, app, state);
        },
        &mut |_code| {
            let new_keys = state.lock().unwrap().new_keys.clone();
            save_keys(app, state, &new_keys);
            let size = std::fs::metadata(&p.temp_mfd).map(|m| m.len()).unwrap_or(0);
            if !p.temp_mfd.exists() {
                print_log(
                    app,
                    &format!("\n{}\n", t(state, "log_msg_dump_empty_not_saved")),
                );
            } else if size == 0 {
                std::fs::remove_file(&p.temp_mfd).ok();
                print_log(
                    app,
                    &format!("\n{}\n", t(state, "log_msg_dump_empty_not_saved")),
                );
            }
        },
    );
    let Ok(outcome) = outcome else {
        return;
    };
    if outcome == TaskOutcome::Success {
        exit_success(app, state);
    }
    let temp = p.temp_mfd.clone();
    let size = std::fs::metadata(&temp).map(|m| m.len()).unwrap_or(0);
    if !temp.exists() || size == 0 {
        return;
    }
    std::fs::create_dir_all(&p.dump_files).ok();
    let name = format!(
        "{}_{}.mfd",
        card_id.unwrap_or_else(|| "card".into()),
        now_stamp()
    );
    let default_target = p.dump_files.join(&name);
    let chosen = rfd::FileDialog::new()
        .set_title(t(state, "dialog_title_save_to"))
        .set_directory(&p.dump_files)
        .set_file_name(default_target.file_name().unwrap_or_default().to_string_lossy().into_owned())
        .add_filter(t(state, "file_type_dump"), &["dump", "mfd"])
        .save_file();
    let user_chosen = chosen.is_some();
    let target = chosen.unwrap_or(default_target);
    match std::fs::rename(&temp, &target) {
        Err(_) => {
            print_log(app, &format!("\n\n{}\n", t(state, "log_msh_save_failed")));
            log_exit(app, state, 1);
        }
        Ok(_) => {
            if user_chosen {
                print_log(
                    app,
                    &format!(
                        "\n\n{} {}\n",
                        t(state, "log_msg_file_already_saved_to"),
                        target.display()
                    ),
                );
            } else {
                print_log(
                    app,
                    &format!(
                        "\n\n{} {}\n",
                        t(state, "log_msg_dump_auto_saved"),
                        target.display()
                    ),
                );
            }
            app.emit(
                "dump-saved",
                json!({ "filename": target.to_string_lossy().to_string() }),
            )
            .ok();
        }
    }
}

fn read_dump_phase(
    app: &AppHandle,
    state: &Mutex<AppState>,
    tasks: &Mutex<TaskManager>,
    save_dump_file: bool,
    msg: &str,
) -> Result<TaskOutcome, String> {
    let p = paths(app);
    check_key_file(&p.keys);
    state.lock().unwrap().reset_task_state();
    let status_text = if save_dump_file {
        t(state, "indicator_backing_up_current_card")
    } else {
        t(state, "indicator_detecting_ic_card")
    };
    print_status(app, state, &status_text);
    let args = if save_dump_file {
        vec![
            format!("-O{}", p.temp_mfd.display()),
            format!("-f{}", p.keys.display()),
        ]
    } else {
        vec![
            "-N".to_string(),
            format!("-f{}", p.keys.display()),
        ]
    };
    let outcome = run_task(
        app,
        state,
        tasks,
        "nfc-mfdetect",
        &args,
        msg,
        &mut |line| {
            let mut s = state.lock().unwrap();
            key_info_statistic(&mut s, line);
        },
        &mut |_code| {
            let new_keys = state.lock().unwrap().new_keys.clone();
            save_keys(app, state, &new_keys);
            if save_dump_file {
                let size = std::fs::metadata(&p.temp_mfd).map(|m| m.len()).unwrap_or(0);
                if p.temp_mfd.exists() && size == 0 {
                    std::fs::remove_file(&p.temp_mfd).ok();
                }
            }
        },
    )?;
    Ok(outcome)
}

fn write_ic(app: &AppHandle, state: &Mutex<AppState>, tasks: &Mutex<TaskManager>, arg: &Value) {
    let p = paths(app);
    let dump = match arg.as_str() {
        Some(name) => {
            let path = PathBuf::from(name);
            if path.is_absolute() {
                path
            } else {
                p.dump_files.join(name)
            }
        }
        None => {
            let Some(path) = rfd::FileDialog::new()
                .set_title(t(state, "dialog_title_choose_dump_need_to_write"))
                .set_directory(&p.dump_files)
                .add_filter(t(state, "file_type_dump"), &["dump", "mfd"])
                .pick_file()
            else {
                return;
            };
            path
        }
    };
    if !confirm(
        app,
        state,
        "dialog_title_danger_operation",
        "dialog_msg_confirm_write_dump",
    ) {
        return;
    }
    let detect_msg = t(state, "log_msg_read_ic_then_execute");
    if let Ok(TaskOutcome::Success) = read_dump_phase(app, state, tasks, true, &detect_msg) {
        print_status(app, state, &t(state, "indicator_writing_ic_card"));
        let temp = p.temp_mfd.clone();
        if !temp.exists() {
            print_log(
                app,
                &format!("\n{}\n", t(state, "log_msg_card_read_failed")),
            );
            exit_success(app, state);
            return;
        }
        let args = vec![
            "w".to_string(),
            "A".to_string(),
            "u".to_string(),
            dump.to_string_lossy().to_string(),
            temp.to_string_lossy().to_string(),
            "f".to_string(),
        ];
        let write_msg = t(state, "log_msg_start_write_card");
        let mut finish = |code: Option<i32>| {
            let text = if code == Some(0) {
                t(state, "log_msg_write_success")
            } else {
                t(state, "log_msg_write_failed")
            };
            print_log(app, &format!("\n\n{}\n", text));
            std::fs::remove_file(&temp).ok();
        };
        if run_task(
            app,
            state,
            tasks,
            "nfc-mfclassic",
            &args,
            &write_msg,
            &mut |_| {},
            &mut finish,
        ) == Ok(TaskOutcome::Success)
        {
            exit_success(app, state);
        }
    }
}

fn format_card(app: &AppHandle, state: &Mutex<AppState>, tasks: &Mutex<TaskManager>) {
    let p = paths(app);
    let detect_msg = t(state, "log_msg_read_ic_then_execute");
    if let Ok(TaskOutcome::Success) = read_dump_phase(app, state, tasks, true, &detect_msg) {
        print_status(app, state, &t(state, "indicator_formatting_ic_card"));
        let temp = p.temp_mfd.clone();
        if !temp.exists() {
            print_log(
                app,
                &format!("\n{}\n", t(state, "log_msg_card_read_failed")),
            );
            exit_success(app, state);
            return;
        }
        let args = vec![
            "f".to_string(),
            "A".to_string(),
            "u".to_string(),
            temp.to_string_lossy().to_string(),
            temp.to_string_lossy().to_string(),
            "f".to_string(),
        ];
        let format_msg = t(state, "log_msg_start_format_card");
        if run_task(
            app,
            state,
            tasks,
            "nfc-mfclassic",
            &args,
            &format_msg,
            &mut |_| {},
            &mut |_code| {
                std::fs::remove_file(&temp).ok();
            },
        ) == Ok(TaskOutcome::Success)
        {
            exit_success(app, state);
        }
    }
}

fn detect_card_type(app: &AppHandle, state: &Mutex<AppState>, tasks: &Mutex<TaskManager>) {
    let p = paths(app);
    check_key_file(&p.keys);
    state.lock().unwrap().reset_task_state();
    print_status(app, state, &t(state, "indicator_detecting_ic_card"));
    let args = vec!["-N".to_string(), format!("-f{}", p.keys.display())];
    let detect_msg = t(state, "log_msg_start_detect_card");
    let outcome = run_task(
        app,
        state,
        tasks,
        "nfc-mfdetect",
        &args,
        &detect_msg,
        &mut |line| {
            let mut s = state.lock().unwrap();
            key_info_statistic(&mut s, line);
        },
        &mut |_code| {},
    );
    if outcome == Ok(TaskOutcome::Success) {
        exit_success(app, state);
        let count = state.lock().unwrap().unknown_key_info.len() as i64;
        if count > 0 {
            app.emit(
                "show-guidance",
                json!({
                    "text": format!(
                        "{}{}{}",
                        t(state, "guidance_unknown_pre"),
                        count,
                        t(state, "guidance_unknown_post")
                    ),
                    "buttons": [
                        { "action": "hard-nested", "label": t(state, "html_hard_nested") },
                        { "action": "dict-test", "label": t(state, "html_test_dictionary") }
                    ]
                }),
            )
            .ok();
        }
    }
}

fn write_ufuid_uid(app: &AppHandle, state: &Mutex<AppState>, tasks: &Mutex<TaskManager>) {
    let p = paths(app);
    let file = match rfd::FileDialog::new()
        .set_title(t(state, "dialog_title_choose_dump_need_to_write"))
        .set_directory(&p.dump_files)
        .add_filter(t(state, "file_type_dump"), &["dump", "mfd"])
        .pick_file()
    {
        Some(path) => path,
        None => return,
    };
    let bytes = match std::fs::read(&file) {
        Ok(data) => data,
        Err(_) => {
            print_log(
                app,
                &format!("\n\n{}\n", t(state, "log_msg_read_dump_file_failed")),
            );
            log_exit(app, state, 1);
            return;
        }
    };
    let block0: String = bytes
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
        .to_uppercase();
    if block0.len() != 32 {
        print_log(
            app,
            &format!("\n\n{}\n", t(state, "log_msg_dump_file_too_short")),
        );
        log_exit(app, state, 1);
        return;
    }
    let message = format!("{}{}", t(state, "dialog_msg_confirm_write_uid"), block0);
    let confirmed = rfd::MessageDialog::new()
        .set_title(t(state, "dialog_title_danger_operation"))
        .set_description(message)
        .set_buttons(rfd::MessageButtons::YesNo)
        .set_level(rfd::MessageLevel::Warning)
        .show()
        == rfd::MessageDialogResult::Yes;
    if !confirmed {
        return;
    }
    print_status(app, state, &t(state, "indicator_writing_ufuid_uid"));
    let args = vec!["-q".to_string(), block0];
    let setuid_msg = t(state, "log_msg_start_write_ufuid_uid");
    if run_task(
        app,
        state,
        tasks,
        "nfc-mfsetuid",
        &args,
        &setuid_msg,
        &mut |_| {},
        &mut |_| {},
    ) == Ok(TaskOutcome::Success)
    {
        exit_success(app, state);
    }
}

// 剥离常见分隔符后整体校验, 只接受 4 字节 UID (8 hex) 或完整 0 块 (32 hex)
fn clean_uid_input(text: &str) -> Option<String> {
    let trimmed: String = text
        .chars()
        .filter(|&c| !matches!(c, ' ' | '\t' | '\r' | '\n' | ':' | '-' | '_' | '.'))
        .collect();
    if trimmed.is_empty()
        || !trimmed.chars().all(|c| c.is_ascii_hexdigit())
        || !(trimmed.len() == 8 || trimmed.len() == 32)
    {
        return None;
    }
    Some(trimmed.to_uppercase())
}

fn hex_byte(hex: &str, index: usize) -> u8 {
    u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).unwrap_or(0)
}

fn uid_to_block0(uid: &str) -> String {
    let bcc = hex_byte(uid, 0) ^ hex_byte(uid, 1) ^ hex_byte(uid, 2) ^ hex_byte(uid, 3);
    // 0 块布局: UID(4) + BCC(1) + SAK(1) + ATQA(2) + 8 字节补零
    let mut block0 = format!("{uid}{bcc:02X}080400");
    block0.push_str("0000000000000000");
    block0
}

fn block0_bcc_ok(block0: &str) -> bool {
    let bcc = hex_byte(block0, 0) ^ hex_byte(block0, 1) ^ hex_byte(block0, 2) ^ hex_byte(block0, 3);
    hex_byte(block0, 4) == bcc
}

fn done_input_uid_write(
    app: &AppHandle,
    state: &Mutex<AppState>,
    tasks: &Mutex<TaskManager>,
    arg: &Value,
) {
    let text = arg.as_str().unwrap_or_default();
    let Some(cleaned) = clean_uid_input(text) else {
        show_error(app, state, "dialog_title_error", "dialog_msg_invalid_uid_input");
        return;
    };
    let block0 = if cleaned.len() == 8 { uid_to_block0(&cleaned) } else { cleaned };
    let force_bcc = !block0_bcc_ok(&block0);
    let mut message = format!("{}{}", t(state, "dialog_msg_confirm_write_uid"), block0);
    if force_bcc {
        message.push_str(&t(state, "log_msg_bcc_force"));
    }
    let confirmed = rfd::MessageDialog::new()
        .set_title(t(state, "dialog_title_danger_operation"))
        .set_description(message)
        .set_buttons(rfd::MessageButtons::YesNo)
        .set_level(rfd::MessageLevel::Warning)
        .show()
        == rfd::MessageDialogResult::Yes;
    if !confirmed {
        return;
    }
    if force_bcc {
        print_log(app, &format!("\n{}\n", t(state, "log_msg_bcc_force")));
    }
    print_status(app, state, &t(state, "indicator_writing_ufuid_uid"));
    let mut args = vec!["-q".to_string(), block0];
    if force_bcc {
        args.push("-f".to_string());
    }
    let setuid_msg = t(state, "log_msg_start_write_ufuid_uid");
    if run_task(
        app,
        state,
        tasks,
        "nfc-mfsetuid",
        &args,
        &setuid_msg,
        &mut |_| {},
        &mut |_| {},
    ) == Ok(TaskOutcome::Success)
    {
        exit_success(app, state);
    }
}

fn lock_ufuid(app: &AppHandle, state: &Mutex<AppState>, tasks: &Mutex<TaskManager>) {
    if !confirm(
        app,
        state,
        "dialog_title_danger_operation",
        "dialog_msg_card_will_be_locked",
    ) {
        return;
    }
    print_status(app, state, &t(state, "indicator_locking_ufuid"));
    let lock_msg = t(state, "log_msg_start_lock_ufuid");
    if run_task(
        app,
        state,
        tasks,
        "nfc-mflock",
        &["-q".to_string()],
        &lock_msg,
        &mut |_| {},
        &mut |_| {},
    ) == Ok(TaskOutcome::Success)
    {
        exit_success(app, state);
    }
}

struct CollectCtx {
    uid: Option<String>,
    sector: Option<String>,
    key_type: Option<String>,
}

fn parse_collect(line: &str, ctx: &mut CollectCtx) {
    if let Some(i) = line.find("Found tag with uid ") {
        let start = i + "Found tag with uid ".len();
        let end = (start + 8).min(line.len());
        ctx.uid = Some(line.get(start..end).unwrap_or("").to_string());
    }
    let Some(j) = line.find("collecting nonces for key") else {
        return;
    };
    if let Some(caps) = sector_re().captures(line) {
        if let Some(match_) = caps.get(1) {
            ctx.sector = Some(match_.as_str().to_string());
        }
    }
    ctx.key_type = Some(line.get(j + 26..j + 27).unwrap_or("").to_string());
}

#[derive(Clone)]
struct HardConfig {
    known_key: String,
    known_sector: i64,
    known_key_type: String,
    target_sector: i64,
    target_key_type: String,
    collect_only: bool,
    auto_run: bool,
}

fn hard_config_from(value: &Value) -> Option<HardConfig> {
    if value.is_null() {
        return None;
    }
    let str_field = |key: &str| {
        value.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string()
    };
    let int_field = |key: &str| {
        value
            .get(key)
            .and_then(|v| {
                v.as_i64()
                    .or_else(|| v.as_str().and_then(|text| text.parse::<i64>().ok()))
            })
            .unwrap_or(0)
    };
    let bool_field = |key: &str| value.get(key).and_then(|v| v.as_bool()).unwrap_or(false);
    Some(HardConfig {
        known_key: str_field("knownKey"),
        known_sector: int_field("knownSector"),
        known_key_type: str_field("knownKeyType"),
        target_sector: int_field("targetSector"),
        target_key_type: str_field("targetKeyType"),
        collect_only: bool_field("collectOnly"),
        auto_run: bool_field("autoRun"),
    })
}

fn hard_nested_payload(state: &Mutex<AppState>) -> Option<Value> {
    let s = state.lock().unwrap();
    let known = s.known_key_info.first()?;
    let unknown = s.unknown_key_info.first()?;
    Some(json!({
        "knownKey": known.0,
        "knownSector": known.1,
        "knownKeyType": known.2,
        "targetSector": unknown.0,
        "targetKeyType": unknown.1
    }))
}

fn hard_nested(app: &AppHandle, state: &Mutex<AppState>) {
    windows::create_hard_nested_window(app, state, hard_nested_payload(state)).ok();
}

fn hard_nested_config_done(
    app: &AppHandle,
    state: &Mutex<AppState>,
    tasks: &Mutex<TaskManager>,
    arg: &Value,
) {
    let Some(cfg) = hard_config_from(arg) else {
        return;
    };
    if cfg.auto_run {
        auto_hard_nested(app, state, tasks, true);
    } else {
        let _ = run_hard_nested_once(app, state, tasks, &cfg, true);
    }
}

/// run_hard_nested_once 在自动模式下的结果, 供 auto_hard_nested 决定是否继续下一轮
enum AutoStep {
    /// 本轮解出了新密钥, 可以继续
    Progress,
    /// 本轮一无所获, 继续下去只是反复采集同一批 nonce, 空转占用读卡器
    NoProgress,
    /// 流程已自行收尾 (非自动模式 / 任务失败), 调用方不要再动
    Done,
}

fn run_hard_nested_once(
    app: &AppHandle,
    state: &Mutex<AppState>,
    tasks: &Mutex<TaskManager>,
    cfg: &HardConfig,
    reset_total: bool,
) -> AutoStep {
    let p = paths(app);
    let mut cfg = cfg.clone();
    cfg.known_sector = (cfg.known_sector + 1) * 4 - 1;
    cfg.target_sector = (cfg.target_sector + 1) * 4 - 1;
    if reset_total && !cfg.auto_run {
        let total = state.lock().unwrap().unknown_key_info.len() as i64;
        state.lock().unwrap().total_unknown_keys = total;
    }
    send_hard_nested_progress(app, state);
    let progress = {
        let s = state.lock().unwrap();
        if cfg.auto_run {
            let index = s
                .total_unknown_keys
                .saturating_sub(s.unknown_key_info.len() as i64)
                .saturating_add(1);
            format!(" - {}/{}", index, s.total_unknown_keys)
        } else {
            String::new()
        }
    };
    print_status(
        app,
        state,
        &format!("{}{}", t(state, "indicator_collecting_nonces"), progress),
    );
    let collect_args = vec![
        cfg.known_key.clone(),
        cfg.known_sector.to_string(),
        cfg.known_key_type.clone(),
        cfg.target_sector.to_string(),
        cfg.target_key_type.clone(),
        "bin".to_string(),
        p.nonces.to_string_lossy().to_string(),
    ];
    let mut ctx = CollectCtx {
        uid: None,
        sector: None,
        key_type: None,
    };
    let collect_msg = format!("{}{}", t(state, "log_msg_start_collect_nonces"), "\n\n");
    let outcome = run_task(
        app,
        state,
        tasks,
        "libnfc-collect",
        &collect_args,
        &collect_msg,
        &mut |line| {
            parse_collect(line, &mut ctx)
        },
        &mut |_code| {},
    );
    let Ok(outcome) = outcome else {
        return AutoStep::Done;
    };
    if cfg.collect_only {
        let mut rename_failed = false;
        let size = std::fs::metadata(&p.nonces).map(|m| m.len()).unwrap_or(0);
        if size != 0 {
            let default_name = match (&ctx.uid, &ctx.sector, &ctx.key_type) {
                (Some(uid), Some(sector), Some(key_type)) => {
                    format!("{uid}_{sector}{key_type}")
                }
                _ => "nonces".to_string(),
            };
            match rfd::FileDialog::new()
                .set_title(t(state, "dialog_title_save_to"))
                .set_file_name(&default_name)
                .add_filter(t(state, "file_type_bin"), &["bin"])
                .save_file()
            {
                Some(target) => match std::fs::rename(&p.nonces, &target) {
                    Err(_) => {
                        rename_failed = true;
                        print_log(app, &t(state, "log_msh_save_failed"));
                    }
                    Ok(_) => {
                        print_log(
                            app,
                            &format!(
                                "\n\n{} {}\n",
                                t(state, "log_msg_file_already_saved_to"),
                                target.display()
                            ),
                        );
                    }
                },
                None => print_log(app, &t(state, "log_msg_not_saved")),
            }
        }
        if rename_failed {
            log_exit(app, state, 1);
        } else if outcome == TaskOutcome::Success {
            exit_success(app, state);
        }
        return AutoStep::Done;
    }
    if outcome != TaskOutcome::Success {
        return AutoStep::Done;
    }
    send_hard_nested_progress(app, state);
    let progress = {
        let s = state.lock().unwrap();
        let index = s
            .total_unknown_keys
            .saturating_sub(s.unknown_key_info.len() as i64)
            .saturating_add(1);
        format!(" - {}/{}", index, s.total_unknown_keys)
    };
    print_status(
        app,
        state,
        &format!("{}{}", t(state, "indicator_doing_hard_nested"), progress),
    );
    let target_sector = ctx.sector.as_ref().and_then(|value| value.parse::<i64>().ok());
    let target_key_type = ctx.key_type.clone();
    let crack_msg = t(state, "lod_msg_start_hard_nested");
    let mut found_key = false;
    let crack = run_task(
        app,
        state,
        tasks,
        "cropto1_bs",
        &[p.nonces.to_string_lossy().to_string()],
        &crack_msg,
        &mut |line| {
            if let Some(i) = line.find("Key found:") {
                let start = i + "Key found:".len() + 1;
                let end = (start + 12).min(line.len());
                let key = line.get(start..end).unwrap_or("").to_string();
                if key.is_empty() {
                    return;
                }
                found_key = true;
                save_keys(app, state, &[key.clone()]);
                let mut s = state.lock().unwrap();
                if !s.unknown_key_info.is_empty()
                    && target_sector == Some(s.unknown_key_info[0].0)
                    && target_key_type.as_deref() == Some(s.unknown_key_info[0].1.as_str())
                {
                    s.unknown_key_info.remove(0);
                }
            }
        },
        &mut |_code| {},
    );
    match crack {
        Ok(TaskOutcome::Success) => {
            if cfg.auto_run {
                if found_key {
                    AutoStep::Progress
                } else {
                    AutoStep::NoProgress
                }
            } else {
                exit_success(app, state);
                AutoStep::Done
            }
        }
        _ => AutoStep::Done,
    }
}

fn auto_hard_nested(
    app: &AppHandle,
    state: &Mutex<AppState>,
    tasks: &Mutex<TaskManager>,
    mut from_user: bool,
) {
    loop {
        let p = paths(app);
        check_key_file(&p.keys);
        let _ = std::fs::File::create(&p.nonces);
        let detect_msg = t(state, "log_msg_read_ic_then_execute");
        let outcome = read_dump_phase(app, state, tasks, false, &detect_msg);
        match outcome {
            Ok(TaskOutcome::Success) => {}
            _ => return,
        }
        let control = {
            let s = state.lock().unwrap();
            if s.known_key_info.is_empty() {
                "abort-missing-known"
            } else if s.unknown_key_info.is_empty() {
                "done"
            } else {
                "continue"
            }
        };
        match control {
            "abort-missing-known" => {
                print_log(app, &format!("\n{}", t(state, "log_msg_not_found_known_key")));
                log_exit(app, state, 1);
                return;
            }
            "done" => {
                print_log(
                    app,
                    &format!("\n{}\n", t(state, "log_msg_tried_decrypt_all_unknown_keys")),
                );
                exit_success(app, state);
                return;
            }
            _ => {}
        }
        let cfg = {
            let mut s = state.lock().unwrap();
            // total_unknown_keys 会被每轮的 read_dump_phase 重置清零, 所以除首轮外
            // 归零也要重设, 否则第二轮起进度会显示 1/0 并冻结
            if from_user || s.total_unknown_keys == 0 {
                s.total_unknown_keys = s.unknown_key_info.len() as i64;
            }
            let (known_key, known_sector, known_key_type) = &s.known_key_info[0];
            let (target_sector, target_key_type) = &s.unknown_key_info[0];
            HardConfig {
                known_key: known_key.clone(),
                known_sector: *known_sector,
                known_key_type: known_key_type.clone(),
                target_sector: *target_sector,
                target_key_type: target_key_type.clone(),
                collect_only: false,
                auto_run: true,
            }
        };
        from_user = false;
        let progress = {
            let s = state.lock().unwrap();
            let index = s
                .total_unknown_keys
                .saturating_sub(s.unknown_key_info.len() as i64)
                .saturating_add(1);
            format!(" - {}/{}", index, s.total_unknown_keys)
        };
        print_status(
            app,
            state,
            &format!("{}{}", t(state, "indicator_doing_hard_nested"), progress),
        );
        match run_hard_nested_once(app, state, tasks, &cfg, false) {
            AutoStep::Progress => {}
            AutoStep::NoProgress => {
                print_log(
                    app,
                    &format!("\n{}\n", t(state, "log_msg_no_hard_nested_progress")),
                );
                exit_success(app, state);
                return;
            }
            AutoStep::Done => return,
        }
    }
}

fn open_dict_file(app: &AppHandle, state: &Mutex<AppState>) {
    let current = state.lock().unwrap().dict_path.clone();
    let directory = current
        .parent()
        .map(|dir| dir.to_path_buf())
        .unwrap_or_default();
    let Some(path) = rfd::FileDialog::new()
        .set_title(t(state, "dialog_title_choose_dictionary_file"))
        .set_directory(&directory)
        .add_filter(t(state, "file_type_dict"), &["txt", "dic"])
        .pick_file()
    else {
        return;
    };
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default();
    state.lock().unwrap().dict_path = path;
    app.emit_to("dictTest", "dict-file-name", &name).ok();
}

fn dict_test(app: &AppHandle, state: &Mutex<AppState>) {
    let payload = {
        let s = state.lock().unwrap();
        s.unknown_key_info
            .first()
            .map(|(sector, key_type)| json!({ "targetSector": sector, "targetKeyType": key_type }))
    };
    windows::create_dict_test_window(app, state, payload).ok();
}

fn dict_test_config_done(
    app: &AppHandle,
    state: &Mutex<AppState>,
    tasks: &Mutex<TaskManager>,
    arg: &Value,
) {
    let sector = arg.get("sector").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let key_type = arg.get("keyType").and_then(|v| v.as_str()).unwrap_or("A").to_string();
    let start = arg.get("startPosition").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let dict_path = state.lock().unwrap().dict_path.clone();
    print_status(app, state, &t(state, "indicator_testing_dictionary"));
    let args = vec![
        format!("-s{sector}"),
        format!("-t{key_type}"),
        format!("-l{start}"),
        format!("-d{}", dict_path.display()),
    ];
    let target_sector: i64 = sector.parse().unwrap_or(i64::MIN);
    let dict_msg = t(state, "log_msg_start_test_dictionary");
    let outcome = run_task(
        app,
        state,
        tasks,
        "nfc-mfdict",
        &args,
        &dict_msg,
        &mut |line| {
            if let Some(i) = line.find("Found Key: ") {
                let start_ = i + "Found Key: ".len();
                let end = (start_ + 12).min(line.len());
                let key = line.get(start_..end).unwrap_or("").to_string();
                if key.is_empty() {
                    return;
                }
                save_keys(app, state, &[key]);
                let mut s = state.lock().unwrap();
                if !s.unknown_key_info.is_empty()
                    && s.unknown_key_info[0].0 == target_sector
                    && s.unknown_key_info[0].1 == key_type
                {
                    s.unknown_key_info.remove(0);
                }
            }
        },
        &mut |_code| {},
    );
    if outcome == Ok(TaskOutcome::Success) {
        exit_success(app, state);
    }
}

fn open_history_keys(app: &AppHandle) {
    let p = paths(app);
    check_key_file(&p.keys);
    let _ = hidden_command("notepad.exe").arg(&p.keys).spawn();
}

fn open_dump_editor(app: &AppHandle, state: &Mutex<AppState>, arg: &Value) {
    let p = paths(app);
    let file = arg.as_str().map(|name| {
        if PathBuf::from(name).is_absolute() {
            PathBuf::from(name)
        } else {
            p.dump_files.join(name)
        }
    });
    windows::create_dump_editor_window(
        app,
        state,
        file.map(|path| path.to_string_lossy().to_string()),
    )
    .ok();
}

fn open_dump_comparator(app: &AppHandle, state: &Mutex<AppState>, arg: &Value) {
    let p = paths(app);
    let dumps = if arg.is_null() {
        None
    } else {
        Some(json!({
            "A": p.dump_files.join(arg.get("A").and_then(|v| v.as_str()).unwrap_or("")),
            "B": p.dump_files.join(arg.get("B").and_then(|v| v.as_str()).unwrap_or("")),
        }))
    };
    windows::create_dump_comparator_window(app, state, dumps).ok();
}

fn hex_string(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn grouped_hex(bytes: &[u8], join_rows: bool) -> Value {
    let hex = hex_string(bytes);
    let rows: Vec<String> = hex.as_bytes().chunks(32).map(|chunk| {
        String::from_utf8_lossy(chunk).into_owned()
    }).collect();
    let groups: Vec<Vec<String>> = rows
        .chunks(4)
        .map(|chunk| chunk.iter().cloned().collect())
        .collect();
    if join_rows {
        Value::from(
            groups
                .iter()
                .map(|group| group.join("\n"))
                .collect::<Vec<String>>(),
        )
    } else {
        Value::from(groups)
    }
}

// 用户可见的文件操作失败不能静默 return, 否则用户点了保存/删除却毫无反应。
// 与 Electron 侧 command.js 的 reportIOError 保持一致。
fn io_fail(app: &AppHandle, state: &Mutex<AppState>, err: std::io::Error) {
    print_log(
        app,
        &format!("\n{} {}\n", t(state, "log_msg_operation_failed"), err),
    );
    log_exit(app, state, 1);
}

fn dump_editor_choose_file(app: &AppHandle, state: &Mutex<AppState>, arg: &Value) {
    let path = match arg.as_str() {
        Some(name) => PathBuf::from(name),
        None => {
            let dict_dir = state.lock().unwrap().dict_path.clone();
            let mut dialog = rfd::FileDialog::new()
                .set_title(t(state, "dialog_title_choose_dump_file"))
                .set_directory(&dict_dir)
                .add_filter("Dump Files", &["mfd", "dump"]);
            // 转储编辑器是独立子窗口, 对话框不挂父窗口时在 Windows 上可能被推到后台或
            // 另一块屏幕, 用户看不见也点不到确认键。挂到当前编辑器窗口上, 保证模态显示。
            if let Some(win) = app.get_webview_window("dumpEditor") {
                dialog = dialog.set_parent(&win);
            }
            let Some(path) = dialog.pick_file() else {
                return;
            };
            path
        }
    };
    let bytes = match std::fs::read(&path) {
        Ok(data) => data,
        Err(err) => {
            io_fail(app, state, err);
            return;
        }
    };
    let data = grouped_hex(&bytes, true);
    app.emit_to(
        "dumpEditor",
        "binary-data",
        &json!({ "url": path.to_string_lossy().to_string(), "data": data }),
    )
    .ok();
}

fn dump_editor_save(app: &AppHandle, state: &Mutex<AppState>, arg: &Value) {
    let url = arg.get("url").and_then(|value| value.as_str()).unwrap_or_default();
    let hex_data = arg
        .get("hexData")
        .and_then(|value| value.as_str())
        .unwrap_or_default();
    let save_as = arg.get("saveAs").and_then(|value| value.as_bool()).unwrap_or(false);
    let bytes = hex_to_bytes(hex_data);
    let target = if save_as {
        let mut dialog = rfd::FileDialog::new()
            .set_title(t(state, "dialog_title_save_to"))
            .set_file_name(Path::new(url)
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .unwrap_or_default())
            .add_filter(t(state, "file_type_dump"), &["dump", "mfd"]);
        // 转储编辑器是独立子窗口, 对话框不挂父窗口时在 Windows 上可能被推到后台或
        // 另一块屏幕, 用户看不见也点不到确认键。挂到当前编辑器窗口上, 保证模态显示。
        if let Some(win) = app.get_webview_window("dumpEditor") {
            dialog = dialog.set_parent(&win);
        }
        let Some(path) = dialog.save_file() else {
            return;
        };
        path
    } else {
        PathBuf::from(url)
    };
    if let Err(err) = std::fs::write(&target, &bytes) {
        io_fail(app, state, err);
        return;
    }
    app.emit_to(
        "dumpEditor",
        "saved-binary-data",
        &json!({ "url": target.to_string_lossy().to_string() }),
    )
    .ok();
}

fn hex_to_bytes(text: &str) -> Vec<u8> {
    let bytes = text.trim().as_bytes();
    let mut out = Vec::with_capacity(bytes.len() / 2 + 1);
    let mut i = 0;
    while i + 1 < bytes.len() {
        let high = (bytes[i] as char).to_digit(16).unwrap_or(0);
        let low = (bytes[i + 1] as char).to_digit(16).unwrap_or(0);
        out.push(((high * 16 + low) & 0xff) as u8);
        i += 2;
    }
    out
}

fn open_dump_folder(app: &AppHandle) {
    let p = paths(app);
    std::fs::create_dir_all(&p.dump_files).ok();
    let _ = hidden_command("explorer.exe").arg(&p.dump_files).spawn();
}

fn list_dump_files(app: &AppHandle) -> Vec<String> {
    let p = paths(app);
    std::fs::read_dir(&p.dump_files)
        .ok()
        .map(|entries| {
            entries
                .filter_map(|entry| entry.ok())
                .map(|entry| entry.file_name())
                .filter(|name| name.to_string_lossy().ends_with(".mfd"))
                .map(|name| name.to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default()
}

fn update_dump_files(app: &AppHandle) {
    let files = list_dump_files(app);
    app.emit_to("dumpHistory", "update-dump-history", &files).ok();
}

fn dump_history(app: &AppHandle, state: &Mutex<AppState>) {
    let p = paths(app);
    let _ = std::fs::create_dir_all(&p.dump_files);
    let files = list_dump_files(app);
    windows::create_dump_history_window(app, state, files).ok();
}

fn delete_dump(app: &AppHandle, state: &Mutex<AppState>, arg: &Value) {
    let files: Vec<String> = arg
        .as_array()
        .map(|array| {
            array
                .iter()
                .filter_map(|value| value.as_str().map(|text| text.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let detail = files.join("\n");
    if !confirm_with_detail(
        app,
        state,
        "dialog_title_prompt",
        "dialog_msg_are_you_sure_to_delete_these_dumps",
        &detail,
    ) {
        return;
    }
    let p = paths(app);
    for file in files {
        if let Err(err) = std::fs::remove_file(p.dump_files.join(file)) {
            io_fail(app, state, err);
        }
    }
    update_dump_files(app);
}

fn rename_dump_file(app: &AppHandle, state: &Mutex<AppState>, arg: &Value) {
    let old_name = arg.get("oldName").and_then(|value| value.as_str()).unwrap_or_default();
    let new_name = arg.get("newName").and_then(|value| value.as_str()).unwrap_or_default();
    if old_name.is_empty() || new_name.is_empty() {
        return;
    }
    let p = paths(app);
    if let Err(err) = std::fs::rename(
        p.dump_files.join(old_name),
        p.dump_files.join(new_name),
    ) {
        io_fail(app, state, err);
        return;
    }
    update_dump_files(app);
}

fn save_log(app: &AppHandle, state: &Mutex<AppState>, arg: &Value) {
    let content = arg.as_str().unwrap_or_default();
    let default_name = format!("NFCTools_log_{}", now_stamp());
    let target = rfd::FileDialog::new()
        .set_title(t(state, "dialog_title_save_to"))
        .set_file_name(&default_name)
        .add_filter(t(state, "file_type_txt"), &["txt"])
        .save_file();
    match target {
        None => print_log(app, &t(state, "log_msg_not_saved")),
        Some(path) => match std::fs::write(&path, content) {
            Err(_) => {
                print_log(app, &t(state, "log_msh_save_failed"));
                log_exit(app, state, 1);
            }
            Ok(_) => {
                print_log(
                    app,
                    &format!(
                        "\n\n{} {}\n",
                        t(state, "log_msg_file_already_saved_to"),
                        path.display()
                    ),
                );
                exit_success(app, state);
            }
        },
    }
}

fn conn_usb_devices(app: &AppHandle, state: &Mutex<AppState>, tasks: &Mutex<TaskManager>, arg: &Value) {
    let device = arg.as_str().map(|text| text.to_string());
    if device.as_deref() == Some(" ") {
        state.lock().unwrap().current_device = None;
        app.emit("update-device-status", json!({ "state": "none" })).ok();
        return;
    }
    let Some(device) = device else {
        return;
    };
    print_status(app, state, &t(state, "indicator_connecting_device"));
    state.lock().unwrap().current_device = Some(device.clone());
    app.emit(
        "update-device-status",
        json!({ "state": "connecting", "device": device }),
    )
    .ok();
    set_nfc_config(app, state, tasks, &device)
}

fn set_speed(app: &AppHandle, state: &Mutex<AppState>, tasks: &Mutex<TaskManager>, arg: &Value) {
    let Some(speed) = arg.as_u64().map(|value| value as u32) else {
        return;
    };
    state.lock().unwrap().current_speed = speed;
    let device = state.lock().unwrap().current_device.clone();
    if let Some(device) = device {
        // 任务运行中跳过重连: 此时 set_nfc_config 会被"设备忙"拒绝并在主窗口提示连接失败
        if tasks.lock().unwrap().is_running() {
            return;
        }
        // 速度只写进状态不会生效, 必须重写 libnfc.conf 并重连
        set_nfc_config(app, state, tasks, &device);
    }
}

fn set_nfc_config(
    app: &AppHandle,
    state: &Mutex<AppState>,
    tasks: &Mutex<TaskManager>,
    device: &str,
) {
    app.emit("setting-nfc-config", "start").ok();
    let speed = state.lock().unwrap().current_speed;
    let dir = data_dir(app);
    let content = format!(
        "device.name = \"NFC_Device\"\ndevice.connstring = \"pn532_uart:{device}:{speed}\""
    );
    if std::fs::write(dir.join("libnfc.conf"), content).is_err() {
        state.lock().unwrap().device_connected = false;
        app.emit("setting-nfc-config", "failed").ok();
        app.emit(
            "update-device-status",
            json!({ "state": "failed", "device": device }),
        )
        .ok();
        return;
    }
    let mut found: Option<bool> = None;
    let msg = t(state, "log_msg_start_connect_device");
    // 无论任务被拒绝(设备忙)还是正常结束, 都要收尾, 否则渲染端的下拉框会一直禁用
    let finish = |connected: bool| {
        app.emit(
            "setting-nfc-config",
            if connected { "success" } else { "failed" },
        )
        .ok();
        app.emit(
            "update-device-status",
            json!({
                "state": if connected { "connected" } else { "failed" },
                "device": device
            }),
        )
        .ok();
    };
    let outcome = run_task(
        app,
        state,
        tasks,
        "nfc-list",
        &[],
        &msg,
        &mut |line| {
            if line.contains("NFC device: NFC_Device opened") {
                state.lock().unwrap().device_connected = true;
                found = Some(true);
                print_log(
                    app,
                    &format!("\n*** {} ***\n", t(state, "log_msg_discover_device")),
                );
            }
            if line.contains("Unable to open NFC device") {
                state.lock().unwrap().device_connected = false;
                found = Some(false);
                print_log(
                    app,
                    &format!("\n*** {} ***\n", t(state, "log_msg_not_found_device")),
                );
            }
        },
        &mut |_code| {},
    );
    let Ok(outcome) = outcome else {
        finish(false);
        return;
    };
    let connected = match found {
        Some(value) => value,
        None => state.lock().unwrap().device_connected,
    };
    finish(connected);
    if outcome == TaskOutcome::Success {
        exit_success(app, state);
    }
}

fn scan_usb_devices(app: &AppHandle) {
    let devices: Vec<String> = serialport::available_ports()
        .into_iter()
        .flatten()
        .map(|port| port.port_name)
        .collect();
    app.emit("update-usb-devices", &devices).ok();
}

fn done_input_keys_read_ic(
    app: &AppHandle,
    state: &Mutex<AppState>,
    tasks: &Mutex<TaskManager>,
    arg: &Value,
) {
    let text = arg.as_str().unwrap_or_default();
    let keys: Vec<String> = hex12_re().find_iter(text).map(|m| m.as_str().to_string()).collect();
    let mut args: Vec<String> = keys.iter().map(|key| format!("-k{key}")).collect();
    let p = paths(app);
    args.push(format!("-O{}", p.temp_mfd.display()));
    args.push(format!("-f{}", p.keys.display()));
    print_status(app, state, &t(state, "indicator_reading_ic_card"));
    mfoc(app, state, tasks, &args);
}

fn read_ic(app: &AppHandle, state: &Mutex<AppState>, tasks: &Mutex<TaskManager>) {
    print_status(app, state, &t(state, "indicator_reading_ic_card"));
    let p = paths(app);
    let args = vec![
        format!("-O{}", p.temp_mfd.display()),
        format!("-f{}", p.keys.display()),
    ];
    mfoc(app, state, tasks, &args);
}

fn run_action(app: AppHandle, action: &str, arg: &Value) {
    let state = app.state::<Mutex<AppState>>();
    let tasks = app.state::<Mutex<TaskManager>>();
    let state = state.inner();
    let tasks = tasks.inner();
    match action {
        "open-settings-window" => {
            windows::create_settings_window(&app, &state).ok();
        }
        "scan-usb-devices" => scan_usb_devices(&app),
        "conn-usb-devices" => conn_usb_devices(&app, &state, &tasks, &arg),
        "set-speed" => set_speed(&app, &state, &tasks, &arg),
        "read-IC" => read_ic(&app, &state, &tasks),
        "write-IC" => write_ic(&app, &state, &tasks, &arg),
        "format-card" => format_card(&app, &state, &tasks),
        "input-keys-read-IC" => {
            windows::create_input_keys_window(&app, &state).ok();
        }
        "done-input-keys-read-IC" => done_input_keys_read_ic(&app, &state, &tasks, &arg),
        "detect-card-type" => detect_card_type(&app, &state, &tasks),
        "write-ufuid-uid" => write_ufuid_uid(&app, &state, &tasks),
        "input-uid-write" => {
            windows::create_uid_input_window(&app, &state).ok();
        }
        "done-input-uid-write" => done_input_uid_write(&app, &state, &tasks, &arg),
        "lock-ufuid" => lock_ufuid(&app, &state, &tasks),
        "hard-nested" => hard_nested(&app, &state),
        "hard-nested-config-done" => hard_nested_config_done(&app, &state, &tasks, &arg),
        "run-hard-nested" => {
            if let Some(cfg) = hard_config_from(&arg) {
                let _ = run_hard_nested_once(&app, &state, &tasks, &cfg, true);
            }
        }
        "open-dict-file" => open_dict_file(&app, &state),
        "dict-test" => dict_test(&app, &state),
        "dict-test-config-done" => dict_test_config_done(&app, &state, &tasks, &arg),
        "open-history-keys" => open_history_keys(&app),
        "open-dump-editor" => open_dump_editor(&app, &state, &arg),
        "dump-editor-choose-file" => dump_editor_choose_file(&app, &state, &arg),
        "dump-editor-save" => dump_editor_save(&app, &state, &arg),
        "open-dump-comparator" => open_dump_comparator(&app, &state, &arg),
        "dump-comparator-choose-file" => {
            let dump_type = arg.get("type").and_then(|v| v.as_str()).unwrap_or("A");
            let path = arg.get("path").and_then(|v| v.as_str());
            let p = paths(&app);
            if path.is_none() {
                let dict_dir = state.lock().unwrap().dict_path.clone();
                let selected = rfd::FileDialog::new()
                    .set_title(t(&state, "dialog_title_choose_dump_file"))
                    .set_directory(&dict_dir)
                    .add_filter("Dump Files", &["mfd", "dump"])
                    .pick_file();
                match selected {
                    Some(selected) => {
                        let bytes = match std::fs::read(&selected) {
                            Ok(data) => data,
                            Err(_) => return,
                        };
                        let data = grouped_hex(&bytes, false);
                        app.emit_to(
                            "dumpComparator",
                            "binary-data",
                            &json!({ "url": selected.to_string_lossy().to_string(), "data": data, "type": dump_type }),
                        )
                        .ok();
                    }
                    None => return,
                }
            } else {
                let name = path.unwrap_or_default();
                let file = PathBuf::from(name);
                let path = if file.is_absolute() {
                    file
                } else {
                    p.dump_files.join(name)
                };
                let bytes = match std::fs::read(&path) {
                    Ok(data) => data,
                    Err(_) => return,
                };
                let data = grouped_hex(&bytes, false);
                app.emit_to(
                    "dumpComparator",
                    "binary-data",
                    &json!({ "url": path.to_string_lossy().to_string(), "data": data, "type": dump_type }),
                )
                .ok();
            }
        }
        "open-dump-folder" => open_dump_folder(&app),
        "dump-history" => dump_history(&app, &state),
        "delete-dump" => delete_dump(&app, &state, &arg),
        "rename-dump-file" => rename_dump_file(&app, &state, &arg),
        "cancel-task" => tasks.lock().unwrap().kill(),
        "save-log" => save_log(&app, &state, &arg),
        "open-about" => {
            windows::create_about_window(&app, &state).ok();
        }
        _ => {
            print_log(&app, &format!("\nunknown action: {action}"));
        }
    }
}

#[tauri::command]
pub fn exec_action(action: String, arg: Option<Value>, app: AppHandle) {
    let arg = arg.unwrap_or(Value::Null);
    std::thread::spawn(move || run_action(app, &action, &arg));
}

#[tauri::command]
pub fn get_app_version() -> String {
    env!("NFCTOOLSGUI_VERSION").to_string()
}

#[tauri::command]
pub fn get_builder() -> String {
    env!("NFCTOOLSGUI_BUILDER").to_string()
}

#[tauri::command]
pub fn open_link(url: String) -> Result<(), String> {
    // explorer.exe <path> 会直接执行该程序, 所以这里必须限定协议,
    // 否则等于给页面脚本一个"执行任意本地文件"的原语
    if !url.starts_with("https://") {
        return Err("unsupported url scheme".into());
    }
    hidden_command("explorer.exe")
        .arg(&url)
        .spawn()
        .map(|_child| {})
        .map_err(|err| err.to_string())
}
