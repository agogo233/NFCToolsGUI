use std::path::PathBuf;

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
}

impl AppState {
    pub fn new() -> Self {
        Self {
            current_speed: 115200,
            lang: "en".to_string(),
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
