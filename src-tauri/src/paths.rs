//! 路径解析:便携数据目录 + naive 二进制自动发现(DESIGN.md §6.4 / §5.4)。
//!
//! 便携模式:程序同目录存在 `portable` 标记文件时,数据目录 = `<程序目录>/data`,
//! 于是「整个文件夹拷到哪,配置就跟到哪」。标记随打包分发(bundle.resources),
//! 因此打包版默认便携;开发模式(cargo run,target/debug 无标记)继续用 %APPDATA%。
//! 若程序目录不可写(如装进 Program Files),自动退回系统目录,保证数据不丢。

use std::path::PathBuf;

use tauri::Manager;

use crate::error::{AppError, CmdResult};

/// 程序自身目录(Windows 上 resource_dir 也解析到这里,docs.rs PathResolver)
fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

/// 同目录是否存在便携标记
pub fn portable_mode() -> bool {
    exe_dir()
        .map(|d| d.join("portable").exists())
        .unwrap_or(false)
}

/// 便携数据根:`<exe>/data`,能创建(可写)才算数
fn portable_root() -> Option<PathBuf> {
    if !portable_mode() {
        return None;
    }
    let dir = exe_dir()?;
    let root = dir.join("data");
    std::fs::create_dir_all(&root).ok()?;
    Some(root)
}

/// 生效数据根 + 是否真的落在便携目录
pub fn data_root_with_mode(app: &tauri::AppHandle) -> (PathBuf, bool) {
    if let Some(root) = portable_root() {
        return (root, true);
    }
    (
        app.path().app_data_dir().expect("app data dir"),
        false,
    )
}

pub fn data_root(app: &tauri::AppHandle) -> PathBuf {
    data_root_with_mode(app).0
}

/// 一次性迁移:切换/首次进入便携模式时,把系统目录里既有的配置拷进 `<exe>/data`。
/// 只补不覆盖(目标已存在即跳过),用户在两种模式间来回也不会丢数据。
pub fn maybe_migrate_from_appdata(app: &tauri::AppHandle) {
    let Some(root) = portable_root() else {
        return;
    };
    let Ok(src) = app.path().app_data_dir() else {
        return;
    };
    for name in ["profiles.json", "settings.json", "sysproxy.snapshot.json"] {
        let to = root.join(name);
        let from = src.join(name);
        if !to.exists() && from.exists() {
            let _ = std::fs::copy(&from, &to);
        }
    }
}

#[cfg(windows)]
fn naive_bin_name() -> &'static str {
    "naive.exe"
}
#[cfg(not(windows))]
fn naive_bin_name() -> &'static str {
    "naive"
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NaiveBinSource {
    /// 设置里显式指定的路径
    Explicit,
    /// 程序同目录自动发现(bundle.resources 打包的那个)
    Bundled,
}

/// naive 二进制解析顺序(§5.4):
/// 1. 设置里显式指定的路径(存在即用);
/// 2. 程序同目录 / resource 目录的 naive[.exe](打包自带);
/// 都找不到 → 报错并列出尝试过的位置,指引用户放文件或去设置页。
pub fn resolve_naive_binary(
    app: &tauri::AppHandle,
    explicit: Option<&str>,
) -> CmdResult<(PathBuf, NaiveBinSource)> {
    if let Some(p) = explicit.map(str::trim).filter(|s| !s.is_empty()) {
        let pb = PathBuf::from(p);
        if pb.exists() {
            return Ok((pb, NaiveBinSource::Explicit));
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(dir) = exe_dir() {
        candidates.push(dir.join(naive_bin_name()));
    }
    if let Ok(rd) = app.path().resource_dir() {
        let p = rd.join(naive_bin_name());
        if !candidates.iter().any(|c| c == &p) {
            candidates.push(p);
        }
    }
    for c in &candidates {
        if c.exists() {
            return Ok((c.clone(), NaiveBinSource::Bundled));
        }
    }
    let tried = candidates
        .iter()
        .map(|c| c.display().to_string())
        .collect::<Vec<_>>()
        .join("、");
    Err(AppError::Bad(format!(
        "未找到 naive 二进制:请把 naive.exe 放到程序目录,或在设置中指定路径(已尝试:{tried})"
    )))
}
