//! 进程管理器(DESIGN.md §7):spawn / FSM / ready 检测 / 崩溃退避。
//!
//! 契约要点:
//! - 配置只经文件路径传递,密码不进命令行(D8);
//! - stderr 逐行读取,`Listening on <proto>://<addr>:<port>` = ready(naive_proxy_bin.cc:549);
//! - ready 兜底:10s 超时后主动 TCP 探测 listen 端口(§7.3);
//! - 崩溃退避 2/4/8/16/32s,存活 >60s 清零(§7.5);
//! - v1 单 Profile 运行(D4):内部状态,公开 API 一次一条。
//!
//! 所有权结构:Child 由 exit-watcher 任务持有;stop 经 oneshot 通道通知;
//! 重启由 exit-watcher 直接调 spawn_runtime(共享 app + inner)。

use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;

use crate::error::{AppError, CmdResult};

const READY_TIMEOUT: Duration = Duration::from_secs(10);
const STABLE_UPTIME: Duration = Duration::from_secs(60);
const MAX_RESTARTS: u32 = 5;
const BACKOFF: [Duration; 5] = [
    Duration::from_secs(2),
    Duration::from_secs(4),
    Duration::from_secs(8),
    Duration::from_secs(16),
    Duration::from_secs(32),
];

#[derive(Debug, Clone, serde::Serialize)]
// rename_all 管「变体名」(Starting→starting),rename_all_fields 管「字段名」
// (profile_id→profileId)。两者必须同时存在:只写 rename_all_fields 会让变体
// 序列化成 PascalCase("Running"),前端 switch 的小写 case 全部匹配不上,
// 状态事件被静默吞掉 → UI 永远卡「处理中」/「启动超时」。
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RuntimeState {
    Idle,
    Starting {
        profile_id: String,
    },
    Running {
        profile_id: String,
    },
    Stopping {
        profile_id: String,
    },
    Stopped {
        profile_id: String,
        reason: StopReason,
        exit_code: Option<i32>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StopReason {
    User,
    Crash,
    FailedToStart,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEvent {
    pub profile_id: String,
    pub ts: u64,
    pub line: String,
}

#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct ListenEndpoint {
    pub proto: String,
    pub addr: String,
    pub port: u16,
}

/// 一次运行所需的全部上下文(重启复用)
#[derive(Debug, Clone)]
pub struct StartCtx {
    pub profile_id: String,
    pub config_json: String,
    pub config_dir: PathBuf,
    pub binary: PathBuf,
    pub listen: Vec<ListenEndpoint>,
    pub auto_restart: bool,
}

/// spawn 前预检:listen 端口已占用 → 立即报错,不让进程起又崩(§7.1)。
/// 报错带上被占端口,前端可直接提示「端口 1080 已被占用」。
/// SO_REUSEADDR 平台差异不适用 Windows(tcp_socket_win 直接 bind 失败)。
async fn preflight_ports(listen: &[ListenEndpoint]) -> CmdResult<()> {
    for l in listen {
        let sock = tokio::net::TcpListener::bind((local_addr(&l.addr).as_str(), l.port)).await;
        if sock.is_err() {
            return Err(AppError::Bad(format!(
                "本地监听端口 {}:{} 已被占用,请更换端口或关闭占用程序",
                l.addr, l.port
            )));
        }
        // 立即 drop 释放探测用绑定;竞态窗口极小,naive bind 失败仍会被日志捕获
    }
    Ok(())
}

pub struct Manager {
    pub app: tauri::AppHandle,
    pub inner: Arc<Mutex<Inner>>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            profile_id: None,
            state: RuntimeState::Idle,
            ready: false,
            started_at: None,
            restarts: 0,
            stopping: false,
            stop_tx: None,
        }
    }
}

