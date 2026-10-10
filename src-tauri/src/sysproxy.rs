//! 系统代理集成(DESIGN.md §10):sysproxy crate + 快照/还原/自愈。
//!
//! - 仅用 http 监听端点作系统代理(§10.1);
//! - enable 前快照,disable / 退出 / 自愈时还原(§10.4);
//! - 自愈:启动时发现"代理指向本机端口但无 naive 进程存活" → 自动还原。

use std::path::PathBuf;

use sysproxy::Sysproxy;

use crate::error::{AppError, CmdResult};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Snapshot {
    /// enable 前的原始 sysproxy 状态(全部字段)
    pub was_enable: bool,
    pub was_server: String,
    pub was_bypass: String,
    /// 标记:当前快照是否由本进程创建(用于他杀自愈)
    pub by_this_app: bool,
    pub pid: u32,
    pub at: u64,
}

fn snapshot_path(app: &tauri::AppHandle) -> PathBuf {
    crate::paths::data_root(app).join("sysproxy.snapshot.json")
}

pub fn get_sysproxy() -> CmdResult<Sysproxy> {
    Sysproxy::get_system_proxy().map_err(|e| AppError::SysProxy(e.to_string()))
}

pub async fn enable(
    app: &tauri::AppHandle,
    host: String,
    port: u16,
    bypass: String,
) -> CmdResult<()> {
    let sp = get_sysproxy()?;
    // 快照(仅当尚无本 App 快照时;防止重复 enable 覆盖真正原始状态)
    let snap_file = snapshot_path(app);
    if !snap_file.exists() {
        let snap = Snapshot {
            was_enable: sp.enable,
            was_server: format!("{}:{}", sp.host, sp.port),
            was_bypass: sp.bypass.clone(),
            by_this_app: true,
            pid: std::process::id(),
            at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0),
        };
        crate::store::write_json_atomic(&snap_file, &snap)?;
    }

    let mut new = sp.clone();
    new.enable = true;
    new.host = host;
    new.port = port;
    new.bypass = bypass;
    tokio::task::spawn_blocking(move || new.set_system_proxy())
        .await
        .map_err(|e| AppError::SysProxy(e.to_string()))?
        .map_err(|e| AppError::SysProxy(e.to_string()))
}

pub async fn disable(app: &tauri::AppHandle) -> CmdResult<()> {
    let snap_file = snapshot_path(app);
    if snap_file.exists() {
        let snap: Snapshot = crate::store::read_json(&snap_file)?;
        let mut sp = get_sysproxy()?;
        sp.enable = snap.was_enable;
        // server 可能是 host:port 串
        let mut parts = snap.was_server.rsplitn(2, ':');
        let port = parts
            .next()
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(80);
        let host = parts.next().unwrap_or("127.0.0.1").to_string();
        if snap.was_server.is_empty() {
            sp.host = "127.0.0.1".into();
            sp.port = 80;
        } else {
            sp.host = host;
            sp.port = port;
        }
        sp.bypass = snap.was_bypass;
        let _ = tokio::task::spawn_blocking(move || sp.set_system_proxy()).await;
        let _ = std::fs::remove_file(&snap_file);
    }
    Ok(())
}

/// 启动自愈(§7.4/§10.4):快照存在但本 App 未运行代理 → 还原
pub async fn heal_orphan_snapshot(app: &tauri::AppHandle, running: bool) -> CmdResult<bool> {
    let snap_file = snapshot_path(app);
    if !snap_file.exists() {
        return Ok(false);
    }
    let snap: Snapshot = match crate::store::read_json(&snap_file) {
        Ok(s) => s,
        Err(_) => {
            let _ = std::fs::remove_file(&snap_file);
            return Ok(false);
        }
    };
    // 快照 PID 是本进程 → 正常持有着;否则视为残留
    let orphan = snap.pid != std::process::id() && !running;
    if orphan {
        let sp = get_sysproxy().ok();
        if let Some(sp) = sp {
            // 代理确实指向本机 → 还原
            let points_local = sp.host == "127.0.0.1" || sp.host == "localhost" || sp.host == "::1";
            if points_local && sp.enable {
                disable(app).await?;
                return Ok(true);
            }
        }
        let _ = std::fs::remove_file(&snap_file);
    }
    Ok(false)
}

/// 供退出清理调用
pub async fn cleanup_on_exit(app: &tauri::AppHandle) {
    let _ = disable(app).await;
}
