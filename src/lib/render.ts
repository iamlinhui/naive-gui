/**
 * Profile → naive config.json 渲染(DESIGN.md §4.3,纯函数)。
 *
 * 契约依据(逐条对齐 naive_config.cc):
 * - listen: 始终渲染为数组;userinfo 百分号编码(naive 侧 UnescapeBinaryURLComponent)
 * - proxy:  single → 字符串;multi → 数组(长度 === listen.length,按位置配对,naive_proxy_bin.cc:524)
 * - 覆盖项: 仅显式设置才写入键(undefined → 省略 → naive 默认值)
 * - log:    'stderr' → "";'none' → 省略;{file} → 路径(naive_config.cc:291-304)
 * - no-post-quantum: 仅 true 时写入(naive 按键存在判定,naive_config.cc:324)
 * - 空链(quic socks 之外的空字符串)永远不会出现:Parse 侧已 min(1)
 */
import { DEFAULT_PORTS } from "./schema";
import { formatHost, formatUserinfo } from "./codec";
import type { Profile, ProxyChain, ListenEndpoint, ProxyHop } from "./schema";

export interface NaiveConfig {
  listen: string[];
  proxy?: string | string[];
  "insecure-concurrency"?: number;
  "tunnel-timeout"?: number;
  "idle-timeout"?: number;
  "extra-headers"?: string;
  "host-resolver-rules"?: string;
  "resolver-range"?: string;
  log?: string;
  "log-net-log"?: string;
  "ssl-key-log-file"?: string;
  "no-post-quantum"?: true;
}

function renderHop(hop: ProxyHop): string {
  const port = hop.port ?? DEFAULT_PORTS[hop.scheme];
  const auth = hop.auth ? formatUserinfo(hop.auth.user, hop.auth.pass) + "@" : "";
  return `${hop.scheme}://${auth}${formatHost(hop.host)}:${port}`;
}

function renderChain(chain: ProxyChain): string {
  // 链内逗号分隔(USAGE.txt PROXY-CHAIN);最后一跳 = Naive 服务端
  return chain.map(renderHop).join(",");
}

function renderListen(l: ListenEndpoint): string {
  const auth = l.auth ? formatUserinfo(l.auth.user, l.auth.pass) + "@" : "";
  return `${l.proto}://${auth}${formatHost(l.addr)}:${l.port}`;
}

/** 入口:渲染完整 config.json 对象(调用方负责 JSON.stringify) */
export function renderConfig(profile: Profile): NaiveConfig {
  const cfg: NaiveConfig = {
    listen: profile.listen.map(renderListen),
  };

  if (profile.routingMode === "multi" && profile.chains?.length) {
    cfg.proxy = profile.chains.map(renderChain);
  } else {
    cfg.proxy = renderChain(profile.server);
  }

  const a = profile.advanced;
  if (a.insecureConcurrency !== undefined) cfg["insecure-concurrency"] = a.insecureConcurrency;
  if (a.tunnelTimeout !== undefined) cfg["tunnel-timeout"] = a.tunnelTimeout;
  if (a.idleTimeout !== undefined) cfg["idle-timeout"] = a.idleTimeout;
  if (a.extraHeaders) cfg["extra-headers"] = a.extraHeaders;
  if (a.hostResolverRules) cfg["host-resolver-rules"] = a.hostResolverRules;
  if (a.resolverRange) cfg["resolver-range"] = a.resolverRange;

  const d = profile.debug;
  if (d.log === "stderr") cfg.log = "";
  else if (typeof d.log === "object") cfg.log = d.log.file;
  if (d.logNetLog) cfg["log-net-log"] = d.logNetLog;
  if (d.sslKeyLogFile) cfg["ssl-key-log-file"] = d.sslKeyLogFile;
  if (d.noPostQuantum === true) cfg["no-post-quantum"] = true;

  return cfg;
}

/** 渲染为字符串(2 空格缩进,带尾换行,便于人读) */
export function renderConfigJson(profile: Profile): string {
  return JSON.stringify(renderConfig(profile), null, 2) + "\n";
}
