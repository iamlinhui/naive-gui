/**
 * 校验规则表(DESIGN.md §5)实现。
 * 错误码与文档一一对应:V-L-* 监听 / V-P-* 代理 / V-A-* 高级 / V-D-* 诊断。
 * 级别:error 阻断保存/启动;warning 提示;info 说明。
 */
import type { Profile, ProxyChain, ProxyHop } from "./schema";
import { isIPv6, isIpLiteral } from "./codec";

export type Severity = "error" | "warning" | "info";
export type TargetKind = "listen" | "hop" | "chain" | "profile" | "advanced" | "debug";

export interface ValidationIssue {
  code: string;
  severity: Severity;
  /** 定位:字段类别 + 索引,UI 锚点用 */
  kind: TargetKind;
  index?: number;
  chainIndex?: number;
  message: string;
}

const isLinux = () =>
  typeof navigator !== "undefined" &&
  typeof navigator.userAgent === "string" &&
  /Linux/.test(navigator.userAgent) &&
  !/Android/.test(navigator.userAgent);

function isHostName(s: string): boolean {
  if (!s) return false;
  if (isIpLiteral(s)) return true; // IP 也是合法 host
  return /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(s);
}

function isCidr4(s: string): boolean {
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/.exec(s);
  if (!m) return false;
  const oct = m[1].split(".").map(Number);
  if (oct.some((o) => o > 255)) return false;
  const prefix = Number(m[2]);
  return prefix <= 32;
}

/* ───────── V-L:监听 ───────── */

function checkListen(p: Profile): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const seen = new Map<number, number[]>();

  p.listen.forEach((l, i) => {
    if (l.proto === "redir" && !isLinux()) {
      out.push({ code: "V-L-02", severity: "error", kind: "listen", index: i,
        message: "redir 协议仅在 Linux 可用(naive_config.cc BUILDFLAG IS_LINUX)" });
    }
    if (!isIpLiteral(l.addr)) {
      out.push({ code: "V-L-03", severity: "error", kind: "listen", index: i,
        message: "监听地址必须是 IP 字面量(127.0.0.1 / 0.0.0.0 / ::1),不能是主机名" });
    } else if (isIPv6(l.addr) && l.proto === "redir") {
      out.push({ code: "V-L-03", severity: "warning", kind: "listen", index: i,
        message: "redir 的内置解析器目前仅支持 IPv4 地址段" });
    }
    if (!Number.isInteger(l.port) || l.port < 1 || l.port > 65535) {
      out.push({ code: "V-L-04", severity: "error", kind: "listen", index: i,
        message: "端口须为 1-65535" });
    }
    const arr = seen.get(l.port) ?? [];
    arr.push(i);
    seen.set(l.port, arr);
  });

  for (const [port, idxs] of seen) {
    if (idxs.length > 1) {
      out.push({ code: "V-L-05", severity: "error", kind: "listen", index: idxs[1],
        message: `端口 ${port} 在本 Profile 内重复(行 ${idxs.map((i) => i + 1).join("、")})` });
    }
  }
  return out;
}

/* ───────── V-P:代理 ───────── */

function checkChain(chain: ProxyChain, chainIndex: number | undefined, out: ValidationIssue[]) {
  let seenTcp = false;
  const socksCount = chain.length > 1
    ? chain.filter((h) => h.scheme === "socks").length
    : 0;

  chain.forEach((hop: ProxyHop, i) => {
    const loc = { chainIndex, index: i };

    if (!hop.host || !isHostName(hop.host)) {
      out.push({ code: "V-P-02", severity: "error", kind: "hop", ...loc,
        message: "代理地址为空或不是合法的域名/IP" });
    }
    if (hop.port !== undefined && (hop.port < 1 || hop.port > 65535)) {
      out.push({ code: "V-P-03", severity: "error", kind: "hop", ...loc,
        message: "端口须为 1-65535 或留空(用协议默认端口)" });
    }
    // QUIC 顺序:一旦见过 TCP,后面出现 quic 即错(naive_config.cc:208)
    if (hop.scheme === "quic" && seenTcp) {
      out.push({ code: "V-P-04", severity: "error", kind: "hop", ...loc,
        message: "QUIC 跳不能排在 TCP 代理(https/http/socks)之后(naive_config.cc:208)" });
    }
    if (hop.scheme !== "quic") seenTcp = true;
    // SOCKS 认证:不支持(仅 stderr 警告不中断,naive_config.cc:225)
    if (hop.scheme === "socks" && hop.auth) {
      out.push({ code: "V-P-06", severity: "warning", kind: "hop", ...loc,
        message: "SOCKS 代理不支持认证,凭据将被忽略(上游仅警告)" });
    }
  });

  // 多跳链含 SOCKS:naive 直接拒绝(naive_config.cc:238-248)
  if (socksCount > 0) {
    const i = chain.findIndex((h) => h.scheme === "socks");
    out.push({ code: "V-P-05", severity: "error", kind: "hop", chainIndex, index: i,
      message: "SOCKS 代理不支持链式(多跳链中不能包含 SOCKS 跳)" });
  }

  if (chain.length > 1) {
    const last = chain[chain.length - 1];
    out.push({ code: "V-P-09", severity: "info", kind: "chain", chainIndex,
      message: last.scheme === "socks"
        ? "SOCKS 末跳无 Naive padding(V-P-08)"
        : "多跳链:末跳才是 Naive 服务端,padding 仅对末跳自动协商" });
  }
}