pub struct Inner {
    pub profile_id: Option<String>,
    pub state: RuntimeState,
    pub ready: bool,
    pub started_at: Option<Instant>,
    pub restarts: u32,
    pub stopping: bool,
    pub stop_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

fn now_ts() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// emit 状态事件,并追加一行 JSON 到 runtime/current/state.log,
/// 用于事后与前端 ui.log 对账,判定事件是否真的离开后端。
fn emit_state(app: &tauri::AppHandle, state: &RuntimeState) {
    use tauri::Emitter;
    let line = serde_json::to_string(state).unwrap_or_default();
    let p = crate::paths::data_root(app)
        .join("runtime")
        .join("current")
        .join("state.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&p)
    {
        use std::io::Write;
        let _ = writeln!(f, "{} {line}", now_ts());
    }
    let _ = app.emit("runtime:state", state);
    // 同步刷新托盘图标/菜单(UI_SPEC §8.1):窗口隐藏到托盘后,托盘是唯一状态指示器
    crate::tray::refresh(app, matches!(state, RuntimeState::Running { .. }));
}

fn emit_log(app: &tauri::AppHandle, profile_id: &str, line: &str) {
    use tauri::Emitter;
    let _ = app.emit(
        "runtime:log",
        LogEvent {
            profile_id: profile_id.to_string(),
            ts: now_ts(),
            line: line.to_string(),
        },
    );
}

fn local_addr(addr: &str) -> String {
    match addr {
        "0.0.0.0" => Ipv4Addr::LOCALHOST.to_string(),
        "::" => Ipv6Addr::LOCALHOST.to_string(),
        other => other.trim_matches(['[', ']']).to_string(),
    }
}

/// 启动自愈:上一实例被强杀/崩溃时,它 spawn 的 naive 会变成孤儿继续占着
/// 监听端口(→ preflight 拒绝 → 用户只看到「端口被占用」却找不到占用者)。
/// 依据 pidfile 清理;先校验进程名确为 naive.exe,防 PID 复用误杀无辜。
#[cfg(windows)]
pub fn cleanup_orphan_naive(app: &tauri::AppHandle) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let pid_path = crate::paths::data_root(app)
        .join("runtime")
        .join("current")
        .join("naive.pid");
    let Ok(content) = std::fs::read_to_string(&pid_path) else {
        return;
    };
    let pid = content.trim().to_string();
    if pid.is_empty() || !pid.bytes().all(|b| b.is_ascii_digit()) {
        let _ = std::fs::remove_file(&pid_path);
        return;
    }
    let is_naive = std::process::Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .to_lowercase()
                .contains("naive.exe")
        })
        .unwrap_or(false);
    if is_naive {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid, "/F", "/T"])
            .creation_flags(CREATE_NO_WINDOW)
            .output();
    }
    let _ = std::fs::remove_file(&pid_path);
}

impl Manager {
    pub fn new(app: tauri::AppHandle) -> Arc<Self> {
        Arc::new(Self {
            app,
            inner: Arc::new(Mutex::new(Inner::default())),
        })
    }

    pub async fn status(&self) -> RuntimeState {
        self.inner.lock().await.state.clone()
    }

    pub async fn start(&self, ctx: StartCtx) -> CmdResult<()> {
        let mut inner = self.inner.lock().await;
        if !matches!(inner.state, RuntimeState::Idle)
            && !matches!(inner.state, RuntimeState::Stopped { .. })
        {
            return Err(AppError::AlreadyRunning(
                inner.profile_id.clone().unwrap_or_default(),
            ));
        }
        inner.restarts = 0;
        drop(inner);
        spawn_runtime(self.app.clone(), self.inner.clone(), ctx.clone()).await
    }

