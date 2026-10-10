//! IPC 命令(DESIGN.md §8.1)。

use std::path::PathBuf;

use serde_json::Value;
use tauri::{AppHandle, State};

use crate::error::{AppError, CmdResult};
use crate::process::{ListenEndpoint, Manager as RuntimeManager, StartCtx};
use crate::store::{read_json_or_default, write_json_atomic};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProfileFile {
    pub schema_version: u32,
    pub profiles: Vec<Value>,
}

impl Default for ProfileFile {
    fn default() -> Self {
        Self {
            schema_version: 1,
            profiles: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub language: String,
    pub theme: String,
    pub naive_binary_path: Option<String>,
    pub auto_start_app: bool,
    pub auto_connect_profile_id: Option<String>,
    pub minimize_to_tray: bool,
    pub set_system_proxy_on_connect: bool,
    pub sys_proxy_bypass: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            language: "zh-CN".into(),
            theme: "auto".into(),
            naive_binary_path: None,
            auto_start_app: false,
            auto_connect_profile_id: None,
            minimize_to_tray: true,
            set_system_proxy_on_connect: true,
            sys_proxy_bypass: "localhost;127.*;10.*;172.16.*-172.31.*;192.168.*;<local>".into(),
        }
    }
}

fn profiles_path(app: &AppHandle) -> PathBuf {
    crate::paths::data_root(app).join("profiles.json")
}
fn settings_path(app: &AppHandle) -> PathBuf {
    crate::paths::data_root(app).join("settings.json")
}

/* ── profiles ── */

#[tauri::command]
pub fn list_profiles(app: AppHandle) -> CmdResult<ProfileFile> {
    read_json_or_default(&profiles_path(&app))
}

/// 前端已校验/已渲染;Rust 只做 JSON 落盘(D3 边界)
#[tauri::command]
pub fn save_profile(app: AppHandle, profile: Value) -> CmdResult<()> {
    let mut file: ProfileFile = read_json_or_default(&profiles_path(&app))?;
    let id = profile
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::Bad("profile 缺少 id".into()))?;
    let mut updated = false;
    for p in file.profiles.iter_mut() {
        if p.get("id").and_then(|v| v.as_str()) == Some(id) {
            *p = profile.clone();
            updated = true;
            break;
        }
    }
    if !updated {
        file.profiles.push(profile);
    }
    write_json_atomic(&profiles_path(&app), &file)
}

#[tauri::command]
pub fn delete_profile(app: AppHandle, id: String) -> CmdResult<()> {
    let mut file: ProfileFile = read_json_or_default(&profiles_path(&app))?;
    let before = file.profiles.len();
    file.profiles
        .retain(|p| p.get("id").and_then(|v| v.as_str()) != Some(id.as_str()));
    if file.profiles.len() == before {
        return Err(AppError::NotFound(format!("profile {id}")));
    }
    write_json_atomic(&profiles_path(&app), &file)
}

#[tauri::command]
pub fn duplicate_profile(app: AppHandle, id: String) -> CmdResult<Value> {
    let mut file: ProfileFile = read_json_or_default(&profiles_path(&app))?;
    let src = file
        .profiles
        .iter()
        .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
        .cloned()
        .ok_or_else(|| AppError::NotFound(format!("profile {id}")))?;
    let mut dup = src;
    // 新 id + 名称后缀
    let new_id = uuid_v4();
    let name = dup
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("副本")
        .to_string();
    if let Some(obj) = dup.as_object_mut() {
        obj.insert("id".into(), Value::String(new_id.clone()));
        obj.insert("name".into(), Value::String(format!("{name} (副本)")));
        let now = Value::Number(serde_json::Number::from(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
        ));
        obj.insert("createdAt".into(), now.clone());
        obj.insert("updatedAt".into(), now);
    }
    file.profiles.push(dup.clone());
    write_json_atomic(&profiles_path(&app), &file)?;
    Ok(dup)
}

/// 按给定 id 顺序重排 profiles(拖拽排序持久化)
#[tauri::command]
pub fn reorder_profiles(app: AppHandle, ids: Vec<String>) -> CmdResult<()> {
    let mut file: ProfileFile = read_json_or_default(&profiles_path(&app))?;
    let mut reordered: Vec<Value> = Vec::with_capacity(ids.len());
    for id in &ids {
        if let Some(p) = file
            .profiles
            .iter()
            .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(id.as_str()))
        {
            reordered.push(p.clone());
        }
    }
    if reordered.len() != ids.len() {
        return Err(AppError::Bad(
            "排序 id 与磁盘 profiles 不一致(可能含未保存项)".into(),
        ));
    }
    file.profiles = reordered;
    write_json_atomic(&profiles_path(&app), &file)
}

fn uuid_v4() -> String {
    // 无 uuid 依赖:用随机数凑 16 字节(非加密用途,仅去重)
    use std::time::{SystemTime, UNIX_EPOCH};
    let mut bytes = [0u8; 16];
    let t = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    bytes[..8].copy_from_slice(&(t as u64).to_le_bytes());
    let t2 = std::process::id() as u64 + ((t >> 32) as u64);
    bytes[8..].copy_from_slice(&t2.to_le_bytes());
    // version 4 / variant 位
    bytes[7] = (bytes[7] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let h: Vec<String> = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        h[0..4].join(""),
        h[4..6].join(""),
        h[6..8].join(""),
        h[8..10].join(""),
        h[10..16].join("")
    )
}

/* ── runtime ── */

