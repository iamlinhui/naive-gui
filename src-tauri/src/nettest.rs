//! 连通性测试(DESIGN.md §7.6):L1 本地 TCP + L2 端到端隧道。

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use tokio::net::TcpStream;

use crate::error::{AppError, CmdResult};

#[derive(Debug, Clone, serde::Serialize)]
// 同 RuntimeState:rename_all 管变体名(Ok→ok,LocalTcpFail→local-tcp-fail),
// rename_all_fields 管字段名(latency_ms→latencyMs)。缺一不可。
#[serde(
    tag = "result",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum TestResult {
    Ok { latency_ms: u64 },
    LocalTcpFail,
    ProxyHandshakeFail,
    TunnelError { detail: String },
    Timeout,
}

fn local_addr(addr: &str) -> String {
    match addr {
        "0.0.0.0" => "127.0.0.1".into(),
        "::" => "::1".into(),
        other => other.trim_matches(['[', ']']).to_string(),
    }
}

/// L1:本地端口 TCP 探测
pub async fn tcp_probe(addr: &str, port: u16) -> bool {
    let sock: SocketAddr = match format!("{addr}:{port}").parse() {
        Ok(s) => s,
        Err(_) => return false,
    };
    tokio::time::timeout(Duration::from_millis(1500), TcpStream::connect(sock))
        .await
        .map(|r| r.is_ok())
        .unwrap_or(false)
}

/// L2:通过本地 SOCKS5/HTTP 代理请求 generate_204
pub async fn end_to_end(proto: &str, port: u16) -> TestResult {
    use reqwest::Proxy;

    let proxy_url = if proto == "socks" {
        format!("socks5://127.0.0.1:{port}")
    } else {
        format!("http://127.0.0.1:{port}")
    };

    let proxy = match Proxy::all(&proxy_url) {
        Ok(p) => p,
        Err(e) => {
            return TestResult::TunnelError {
                detail: e.to_string(),
            }
        }
    };

    let client = match reqwest::Client::builder()
        .proxy(proxy)
        .timeout(Duration::from_secs(10))
        .danger_accept_invalid_certs(false)
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return TestResult::TunnelError {
                detail: e.to_string(),
            }
        }
    };

    let t0 = Instant::now();
    let resp = client
        .get("http://cp.cloudflare.com/generate_204")
        .timeout(Duration::from_secs(10))
        .send()
        .await;
    let latency = t0.elapsed().as_millis() as u64;

    match resp {
        Ok(r) => {
            let status = r.status().as_u16();
            // 任意 HTTP 状态都算隧道通(§7.6:204 之外的 3xx/200 也证明链路可用)
            if status > 0 {
                TestResult::Ok {
                    latency_ms: latency,
                }
            } else {
                TestResult::TunnelError {
                    detail: format!("HTTP {status} via tunnel"),
                }
            }
        }
        Err(e) => {
            // 区分 SOCKS 握手失败与隧道错误
            let msg = e.to_string();
            if msg.contains("socks") || msg.contains("proxy") && msg.contains("handshake") {
                TestResult::ProxyHandshakeFail
            } else if e.is_timeout() {
                TestResult::Timeout
            } else {
                TestResult::TunnelError { detail: msg }
            }
        }
    }
}

/// 组合测试入口
pub async fn run_test(listen: Vec<crate::process::ListenEndpoint>) -> CmdResult<TestReport> {
    let mut report = TestReport {
        l1: Vec::new(),
        l2: None,
    };
    // L1:全部 listen 端口
    for l in &listen {
        let ok = tcp_probe(&local_addr(&l.addr), l.port).await;
        report.l1.push(EndpointResult {
            proto: l.proto.clone(),
            port: l.port,
            ok,
        });
    }
    if report.l1.iter().any(|e| e.ok) {
        // L2:优先 socks,其次 http
        let target = listen
            .iter()
            .find(|l| l.proto == "socks")
            .or_else(|| listen.iter().find(|l| l.proto == "http"));
        if let Some(t) = target {
            report.l2 = Some(end_to_end(&t.proto, t.port).await);
        }
    } else {
        report.l2 = Some(TestResult::LocalTcpFail);
    }
    Ok(report)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct EndpointResult {
    pub proto: String,
    pub port: u16,
    pub ok: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct TestReport {
    pub l1: Vec<EndpointResult>,
    pub l2: Option<TestResult>,
}

// silence unused import warning for AppError path when needed
#[allow(unused)]
fn _unused(_: AppError) {}

#[cfg(test)]
mod wire_format_tests {
    use super::*;

    /// 契约测试:TestResult/TestReport 的 JSON 形状必须与 src/lib/ipc.ts 逐字对齐
    ///(历史事故:变体名序列化成 "Ok"/"LocalTcpFail",前端判别 r.result === "ok" 永假)。
    #[test]
    fn test_result_matches_ipc_ts() {
        let cases: Vec<(TestResult, &str)> = vec![
            (
                TestResult::Ok { latency_ms: 42 },
                r#"{"result":"ok","latencyMs":42}"#,
            ),
            (TestResult::LocalTcpFail, r#"{"result":"local-tcp-fail"}"#),
            (
                TestResult::ProxyHandshakeFail,
                r#"{"result":"proxy-handshake-fail"}"#,
            ),
            (
                TestResult::TunnelError { detail: "x".into() },
                r#"{"result":"tunnel-error","detail":"x"}"#,
            ),
            (TestResult::Timeout, r#"{"result":"timeout"}"#),
        ];
        for (t, expected) in cases {
            assert_eq!(serde_json::to_string(&t).unwrap(), expected);
        }
    }

    #[test]
    fn test_report_matches_ipc_ts() {
        let r = TestReport {
            l1: vec![EndpointResult {
                proto: "socks".into(),
                port: 3080,
                ok: true,
            }],
            l2: Some(TestResult::Ok { latency_ms: 7 }),
        };
        assert_eq!(
            serde_json::to_string(&r).unwrap(),
            r#"{"l1":[{"proto":"socks","port":3080,"ok":true}],"l2":{"result":"ok","latencyMs":7}}"#
        );
    }
}