    pub async fn stop(&self) -> CmdResult<()> {
        let (tx, profile_id) = {
            let mut inner = self.inner.lock().await;
            match inner.profile_id.clone() {
                None => return Err(AppError::NotRunning),
                Some(id) => {
                    inner.stopping = true;
                    inner.state = RuntimeState::Stopping {
                        profile_id: id.clone(),
                    };
                    (inner.stop_tx.take(), id)
                }
            }
        };
        emit_state(
            &self.app,
            &RuntimeState::Stopping {
                profile_id: profile_id.clone(),
            },
        );
        if let Some(tx) = tx {
            let _ = tx.send(());
        }
        // 轮询等待 exit-watcher 落定最终状态(kill 后通常 <200ms;上限 3s)
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let done = {
                let g = self.inner.lock().await;
                matches!(g.state, RuntimeState::Stopped { .. } | RuntimeState::Idle)
            };
            if done {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        Ok(())
    }
}

/// 共享 spawn:写 config → 起进程 → 派生 stderr/ready/exit 三个任务。
/// 注意:finalize 会经 spawn_runtime_task 递归回来(崩溃重启),
/// 递归经 Box<dyn Future + Send> 打断,否则 opaque type 无法证明 Send。
async fn spawn_runtime(
    app: tauri::AppHandle,
    inner: Arc<Mutex<Inner>>,
    ctx: StartCtx,
) -> CmdResult<()> {
    // D9:每次连接重写 runtime config
    std::fs::create_dir_all(&ctx.config_dir)?;
    let config_path = ctx.config_dir.join("config.json");
    std::fs::write(&config_path, ctx.config_json.as_bytes())?;

    // §7.1:端口预检(被占则明确报错,避免进程起又崩后玄学「启动失败」)
    preflight_ports(&ctx.listen).await?;

    if !ctx.binary.exists() {
        return Err(AppError::Spawn(format!(
            "naive 二进制不存在:{}",
            ctx.binary.display()
        )));
    }

    let mut cmd = Command::new(&ctx.binary);
    cmd.arg(&config_path)
        .current_dir(&ctx.config_dir)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW:防控制台闪窗(creation_flags 为 tokio Command 固有方法)
        cmd.creation_flags(0x0800_0000);
    }

    let mut child: Child = cmd.spawn().map_err(|e| AppError::Spawn(e.to_string()))?;
    let stderr = child.stderr.take().expect("stderr piped");
    let pid = child
        .id()
        .map(|p| p.to_string())
        .unwrap_or_else(|| "?".into());
    // pidfile:供启动自愈(cleanup_orphan_naive)在 app 被强杀/崩溃后清理孤儿 naive
    if pid != "?" {
        let _ = std::fs::write(ctx.config_dir.join("naive.pid"), pid.as_bytes());
    }

