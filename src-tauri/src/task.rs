use std::io::{BufReader, Read};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::str::from_utf8;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;

use tauri::Emitter;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn hidden_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

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
        let mut command = hidden_command(&program);
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
        let app = app.clone();
        let stderr_app = app.clone();
        thread::spawn(move || Self::pump_lines(stdout, app, log_tx));
        thread::spawn(move || Self::pump_lines(stderr, stderr_app, tx));
        self.child = Some(Arc::new(Mutex::new(Some(child))));
        Ok(rx)
    }

    // 工具输出的进度行不带换行, 而是用转义序列反复覆盖同一行, 所以"一行"能无限变长;
    // 某次输出永不换行时 (卡死、崩溃前的残留) 就会无限吃内存。按小块读入, 单行超过
    // 上限时丢弃最旧的内容: 那些覆盖都被后续的进度盖掉了, 丢了对显示没有影响。
    // 仍然攒到换行才发给渲染层, 与 BufRead::lines 的语义一致。
    const READ_BUF_BYTES: usize = 4096;
    const KEEP_LINE_BYTES: usize = 64 * 1024;

    fn pump_lines(stream: impl Read + Send, handle: tauri::AppHandle, tx: mpsc::Sender<String>) {
        let mut reader = BufReader::new(stream);
        let mut buf = [0u8; Self::READ_BUF_BYTES];
        let mut line: Vec<u8> = Vec::new();
        loop {
            let bytes = match reader.read(&mut buf) {
                Ok(bytes) if bytes > 0 => bytes,
                _ => break,
            };
            for byte in &buf[..bytes] {
                if byte != &b'\n' {
                    line.push(*byte);
                    continue
                }
                if !Self::emit(&handle, &tx, &line) {
                    return
                }
                line.clear();
            }
            if line.len() > Self::KEEP_LINE_BYTES {
                Self::trim_head(&mut line);
            }
        }
        // 输出结束时最后一行可能没有换行, BufRead::lines 也会把它吐出来, 这里保持一致。
        if !line.is_empty() {
            let _ = Self::emit(&handle, &tx, &line);
        }
    }

    fn trim_head(line: &mut Vec<u8>) {
        // 切点跳到字符边界, 否则会在多字节字符中间断开, 留下半个字符。
        let from = (Self::KEEP_LINE_BYTES / 2).min(line.len());
        let mut at = from;
        while at < line.len() && (line[at] & 0xc0) == 0x80 {
            at += 1
        }
        line.drain(..at);
    }

    fn emit(handle: &tauri::AppHandle, tx: &mpsc::Sender<String>, line: &[u8]) -> bool {
        // 正常情况 line 是合法的 UTF-8; 工具输出脏字节时只截断到合法前缀, 不丢弃整行。
        let valid = match from_utf8(line) {
            Ok(_) => line.len(),
            Err(err) => err.valid_up_to(),
        };
        let text = from_utf8(&line[..valid]).unwrap_or("").trim_end_matches('\r');
        if handle.emit("update-log-output", format!("{text}\n")).is_err() {
            return false
        }
        tx.send(text.to_string()).is_ok()
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
