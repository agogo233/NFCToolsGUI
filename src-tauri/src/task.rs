use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;

use tauri::Emitter;

pub struct TaskManager {
    running: bool,
    child: Option<Arc<Mutex<Option<Child>>>>,
    pub killed: AtomicBool,
}

impl Default for TaskManager {
    fn default() -> Self {
        Self {
            running: false,
            child: None,
            killed: AtomicBool::new(false),
        }
    }
}

impl TaskManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_running(&self) -> bool {
        self.running
    }

    pub fn claim(&mut self) -> bool {
        if self.running {
            return false;
        }
        self.running = true;
        true
    }

    pub fn release(&mut self) {
        self.running = false;
    }

    pub fn spawn(
        &mut self,
        app: &tauri::AppHandle,
        bin_dir: &Path,
        cmd: &str,
        args: &[String],
        data_dir: &Path,
    ) -> std::io::Result<mpsc::Receiver<String>> {
        self.killed.store(false, Ordering::SeqCst);
        let program = bin_dir.join(format!("{}.exe", cmd));
        let mut command = Command::new(&program);
        command.args(args);
        command.env("LIBNFC_SYSCONFDIR", data_dir);
        command.current_dir(bin_dir);
        command.stdout(Stdio::piped());
        command.stderr(Stdio::piped());
        let mut child = command.spawn()?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "stdout unavailable"))?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "stderr unavailable"))?;
        let (tx, rx) = mpsc::channel::<String>();
        let log_tx = tx.clone();
        thread::spawn(move || Self::pump_lines(stdout, app.clone(), log_tx));
        thread::spawn(move || Self::pump_lines(stderr, app.clone(), tx));
        self.child = Some(Arc::new(Mutex::new(Some(child))));
        Ok(rx)
    }

    fn pump_lines(stream: impl std::io::Read + Send, handle: tauri::AppHandle, tx: mpsc::Sender<String>) {
        let reader = BufReader::new(stream);
        for line in reader.lines() {
            let Ok(text) = line else {
                break;
            };
            let text = text.trim_end_matches('\r');
            if handle.emit("update-log-output", format!("{text}\n")).is_err() {
                break;
            }
            if tx.send(text.to_string()).is_err() {
                break;
            }
        }
    }

    pub fn kill(&self) {
        if let Some(child) = &self.child {
            if let Some(child) = child.lock().unwrap().as_mut() {
                child.kill().ok();
            }
        }
        self.killed.store(true, Ordering::SeqCst);
    }

    pub fn take_child(&mut self) -> Option<Arc<Mutex<Option<Child>>>> {
        self.child.take()
    }
}
