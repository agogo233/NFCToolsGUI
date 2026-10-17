use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

/// 取锁但不因毒化而失败。
///
/// std::sync::Mutex 没有清除毒化的公共 API: 持有者一旦 panic, 锁就永久毒化,
/// 而毒化只体现在 lock() 的返回值上。这里若用 unwrap, 此后每个操作都会在加锁处
/// 连环 panic, 整个应用表现为"点了没反应"。毒化只说明上次的持有者异常退出过,
/// 数据本身仍可用, 所以取锁失败时继续拿守卫。
pub fn lock<'a, T>(mutex: &'a Mutex<T>) -> MutexGuard<'a, T> {
    mutex.lock().unwrap_or_else(|err| err.into_inner())
}

#[derive(Default)]
pub struct AppState {
    pub device_connected: bool,
    pub current_device: Option<String>,
    pub current_speed: u32,
    pub new_keys: Vec<String>,
    pub known_key_info: Vec<(String, i64, String)>,
    pub unknown_key_info: Vec<(i64, String)>,
    pub total_unknown_keys: i64,
    pub key_sector: Option<i64>,
    pub recover_sector: Option<i64>,
    pub dict_path: PathBuf,
    pub lang: String,
    pub phw_block0: Option<String>,
    pub theme: String,
    /// 扫描到恰好一个已知桥接芯片的串口时自动连接。
    /// 列表里有多个或零个匹配时保持手动选择 —— 直接取列表第一项会连到蓝牙虚拟串口之类的无关设备。
    pub auto_select_device: bool,
    /// 解卡结果直接落盘, 不弹保存对话框
    pub silent_save_dump: bool,
    /// 启用复杂卡求解 (mfcuk Darkside), 默认关闭; 求解器随构建附带, 缺失时按钮功能自动降级
    pub full_enc_enabled: bool,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            current_speed: 115200,
            lang: "en".to_string(),
            theme: "system".to_string(),
            auto_select_device: false,
            silent_save_dump: false,
            full_enc_enabled: false,
            ..Default::default()
        }
    }

    pub fn reset_task_state(&mut self) {
        self.new_keys.clear();
        self.known_key_info.clear();
        self.unknown_key_info.clear();
        self.total_unknown_keys = 0;
        self.key_sector = None;
        self.recover_sector = None;
    }
}
