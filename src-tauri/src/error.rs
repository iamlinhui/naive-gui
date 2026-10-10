//! 统一错误类型(DESIGN.md §12):serde 序列化为 { code, message } 供前端 i18n。

use serde::Serialize;

#[derive(Debug, thiserror::Error)]
#[allow(dead_code)] // NetTest 变体暂未被构造(nettest 错误走其他路径),保留以备 §12 分类
pub enum AppError {
    #[error("IO 错误: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON 错误: {0}")]
    Json(#[from] serde_json::Error),

    #[error("运行时未启动")]
    NotRunning,

    #[error("运行时已在运行 profile={0}")]
    AlreadyRunning(String),

    #[error("进程启动失败: {0}")]
    Spawn(String),

    #[error("系统代理错误: {0}")]
    SysProxy(String),

    #[error("网络测试错误: {0}")]
    NetTest(String),

    #[error("未找到: {0}")]
    NotFound(String),

    #[error("{0}")]
    Bad(String),
}

#[derive(Serialize, Clone)]
pub struct ErrorPayload {
    pub code: &'static str,
    pub message: String,
}

impl AppError {
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Io(_) => "io",
            AppError::Json(_) => "json",
            AppError::NotRunning => "not-running",
            AppError::AlreadyRunning(_) => "already-running",
            AppError::Spawn(_) => "spawn",
            AppError::SysProxy(_) => "sysproxy",
            AppError::NetTest(_) => "nettest",
            AppError::NotFound(_) => "not-found",
            AppError::Bad(_) => "bad",
        }
    }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        ErrorPayload {
            code: self.code(),
            message: self.to_string(),
        }
        .serialize(s)
    }
}

pub type CmdResult<T> = Result<T, AppError>;
