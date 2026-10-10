//! 持久化存储(DESIGN.md §6):原子写 + 损坏自愈。
//! profiles.json / settings.json / sysproxy.snapshot.json 都走这里。

use std::fs;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::Serialize;

use crate::error::{AppError, CmdResult};

/// 原子写:临时文件 + rename(§6.2)
pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> CmdResult<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    let data = serde_json::to_string_pretty(value)?;
    fs::write(&tmp, data.as_bytes())?;
    // Windows rename 目标存在时需先移除
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(&tmp, path)?;
    Ok(())
}

/// 读 JSON;损坏时把原文件备份为 *.corrupt-<ts> 并返回 Err(调用方决定重建)
pub fn read_json<T: DeserializeOwned>(path: &Path) -> CmdResult<T> {
    let data = fs::read_to_string(path).map_err(AppError::Io)?;
    match serde_json::from_str(&data) {
        Ok(v) => Ok(v),
        Err(e) => {
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let backup = PathBuf::from(format!("{}.corrupt-{}", path.display(), ts));
            let _ = fs::rename(path, &backup);
            Err(AppError::Bad(format!(
                "配置文件损坏,已备份到 {}:{e}",
                backup.display()
            )))
        }
    }
}

/// 读 JSON;不存在返回默认值
pub fn read_json_or_default<T: DeserializeOwned + Default>(path: &Path) -> CmdResult<T> {
    if !path.exists() {
        return Ok(T::default());
    }
    read_json(path)
}