    {
        let mut g = inner.lock().await;
        g.profile_id = Some(ctx.profile_id.clone());
        g.ready = false;
        g.started_at = Some(Instant::now());
        g.stopping = false;
        g.state = RuntimeState::Starting {
            profile_id: ctx.profile_id.clone(),
        };
    }
    emit_state(
        &app,
        &RuntimeState::Starting {
            profile_id: ctx.profile_id.clone(),
        },
    );
    emit_log(
        &app,
        &ctx.profile_id,
        &format!("spawn naive (pid {pid}), config: {}", config_path.display()),
    );
    // ── stderr reader:日志事件 + ready 行检测 + **落盘** ──
    // 落盘动机:naive 秒退时(如端口冲突/证书错误/路径编码),若只有管道+异步
    // 任务,事件可能尚未派发或 UI 已放弃,失败原因随进程一起蒸发,用户只看到
    // 玄学的「启动失败」。落盘后 runtime/current/naive.log 永久可查。
    let log_path = ctx.config_dir.join("naive.log");
    let mut log_file = std::fs::File::create(&log_path).ok();
    {
        let app = app.clone();
        let inner = inner.clone();
        let profile_id = ctx.profile_id.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                emit_log(&app, &profile_id, &line);
                if let Some(f) = log_file.as_mut() {
                    use std::io::Write;
                    let _ = writeln!(f, "{line}");
                }
                // ready 行:naive 真实输出带日志前缀(如
                // "[1008/213741:INFO:naive_proxy_bin.cc(479)] Listening on socks://127.0.0.1:3081"),
                // 不能用 starts_with,否则永远判不到 ready。
                if line.contains("Listening on ") {
                    let mut g = inner.lock().await;
                    if !g.ready {
                        g.ready = true;
                        g.state = RuntimeState::Running {
                            profile_id: profile_id.clone(),
                        };
                        emit_state(&app, &g.state);
                    }
                }
            }
        });
    }

    // ── ready 探测:250ms 起持续 TCP 探测(不等 10s 超时) ──
    // 动机:naive 默认 LOG_NONE 时 stderr 不会出现 "Listening on" 行,
    // 仅靠日志判 ready 会让 UI 在 starting 状态挂 10s。
    {
        let app = app.clone();
        let inner = inner.clone();
        let listen = ctx.listen.clone();
        let profile_id = ctx.profile_id.clone();
        tokio::spawn(async move {
            let deadline = Instant::now() + READY_TIMEOUT;
            while Instant::now() < deadline {
                // 先看日志路径是否已 ready(stderr reader 已置位)
                {
                    let g = inner.lock().await;
                    if g.ready || !matches!(g.state, RuntimeState::Starting { .. }) {
                        return; // 已 ready 或已退出/停止
                    }
                }
                // 端口探测:任意 listen 端口可连即 ready
                let mut any = false;
                for l in &listen {
                    let addr = format!("{}:{}", local_addr(&l.addr), l.port);
                    if let Ok(sock) = addr.parse::<SocketAddr>() {
                        if tokio::time::timeout(
                            Duration::from_millis(300),
                            TcpStream::connect(sock),
                        )
                        .await
                        .map(|r| r.is_ok())
                        .unwrap_or(false)
                        {
                            any = true;
                            break;
                        }
                    }
                }
                if any {
                    let mut g = inner.lock().await;
                    if !g.ready && matches!(g.state, RuntimeState::Starting { .. }) {
                        g.ready = true;
                        g.state = RuntimeState::Running {
                            profile_id: profile_id.clone(),
                        };
                        emit_state(&app, &g.state);
                        emit_log(&app, &profile_id, "(ready 由端口探测确认)");
                    }
                    return;
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            // 超时未 ready:交给 exit-watcher 判定 FailedToStart;naive 自身很快会退出
            emit_log(&app, &profile_id, "ready 超时且端口探测失败,等待进程退出…");
        });
    }

    // ── exit watcher:持有 Child,处理 stop / 崩溃 / 退避重启 ──
    {
        let app = app.clone();
        let inner = inner.clone();
        let ctx = ctx.clone();
        tokio::spawn(async move {
            let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
            {
                let mut g = inner.lock().await;
                g.stop_tx = Some(stop_tx);
            }

            tokio::select! {
                _ = stop_rx => {
                    let _ = child.kill().await;
                    let code = child.wait().await.ok().and_then(|s| s.code());
                    finalize(&app, &inner, StopReason::User, code, &ctx).await;
                }
                status = child.wait() => {
                    let code = status.ok().and_then(|s| s.code());
                    let (stopping, ready) = {
                        let g = inner.lock().await;
                        (g.stopping, g.ready)
                    };
                    let reason = if stopping {
                        StopReason::User
                    } else if !ready {
                        StopReason::FailedToStart
                    } else {
                        StopReason::Crash
                    };
                    finalize(&app, &inner, reason, code, &ctx).await;
                }
            }
        });
    }

    Ok(())
}

/// 退出落定:更新状态 + 事件 + 退避重启决策
async fn finalize(
    app: &tauri::AppHandle,
    inner: &Arc<Mutex<Inner>>,
    reason: StopReason,
    exit_code: Option<i32>,
    ctx: &StartCtx,
) {
    // 进程已退出:清理 pidfile(重启路径会重新写入)
    let _ = std::fs::remove_file(ctx.config_dir.join("naive.pid"));
    let uptime = {
        let mut g = inner.lock().await;
        let up = g.started_at.map(|t| t.elapsed());
        g.state = RuntimeState::Stopped {
            profile_id: ctx.profile_id.clone(),
            reason,
            exit_code,
        };
        g.stop_tx = None;
        g.started_at = None;
        up
    };
    emit_state(app, &inner.lock().await.state.clone());
    notify_stopped(app, inner).await;

    // 崩溃自动重启(§7.5)。注意:crash → backoff 期间是「即将自动重启」,
    // 前端将其显示为 failed + 副行提示,而非转回 idle(避免按钮振荡)。
    if reason != StopReason::Crash || !ctx.auto_restart {
        if reason == StopReason::Crash {
            let mut g = inner.lock().await;
            g.restarts = 0;
        }
        return;
    }

    let stable = uptime.map(|d| d >= STABLE_UPTIME).unwrap_or(false);
    {
        let mut g = inner.lock().await;
        if stable {
            g.restarts = 0;
        }
        if g.restarts >= MAX_RESTARTS {
            emit_log(
                app,
                &ctx.profile_id,
                &format!("已达最大自动重启次数({MAX_RESTARTS}),停止重试"),
            );
            // 放弃重启:语义为启动失败(failed-to-start),前端据此显示「↻ 重试」而非卡在处理中
            g.state = RuntimeState::Stopped {
                profile_id: ctx.profile_id.clone(),
                reason: StopReason::FailedToStart,
                exit_code,
            };
            drop(g);
            emit_state(app, &inner.lock().await.state.clone());
            return;
        }
        let idx = (g.restarts as usize).min(BACKOFF.len() - 1);
        g.restarts += 1;
        BACKOFF[idx]
    };
    let backoff = {
        let g = inner.lock().await;
        BACKOFF[((g.restarts - 1) as usize).min(BACKOFF.len() - 1)]
    };
    emit_log(
        app,
        &ctx.profile_id,
        &format!("进程异常退出(code={exit_code:?}),{backoff:?} 后自动重启"),
    );
    tokio::time::sleep(backoff).await;

    // 重启前确认没有新的运行/用户操作
    {
        let g = inner.lock().await;
        if g.stopping || !matches!(g.state, RuntimeState::Stopped { .. }) || g.stop_tx.is_some() {
            return;
        }
    }
    let _ = spawn_runtime_task(app.clone(), inner.clone(), ctx.clone()).await;
}

/// 递归屏障:finalize → 重启 → spawn_runtime 的循环经此装箱打断
///(直接 await 会让编译器无法证明 async fn 的 opaque future 是 Send)。
fn spawn_runtime_task(
    app: tauri::AppHandle,
    inner: Arc<Mutex<Inner>>,
    ctx: StartCtx,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = CmdResult<()>> + Send + 'static>> {
    Box::pin(spawn_runtime(app, inner, ctx))
}

/// stop() 的等待已改为轮询判终态(见 Manager::stop);此函数保留为 no-op 钩子。
async fn notify_stopped(_app: &tauri::AppHandle, _inner: &Arc<Mutex<Inner>>) {}

#[cfg(test)]
mod wire_format_tests {
    use super::*;

    /// 契约测试:RuntimeState 的 JSON 形状必须与 src/lib/ipc.ts 的 TS 类型逐字对齐。
    /// 历史事故:`rename_all_fields` 只改字段不改变体名,序列化成 "Starting"/"Running",
    /// 前端 switch 的小写 case 全部匹配不上 → 状态事件被静默吞掉,UI 永远卡「处理中」。
    #[test]
    fn runtime_state_matches_ipc_ts() {
        let cases: Vec<(RuntimeState, &str)> = vec![
            (RuntimeState::Idle, r#"{"state":"idle"}"#),
            (
                RuntimeState::Starting {
                    profile_id: "p1".into(),
                },
                r#"{"state":"starting","profileId":"p1"}"#,
            ),
            (
                RuntimeState::Running {
                    profile_id: "p1".into(),
                },
                r#"{"state":"running","profileId":"p1"}"#,
            ),
            (
                RuntimeState::Stopping {
                    profile_id: "p1".into(),
                },
                r#"{"state":"stopping","profileId":"p1"}"#,
            ),
            (
                RuntimeState::Stopped {
                    profile_id: "p1".into(),
                    reason: StopReason::User,
                    exit_code: Some(0),
                },
                r#"{"state":"stopped","profileId":"p1","reason":"user","exitCode":0}"#,
            ),
            (
                RuntimeState::Stopped {
                    profile_id: "p1".into(),
                    reason: StopReason::FailedToStart,
                    exit_code: None,
                },
                r#"{"state":"stopped","profileId":"p1","reason":"failed-to-start","exitCode":null}"#,
            ),
            (
                RuntimeState::Stopped {
                    profile_id: "p1".into(),
                    reason: StopReason::Crash,
                    exit_code: Some(1),
                },
                r#"{"state":"stopped","profileId":"p1","reason":"crash","exitCode":1}"#,
            ),
        ];
        for (state, expected) in cases {
            assert_eq!(serde_json::to_string(&state).unwrap(), expected);
        }
    }

    #[test]
    fn log_event_matches_ipc_ts() {
        let ev = LogEvent {
            profile_id: "p1".into(),
            ts: 123,
            line: "hi".into(),
        };
        assert_eq!(
            serde_json::to_string(&ev).unwrap(),
            r#"{"profileId":"p1","ts":123,"line":"hi"}"#
        );
    }
}
