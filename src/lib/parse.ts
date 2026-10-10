/**
 * 导入解析(DESIGN.md §8 import_from_text / M1):
 * 1. naive+ 分享链接:naive+https://user:pass@host:port#名称
 * 2. 完整 naive config.json → 反解析回 Profile
 *
 * 解析规则对齐 render.ts 的逆操作。所有函数纯抛 ImportError,不吞错。
 */
import { DEFAULT_PORTS, DEFAULT_LISTEN_PORT, type Profile, type ProxyHop, type ProxyChain } from "./schema";
import { decodeUserinfo, parseHostPort } from "./codec";
import { newProfile } from "./schema";
import { renderConfig } from "./render";

export class ImportError extends Error {
  constructor(message: string, public detail?: string) {
    super(message);
    this.name = "ImportError";
  }
}

const SCHEMES = ["https", "http", "quic", "socks"] as const;
const LISTEN_PROTOS = ["socks", "http", "redir"] as const;

function parseUri(uri: string, expect: "proxy" | "listen"): { scheme: string; host: string; port?: number; user?: string; pass?: string } {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    throw new ImportError(`无法解析 URI:${uri}`);
  }
  const scheme = u.protocol.replace(":", "");
  if (expect === "proxy") {
    if (!(SCHEMES as readonly string[]).includes(scheme)) {
      throw new ImportError(`不支持的代理协议:${scheme}(支持 ${SCHEMES.join("/")})`);
    }
  } else if (!(LISTEN_PROTOS as readonly string[]).includes(scheme)) {
    throw new ImportError(`不支持的监听协议:${scheme}(支持 ${LISTEN_PROTOS.join("/")})`);
  }
  const hp = parseHostPort(u.host);
  if (!hp || !hp.host) throw new ImportError(`URI 中缺少主机:${uri}`);
  return {
    scheme,
    host: hp.host,
    port: hp.port,
    user: u.username ? decodeUserinfo(u.username) : undefined,
    pass: u.password ? decodeUserinfo(u.password) : undefined,
  };
}

function hopFromUri(uri: string): ProxyHop {
  const { scheme, host, port, user, pass } = parseUri(uri, "proxy");
  const s = scheme as ProxyHop["scheme"];
  return {
    scheme: s,
    host,
    port: port ?? DEFAULT_PORTS[s],
    ...(user ? { auth: { user, pass: pass ?? "" } } : {}),
  };
}

/** naive+https://user:pass@host:port#名称 → Profile(单跳,single 模式) */
export function parseNaiveShareUrl(input: string): Profile {
  const text = input.trim();
  const m = /^naive\+([a-z]+):\/\/(.+)$/i.exec(text);
  if (!m) throw new ImportError("不是有效的 naive+ 分享链接");
  const [, scheme, rest] = m;

  // hash 作名称
  const hashIdx = rest.indexOf("#");
  const body = hashIdx >= 0 ? rest.slice(0, hashIdx) : rest;
  const frag = hashIdx >= 0 ? decodeURIComponent(rest.slice(hashIdx + 1)) : "";

  const hop = hopFromUri(`${scheme}://${body}`);
  const p = newProfile(frag || hop.host);
  p.server = [hop];
  return p;
}

/** config.json → Profile(尽力反解析;高级/诊断字段按键存在与否还原) */
export function parseConfigJson(text: string): Profile {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ImportError("JSON 解析失败", String(e));
  }

  const listenRaw = raw.listen;
  if (listenRaw === undefined) throw new ImportError("config.json 缺少 listen 字段");
  const listenStrs = Array.isArray(listenRaw) ? listenRaw : [listenRaw];
  if (!listenStrs.every((s): s is string => typeof s === "string") || listenStrs.length === 0) {
    throw new ImportError("listen 必须是非空字符串数组或单个字符串");
  }
  const listen = listenStrs.map((s) => {
    const { scheme, host, port, user, pass } = parseUri(s, "listen");
    return {
      proto: scheme as "socks" | "http" | "redir",
      addr: host,
      port: port ?? DEFAULT_LISTEN_PORT[scheme as "socks" | "http" | "redir"],
      ...(user ? { auth: { user, pass: pass ?? "" } } : {}),
    };
  });

  const proxyRaw = raw.proxy;
  let routingMode: Profile["routingMode"] = "single";
  let server: ProxyChain = [{ scheme: "https", host: "" }]; // 直连(无 proxy 键)
  let chains: ProxyChain[] | undefined;

  if (proxyRaw !== undefined) {
    const proxyArr = Array.isArray(proxyRaw) ? proxyRaw : [proxyRaw];
    if (!proxyArr.every((s): s is string => typeof s === "string")) {
      throw new ImportError("proxy 必须是字符串或字符串数组");
    }
    // 每个元素是逗号分隔的链
    const parsed = proxyArr.map((chainStr) => chainStr.split(",").map((h) => hopFromUri(h.trim())));
    if (parsed.length >= 2) {
      routingMode = "multi";
      chains = parsed;
      server = parsed[0];
    } else {
      server = parsed[0] ?? [{ scheme: "https", host: "" }];
    }
  }

  const adv = raw;
  const advanced: Profile["advanced"] = {};
  if (typeof adv["insecure-concurrency"] === "number") advanced.insecureConcurrency = adv["insecure-concurrency"];
  if (typeof adv["tunnel-timeout"] === "number") advanced.tunnelTimeout = adv["tunnel-timeout"];
  if (typeof adv["idle-timeout"] === "number") advanced.idleTimeout = adv["idle-timeout"];
  if (typeof adv["extra-headers"] === "string" && adv["extra-headers"]) advanced.extraHeaders = adv["extra-headers"];
  if (typeof adv["host-resolver-rules"] === "string" && adv["host-resolver-rules"]) advanced.hostResolverRules = adv["host-resolver-rules"];
  if (typeof adv["resolver-range"] === "string" && adv["resolver-range"]) advanced.resolverRange = adv["resolver-range"];

  const debug: Profile["debug"] = { log: "none" };
  if (raw.log !== undefined) {
    if (raw.log === "") debug.log = "stderr";
    else if (typeof raw.log === "string") debug.log = { file: raw.log };
  }
  if (typeof raw["log-net-log"] === "string") debug.logNetLog = raw["log-net-log"];
  if (typeof raw["ssl-key-log-file"] === "string") debug.sslKeyLogFile = raw["ssl-key-log-file"];
  if ("no-post-quantum" in raw) debug.noPostQuantum = true;

  const p = newProfile("导入的配置");
  Object.assign(p, { listen, routingMode, server, chains, advanced, debug });
  return p;
}

/** 自动识别输入类型 */
export function importFromText(text: string): { kind: "url" | "config"; profile: Profile } {
  const t = text.trim();
  if (t.startsWith("naive+")) return { kind: "url", profile: parseNaiveShareUrl(t) };
  if (t.startsWith("{")) return { kind: "config", profile: parseConfigJson(t) };
  throw new ImportError("无法识别输入:支持 naive+ 分享链接或 config.json");
}

/** 往返检查:render(parse(cfg)) 应与 cfg 语义一致(单测用) */
export function roundTrip(profile: Profile): string {
  return renderConfig(profile) as unknown as string;
}
