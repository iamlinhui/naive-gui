//! 路径解析:便携数据目录 + naive 二进制自动发现(DESIGN.md §6.4 / §5.4)。
//!
//! 便携模式:程序同目录存在 `portable` 标记文件时,数据目录随之移动,
//! 于是「整个文件夹拷到哪,配置就跟到哪」。标记随打包分发(bundle.resources),
//! 因此打包版默认便携;开发模式(cargo run,target 目录无标记)继续用系统数据目录。
//! 若程序目录不可写(如装进 Program Files / 挂在只读 DMG),自动退回系统目录,数据不丢。
//!
//! 平台差异:
//! - Windows/Linux:标记与数据都在 exe 同目录(<exe>/data);
//! - macOS:标记在 .app 内(Contents/Resources,resources 落点),数据放
//!   <NaiveGUI.app 同级>/data —— 保证 DMG 只读挂载时自动回退,而「文件夹便携」
//!   语义仍成立:整个文件夹(含 .app 与 data)拷到哪都可用。

use std::path::PathBuf;

use tauri::Manager;

use crate::error::{AppError, CmdResult};

/// 程序自身目录(Windows 上 resource_dir 也解析到这里,docs.rs PathResolver)
fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

/// 便携标记可能存在的目录:exe 目录 + 资源目录(macOS 资源在 .app/Contents/Resources)
fn marker_dirs(app: &tauri::AppHandle) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(d) = exe_dir() {
        dirs.push(d);
    }
    if let Ok(d) = app.path().resource_dir() {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    dirs
}

/// 同目录(或 macOS 的 .app 资源目录)是否存在便携标记
pub fn portable_mode(app: &tauri::AppHandle) -> bool {
    marker_dirs(app).iter().any(|d| d.join("portable").exists())
}

/// 便携数据根:Windows/Linux = <exe>/data;macOS = <NaiveGUI.app 同级>/data。
/// 能创建(可写)才算数,否则调用方退回系统目录。
#[cfg(not(target_os = "macos"))]
fn portable_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    if !portable_mode(app) {
        return None;
    }
    let root = exe_dir()?.join("data");
    std::fs::create_dir_all(&root).ok()?;
    Some(root)
}

#[cfg(target_os = "macos")]
fn portable_root(app: &tauri::AppHandle) -> Option<PathBuf> {
    if !portable_mode(app) {
        return None;
    }
    // exe 位于 NaiveGUI.app/Contents/MacOS/:数据放 .app 同级的 data/,
    // 与「文件夹便携」语义一致(拷走整个文件夹 = .app + data)
    let app_bundle = exe_dir()?.parent()?.parent()?; // -> NaiveGUI.app
    let root = app_bundle.parent()?.join("data"); // -> <文件夹>/data
    std::fs::create_dir_all(&root).ok()?;
    Some(root)
}

/// 生效数据根 + 是否真的落在便携目录
pub fn data_root_with_mode(app: &tauri::AppHandle) -> (PathBuf, bool) {
    if let Some(root) = portable_root(app) {
        return (root, true);
    }
    (app.path().app_data_dir().expect("app data dir"), false)
}

pub fn data_root(app: &tauri::AppHandle) -> PathBuf {
    data_root_with_mode(app).0
}

/// 一次性迁移:切换/首次进入便携模式时,把系统目录里既有的配置拷进便携数据根。
/// 只补不覆盖(目标已存在即跳过),用户在两种模式间来回也不会丢数据。
pub fn maybe_migrate_from_appdata(app: &tauri::AppHandle) {
    let Some(root) = portable_root(app) else {
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

/// 内核候选文件名:打包资源统一叫 naive.exe(跨平台单一资源名,见 tauri.conf.json);
/// 非 Windows 额外探测裸名 `naive`,兼容手工放置的内核。
fn naive_bin_candidates() -> Vec<&'static str> {
    #[cfg(windows)]
    {
        vec!["naive.exe"]
    }
    #[cfg(not(windows))]
    {
        vec!["naive.exe", "naive"]
    }
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NaiveBinSource {
    /// 设置里显式指定的路径
    Explicit,
    /// 程序目录/资源目录自动发现(bundle.resources 打包的那个)
    Bundled,
}

/// naive 二进制解析顺序(§5.4):
/// 1. 设置里显式指定的路径(存在即用);
/// 2. exe 目录 / resource 目录(打包自带,Windows 为安装目录,macOS 为 .app/Contents/Resources);
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
    for dir in marker_dirs(app) {
        for name in naive_bin_candidates() {
            candidates.push(dir.join(name));
        }
    }
    candidates.dedup();
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
        "未找到 naive 内核:请把 naive[.exe] 放到程序目录,或在设置中指定路径(已尝试:{tried})"
    )))
}