#[tauri::command]
pub async fn start_runtime(
    app: AppHandle,
    manager: State<'_, std::sync::Arc<RuntimeManager>>,
    profile_id: String,
    config_json: String,
    listen: Vec<ListenEndpoint>,
    auto_restart: bool,
) -> CmdResult<()> {
    let settings: AppSettings = read_json_or_default(&settings_path(&app))?;
    // 二进制解析:显式路径优先,否则程序同目录自动发现(§5.4,打包自带 naive.exe)
    let (binary, _) = crate::paths::resolve_naive_binary(&app, settings.naive_binary_path.as_deref())?;
    let data_dir = crate::paths::data_root(&app);
    let ctx = StartCtx {
        profile_id,
        config_json,
        config_dir: data_dir.join("runtime").join("current"),
        binary,
        listen,
        auto_restart,
    };
    manager.start(ctx).await
}

#[tauri::command]
pub async fn stop_runtime(manager: State<'_, std::sync::Arc<RuntimeManager>>) -> CmdResult<()> {
    manager.stop().await
}

#[tauri::command]
pub async fn runtime_status(
    manager: State<'_, std::sync::Arc<RuntimeManager>>,
) -> CmdResult<crate::process::RuntimeState> {
    Ok(manager.status().await)
}

/// 前端诊断轨迹:经 invoke(RPC,非事件)把时序写入 runtime/current/ui.log,
/// 与后端 state.log 对账,用于定位事件丢失/竞态。
#[tauri::command]
pub fn app_trace(app: AppHandle, line: String) -> CmdResult<()> {
    let dir = crate::paths::data_root(&app).join("runtime").join("current");
    std::fs::create_dir_all(&dir)?;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("ui.log"))?;
    use std::io::Write;
    writeln!(
        f,
        "{} {line}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0)
    )?;
    Ok(())
}

/* ── nettest ── */

#[tauri::command]
pub async fn test_connectivity(
    listen: Vec<ListenEndpoint>,
) -> CmdResult<crate::nettest::TestReport> {
    crate::nettest::run_test(listen).await
}

/* ── sysproxy ── */

#[tauri::command]
pub fn sysproxy_status() -> CmdResult<Value> {
    let sp = crate::sysproxy::get_sysproxy()?;
    Ok(serde_json::json!({
        "enable": sp.enable,
        "host": sp.host,
        "port": sp.port,
        "bypass": sp.bypass,
    }))
}

#[tauri::command]
pub async fn sysproxy_enable(app: AppHandle, port: u16, bypass: String) -> CmdResult<()> {
    crate::sysproxy::enable(&app, "127.0.0.1".into(), port, bypass).await
}

#[tauri::command]
pub async fn sysproxy_disable(app: AppHandle) -> CmdResult<()> {
    crate::sysproxy::disable(&app).await
}

/* ── settings / misc ── */

#[tauri::command]
pub fn get_settings(app: AppHandle) -> CmdResult<AppSettings> {
    read_json_or_default(&settings_path(&app))
}

#[tauri::command]
pub fn set_settings(app: AppHandle, settings: AppSettings) -> CmdResult<()> {
    write_json_atomic(&settings_path(&app), &settings)
}

/// 供窗口关闭事件同步读取「关闭到托盘」开关(避免在事件回调里再走异步 invoke)。
/// 读取失败时回退到默认值(true,与 AppSettings::default 一致)。
pub fn read_minimize_to_tray(app: &AppHandle) -> bool {
    read_json_or_default::<AppSettings>(&settings_path(app))
        .map(|s| s.minimize_to_tray)
        .unwrap_or(true)
}

/// naive --version 检测(§5.4)
#[tauri::command]
pub async fn detect_naive_binary(path: String) -> CmdResult<Value> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Ok(serde_json::json!({ "ok": false, "error": "文件不存在" }));
    }
    let mut cmd = tokio::process::Command::new(&p);
    cmd.arg("--version");
    #[cfg(windows)]
    {
        // tokio Command::creation_flags 是固有方法(Windows)
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| AppError::Spawn(e.to_string()))?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        return Ok(serde_json::json!({ "ok": false, "error": "无版本输出" }));
    }
    Ok(serde_json::json!({ "ok": true, "version": text }))
}

/// 返回当前生效的 naive 二进制(显式路径或程序同目录自动发现),
/// 供前端顶栏徽章/设置页展示;找不到不报错,返回 null。
#[tauri::command]
pub fn resolve_naive_binary(app: AppHandle) -> CmdResult<Value> {
    let settings: AppSettings = read_json_or_default(&settings_path(&app))?;
    match crate::paths::resolve_naive_binary(&app, settings.naive_binary_path.as_deref()) {
        Ok((p, src)) => Ok(serde_json::json!({
            "path": p.to_string_lossy(),
            "source": src,
        })),
        Err(_) => Ok(serde_json::json!({ "path": null, "source": null })),
    }
}

#[tauri::command]
pub fn open_path(path: String) -> CmdResult<()> {
    // opener 插件做实际打开;这里仅转发(白名单:runtime 目录)
    if !path.contains("runtime") && !path.ends_with(".log") && !path.ends_with(".json") {
        return Err(AppError::Bad(
            "仅允许打开 runtime 目录与日志/配置文件".into(),
        ));
    }
    Ok(())
}

/// 生效数据目录(§6.4):portable = 便携模式(<程序目录>/data)
#[tauri::command]
pub fn get_app_dir(app: AppHandle) -> CmdResult<Value> {
    let (root, portable) = crate::paths::data_root_with_mode(&app);
    Ok(serde_json::json!({
        "path": root.to_string_lossy(),
        "portable": portable,
    }))
}
