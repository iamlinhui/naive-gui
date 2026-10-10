/**
 * Tauri IPC 封装:类型化 invoke + 事件订阅(DESIGN.md §8)。
 * 测试/浏览器环境下退化为 no-op mock(vitest 中 lib 层不触达)。
 */

export interface ProfileFile { schemaVersion: number; profiles: unknown[] }
export interface AppSettings {
  language: string;
  theme: string;
  naiveBinaryPath: string | null;
  autoStartApp: boolean;
  autoConnectProfileId: string | null;
  minimizeToTray: boolean;
  setSystemProxyOnConnect: boolean;
  sysProxyBypass: string;
}
export interface SysproxyStatus { enable: boolean; host: string; port: number; bypass: string }
export type RuntimeState =
  | { state: "idle" }
  | { state: "starting"; profileId: string }
  | { state: "running"; profileId: string }
  | { state: "stopping"; profileId: string }
  | { state: "stopped"; profileId: string; reason: "user" | "crash" | "failed-to-start"; exitCode: number | null };
export interface LogEvent { profileId: string; ts: number; line: string }
export interface ListenEndpointIn { proto: string; addr: string; port: number }
export interface EndpointResult { proto: string; port: number; ok: boolean }
export type TestResult =
  | { result: "ok"; latencyMs: number }
  | { result: "local-tcp-fail" }
  | { result: "proxy-handshake-fail" }
  | { result: "tunnel-error"; detail: string }
  | { result: "timeout" };
export interface TestReport { l1: EndpointResult[]; l2: TestResult | null }

/** @ts-ignore 运行时才存在 */
const hasTauri = typeof window !== "undefined" && !!(window as any).__TAURI_INTERNALS__;

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!hasTauri) {
    throw new Error(`IPC 不可用(非 Tauri 环境):${cmd}`);
  }
  // 动态 import 避免 vitest 加载 @tauri-apps/api
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}

export const api = {
  listProfiles: () => invoke<ProfileFile>("list_profiles"),
  saveProfile: (profile: unknown) => invoke<void>("save_profile", { profile }),
  deleteProfile: (id: string) => invoke<void>("delete_profile", { id }),
  duplicateProfile: (id: string) => invoke<unknown>("duplicate_profile", { id }),
  reorderProfiles: (ids: string[]) => invoke<void>("reorder_profiles", { ids }),

  startRuntime: (profileId: string, configJson: string, listen: ListenEndpointIn[], autoRestart: boolean) =>
    invoke<void>("start_runtime", { profileId, configJson, listen, autoRestart }),
  stopRuntime: () => invoke<void>("stop_runtime"),
  runtimeStatus: () => invoke<RuntimeState>("runtime_status"),
  appTrace: (line: string) => invoke<void>("app_trace", { line }),

  testConnectivity: (listen: ListenEndpointIn[]) => invoke<TestReport>("test_connectivity", { listen }),

  sysproxyStatus: () => invoke<SysproxyStatus>("sysproxy_status"),
  sysproxyEnable: (port: number, bypass: string) => invoke<void>("sysproxy_enable", { port, bypass }),
  sysproxyDisable: () => invoke<void>("sysproxy_disable"),

  getSettings: () => invoke<AppSettings>("get_settings"),
  setSettings: (settings: AppSettings) => invoke<void>("set_settings", { settings }),

  detectNaiveBinary: (path: string) => invoke<{ ok: boolean; version?: string; error?: string }>("detect_naive_binary", { path }),
  /** 生效的 naive 二进制:显式路径或程序同目录自动发现;找不到时 path/source 为 null */
  resolveNaiveBinary: () => invoke<{ path: string | null; source: "explicit" | "bundled" | null }>("resolve_naive_binary"),
  /** 生效数据目录(便携模式下为 <程序目录>/data) */
  getDataDir: () => invoke<{ path: string; portable: boolean }>("get_app_dir"),
};

/** 订阅 Rust → UI 事件;返回取消函数 */
export async function listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (!hasTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const un = await listen<T>(event, (e) => handler(e.payload));
  return un;
}
