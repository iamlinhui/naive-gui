/**
 * Profile 数据模型(DESIGN.md §4.1,zod schema)。
 * 契约依据:src/net/tools/naive/naive_config.{h,cc}、USAGE.txt。
 */
import { z } from "zod";

export const PROXY_SCHEMES = ["https", "http", "quic", "socks"] as const;
export type ProxyScheme = (typeof PROXY_SCHEMES)[number];

/** 协议默认端口(naive ProxyUriToProxyServer / EffectiveIntPort 语义) */
export const DEFAULT_PORTS: Record<ProxyScheme, number> = {
  https: 443,
  http: 80,
  quic: 443,
  socks: 1080,
};

export const LISTEN_PROTOS = ["socks", "http", "redir"] as const;
export type ListenProto = (typeof LISTEN_PROTOS)[number];

/** 默认端口来自 naive_config.h NaiveListenConfig(port=1080) */
export const DEFAULT_LISTEN_PORT: Record<ListenProto, number> = {
  socks: 1080,
  http: 8080,
  redir: 1080,
};

export const Auth = z.object({
  user: z.string().min(1),
  pass: z.string(),
});

export const ProxyHop = z.object({
  scheme: z.enum(PROXY_SCHEMES),
  host: z.string().min(1),
  /** 缺省 = 协议默认端口;渲染时补全 */
  port: z.number().int().min(1).max(65535).optional(),
  auth: Auth.optional(),
});
export type ProxyHop = z.infer<typeof ProxyHop>;

export const ProxyChain = z.array(ProxyHop).min(1);
export type ProxyChain = z.infer<typeof ProxyChain>;

export const ListenEndpoint = z.object({
  proto: z.enum(LISTEN_PROTOS),
  /** 必须是 IP 字面量(V-L-03);渲染走 ListenWithAddressAndPort */
  addr: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  auth: Auth.optional(),
});
export type ListenEndpoint = z.infer<typeof ListenEndpoint>;

export const Profile = z.object({
  id: z.string().min(1),
  name: z.string().min(1).trim(),
  schemaVersion: z.literal(1),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),

  /** 主代理链(single 模式;multi 模式下为 chains[0] 的初始值,仅作回退显示) */
  server: ProxyChain,
  routingMode: z.enum(["single", "multi"]),
  /** multi 模式:长度必须 === listen.length 且 ≥2(V-P-07) */
  chains: z.array(ProxyChain).optional(),

  listen: z.array(ListenEndpoint).min(1),

  advanced: z.object({
    /** 覆盖项:undefined = 不写入 config.json,吃 naive 默认(§4.3) */
    insecureConcurrency: z.number().int().min(1).max(64).optional(),
    tunnelTimeout: z.number().int().min(1).optional(),
    idleTimeout: z.number().int().min(1).optional(),
    extraHeaders: z.string().optional(),
    hostResolverRules: z.string().optional(),
    resolverRange: z.string().optional(),
  }),

  debug: z.object({
    /** stderr → log:"";none → 省略;{file} → 路径 */
    log: z.union([z.literal("stderr"), z.literal("none"), z.object({ file: z.string().min(1) })]),
    logNetLog: z.string().optional(),
    sslKeyLogFile: z.string().optional(),
    /** 仅 true 时写入键 — naive 端"键存在即生效"(naive_config.cc:324) */
    noPostQuantum: z.boolean().optional(),
  }),
});
export type Profile = z.infer<typeof Profile>;

export const ProfileFile = z.object({
  schemaVersion: z.literal(1),
  profiles: z.array(Profile),
});
export type ProfileFile = z.infer<typeof ProfileFile>;

/** 新建 Profile 工厂(默认值对齐 UI_SPEC §4) */
export function newProfile(name: string): Profile {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name,
    schemaVersion: 1,
    createdAt: now,
    updatedAt: now,
  server: [{ scheme: "https", host: "", port: 443 }],
    routingMode: "single",
    listen: [{ proto: "socks", addr: "127.0.0.1", port: 1080 }],
    advanced: {},
    debug: { log: "stderr" },
  };
}
