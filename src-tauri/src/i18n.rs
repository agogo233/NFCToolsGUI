use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use crate::state::AppState;

pub const EN: &str = include_str!("../../src/locales/en.json");
pub const ZH: &str = include_str!("../../src/locales/zh-CN.json");

fn parse_locale(text: &str) -> serde_json::Map<String, serde_json::Value> {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

static LOCALES: OnceLock<HashMap<String, serde_json::Map<String, serde_json::Value>>> =
    OnceLock::new();

fn locale_map(lang: &str) -> &serde_json::Map<String, serde_json::Value> {
    let all = LOCALES.get_or_init(|| {
        let mut map = HashMap::new();
        map.insert("en".to_string(), parse_locale(EN));
        map.insert("zh-CN".to_string(), parse_locale(ZH));
        map
    });
    all.get(lang).unwrap_or_else(|| all.get("en").unwrap())
}

pub fn t(state: &Mutex<AppState>, key: &str) -> String {
    let lang = state.lock().unwrap().lang.clone();
    locale_map(&lang)
        .get(key)
        .and_then(|value| value.as_str())
        .unwrap_or(key)
        .to_string()
}

pub fn locale_json(lang: &str) -> &'static str {
    if lang == "zh-CN" {
        ZH
    } else {
        EN
    }
}

pub fn detect_lang() -> String {
    let locale = sys_locale::get_locale()
        .map(|value| value.replace('_', "-"))
        .unwrap_or_else(|| "en".to_string());
    if locale == "zh-CN" {
        "zh-CN".to_string()
    } else {
        "en".to_string()
    }
}
