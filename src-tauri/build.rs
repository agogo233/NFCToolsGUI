use std::process::Command;

fn main() {
    tauri_build::build();

    let version = std::fs::read_to_string("../package.json")
        .ok()
        .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
        .and_then(|value| value.get("version").and_then(|v| v.as_str()).map(|s| s.to_string()))
        .unwrap_or_else(|| "1.0.0".to_string());

    let hash = Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let builder = std::env::var("NFCTOOLSGUI_COMPILER")
        .or_else(|_| std::env::var("USERNAME"))
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "dev".to_string());

    println!("cargo:rustc-env=NFCTOOLSGUI_VERSION=v{}-{}", version, hash);
    println!("cargo:rustc-env=NFCTOOLSGUI_BUILDER={}", builder);
    println!("cargo:rerun-if-changed=../package.json");
    println!("cargo:rerun-if-changed=../.git/HEAD");
    if let Ok(head) = std::fs::read_to_string("../.git/HEAD") {
        if let Some(reference) = head.trim().strip_prefix("ref: ") {
            println!("cargo:rerun-if-changed=../.git/{}", reference);
        }
    }
}
