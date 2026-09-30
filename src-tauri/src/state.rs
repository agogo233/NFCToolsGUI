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
    pub key_index: i64,
    pub dict_path: PathBuf,
    pub lang: String,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            current_speed: 115200,
            lang: "en".to_string(),
            ..Default::default()
        }
    }

    pub fn reset_key_info(&mut self) {
        self.new_keys.clear();
        self.known_key_info.clear();
        self.unknown_key_info.clear();
        self.key_index = 0;
    }
}