function checkProxy(p: Profile): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  if (p.routingMode === "multi") {
    const chains = p.chains ?? [];
    if (chains.length < 2 || chains.length !== p.listen.length) {
      out.push({ code: "V-P-07", severity: "error", kind: "profile",
        message: `多代理链模式:链数量(${chains.length})必须 ≥2 且等于监听数量(${p.listen.length}),按位置一一配对` });
    }
    chains.forEach((c, ci) => checkChain(c, ci, out));
  } else {
    checkChain(p.server, undefined, out);
  }
  return out;
}

/* ───────── V-A:高级 ───────── */

function checkAdvanced(p: Profile): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const a = p.advanced;

  if (a.insecureConcurrency !== undefined && a.insecureConcurrency < 1) {
    out.push({ code: "V-A-01", severity: "error", kind: "advanced",
      message: "并发连接数必须 ≥1" });
  }
  if (a.insecureConcurrency !== undefined && a.insecureConcurrency > 1) {
    out.push({ code: "V-A-01", severity: "warning", kind: "advanced",
      message: a.insecureConcurrency > 4
        ? "并发 >4:上游强烈不建议(USAGE.txt:86),流量特征更易被识别"
        : "并发 >1 会降低抗流量分析强度,建议 ≤4,优先尝试 2(USAGE.txt:80)" });
  }
  if (a.tunnelTimeout !== undefined && a.tunnelTimeout < 1) {
    out.push({ code: "V-A-02", severity: "error", kind: "advanced", message: "隧道轮换须 ≥1 秒" });
  }
  if (a.idleTimeout !== undefined && a.idleTimeout < 1) {
    out.push({ code: "V-A-02", severity: "error", kind: "advanced", message: "空闲超时须 ≥1 秒" });
  }
  if (a.resolverRange !== undefined) {
    if (!isCidr4(a.resolverRange)) {
      out.push({ code: "V-A-03", severity: "error", kind: "advanced", message: "resolver-range 须为合法 IPv4 CIDR(如 100.64.0.0/10)" });
    } else if (!p.listen.some((l) => l.proto === "redir")) {
      out.push({ code: "V-A-03", severity: "warning", kind: "advanced", message: "resolver-range 仅在 redir 监听模式下生效" });
    }
  }
  if (a.extraHeaders) {
    const lines = a.extraHeaders.split(/\r\n|\r|\n/);
    const bad = lines.some((ln) => ln.trim() !== "" && !/^[!#-9;-~]+:[ \t]/.test(ln));
    if (bad) {
      out.push({ code: "V-A-04", severity: "warning", kind: "advanced", message: "extra-headers 每行须为 Name: value 格式(CRLF 分隔)" });
    }
  }
  return out;
}

/* ───────── V-D:诊断 ───────── */

function checkDebug(p: Profile): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const d = p.debug;
  if (typeof d.log === "object" && !d.log.file.trim()) {
    out.push({ code: "V-D-01", severity: "error", kind: "debug", message: "日志文件路径不能为空" });
  }
  if (d.logNetLog) {
    out.push({ code: "V-D-02", severity: "warning", kind: "debug", message: "NetLog 已开启:包含完整网络事件,注意隐私" });
  }
  if (d.sslKeyLogFile) {
    out.push({ code: "V-D-02", severity: "warning", kind: "debug",
      message: "SSL 密钥日志已开启:持有该文件即可解密全部流量(Wireshark)" });
  }
  return out;
}

/* ───────── 入口 ───────── */

export function validateProfile(p: Profile): ValidationIssue[] {
  return [...checkListen(p), ...checkProxy(p), ...checkAdvanced(p), ...checkDebug(p)];
}

/** 是否存在 error 级(阻断保存/连接) */
export function hasErrors(issues: ValidationIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}
