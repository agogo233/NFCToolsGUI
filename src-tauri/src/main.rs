#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod i18n;
mod state;
mod task;
mod windows;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{Manager, RunEvent, WindowEvent};

use crate::state::AppState;
use crate::task::TaskManager;

static CLOSE_PROMPT_OPEN: AtomicBool = AtomicBool::new(false);

fn main() {
    tauri::Builder::default()
        .manage(Mutex::new(AppState::new()))
        .manage(Mutex::new(TaskManager::new()))
        .setup(|app| {
            let handle = app.handle().clone();
            let state = app.state::<Mutex<AppState>>();
            let state = state.inner();
            {
                let mut guard = state.lock().unwrap();
                guard.lang = i18n::detect_lang();
                guard.dict_path = commands::dict_path();
            }
            commands::data_dir(&handle);
            windows::create_main_window(&handle, state)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::exec_action,
            commands::get_app_version,
            commands::get_builder,
            commands::open_link,
        ])
        .on_window_event(|window, event| {
            if !matches!(event, WindowEvent::CloseRequested { .. }) {
                return;
            }
            if window.label() != "main" {
                return;
            }
            let busy = {
                let tasks = window.state::<Mutex<TaskManager>>();
                tasks.inner().lock().unwrap().is_running()
            };
            if !busy {
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
            }
            if CLOSE_PROMPT_OPEN.swap(true, Ordering::SeqCst) {
                return;
            }
            let window = window.clone();
            let (title, message) = {
                let state = window.state::<Mutex<AppState>>();
                let state = state.inner();
                (
                    i18n::t(state, "dialog_title_prompt"),
                    i18n::t(state, "dialog_msg_are_you_sure_to_exit"),
                )
            };
            std::thread::spawn(move || {
                let still_exit = rfd::MessageDialog::new()
                    .set_title(title)
                    .set_description(message)
                    .set_buttons(rfd::MessageButtons::YesNo)
                    .set_level(rfd::MessageLevel::Warning)
                    .show()
                    == rfd::MessageDialogResult::Yes;
                if still_exit {
                    {
                        let tasks = window.state::<Mutex<TaskManager>>();
                        tasks.inner().lock().unwrap().kill();
                    }
                    window.destroy().ok();
                }
                CLOSE_PROMPT_OPEN.store(false, Ordering::SeqCst);
            });
        })
        .build(tauri::generate_context!())
        .expect("failed to build NFCToolsGUI")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                if let Some(tasks) = app.try_state::<Mutex<TaskManager>>() {
                    tasks.inner().lock().unwrap().kill();
                }
            }
        });
}
