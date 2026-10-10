/**
 * runtimeStore:订阅 runtime:state / runtime:log,派生 UI 状态(UI_SPEC §3 状态矩阵)。
 */
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { api, listen, type RuntimeState, type LogEvent, type TestReport } from "../lib/ipc";
import type { ListenEndpoint, Profile } from "../lib/schema";
import { renderConfigJson } from "../lib/render";
import { validateProfile, hasErrors } from "../lib/validate";

const LOG_RING = 5000;

/** 诊断轨迹:控制台 + invoke 落盘 ui.log(与后端 state.log 对账,定位事件丢失) */
function trace(line: string) {
  if (import.meta.env.DEV) console.log(`[runtime-trace] ${line}`);
  void api.appTrace(line).catch(() => {});
}

type Phase = "idle" | "starting" | "running" | "stopping" | "failed";

export const useRuntimeStore = defineStore("runtime", () => {
  const phase = ref<Phase>("idle");
  const activeProfileId = ref<string | null>(null);
  const stopReason = ref<string>("");
  const logs = ref<{ ts: number; line: string }[]>([]);
  const autoScroll = ref(true);
  const lastReport = ref<TestReport | null>(null);

  /** 连接动作发起后置位,防止 UI 重入 */
  const switching = ref(false);

  const isRunning = computed(() => phase.value === "running");
  const isBusy = computed(() => phase.value === "starting" || phase.value === "stopping" || switching.value);
  const canEdit = computed(() => phase.value === "idle" || phase.value === "failed");

  /** 用户主动放弃(重试按钮/停止后):屏蔽后台自动重启的 starting 事件,直到下一次手动连接 */
  let suppressAutoRestart = false;

  function applyState(s: RuntimeState) {
    // 轨迹落盘:与后端 state.log 对账,判断事件是否真的到达 WebView
    trace(`apply ${s.state}${"reason" in s ? `(${s.reason})` : ""} suppress=${suppressAutoRestart}`);
    switch (s.state) {
      case "idle":
        phase.value = "idle";
        activeProfileId.value = null;
        lastReport.value = null; // 断开:清掉旧延迟徽章(侧栏顶部),避免陈旧值
        break;
      case "starting":
        // 自动重启的 starting:若用户已主动放弃(点过停止/重试失败),不再接管 UI
        if (suppressAutoRestart) break;
        phase.value = "starting";
        activeProfileId.value = s.profileId;
        break;
      case "running":
        if (suppressAutoRestart) break;
        phase.value = "running";
        activeProfileId.value = s.profileId;
        break;
      case "stopping":
        phase.value = "stopping";
        break;
      case "stopped":
        // user 停止 → idle;crash(退避重试中/放弃)与 failed-to-start → failed,
        // UI 显示「↻ 重试」,避免退避期间按钮在 处理中/连接 间振荡。
        phase.value = s.reason === "user" ? "idle" : "failed";
        activeProfileId.value = null;
        lastReport.value = null; // 进程已退出,旧延迟徽章一并清掉
        stopReason.value =
          s.reason === "crash" ? `进程异常退出(exit=${s.exitCode ?? "?"}),自动重启中` :
          s.reason === "failed-to-start" ? "启动失败(详见日志)" : "";
        if (s.reason === "user") suppressAutoRestart = false;
        break;
    }
  }

  async function init() {
    await listen<RuntimeState>("runtime:state", applyState);
    await listen<LogEvent>("runtime:log", (ev) => {
      logs.value.push({ ts: ev.ts, line: ev.line });
      if (logs.value.length > LOG_RING) logs.value.splice(0, logs.value.length - LOG_RING);
    });
    trace("init: state/log listeners registered");
    // 断线重连/刷新后拉取当前状态(§8.1)
    try {
      applyState(await api.runtimeStatus());
    } catch {
      /* 非 Tauri 环境忽略 */
    }
  }

  async function connect(profile: Profile, opts: { sysProxyBypass: string; autoSysProxy: boolean; onSysProxy?: (on: boolean) => void }) {
    const issues = validateProfile(profile);
    if (hasErrors(issues)) {
      return { ok: false as const, issues };
    }
    if (phase.value !== "idle" && phase.value !== "failed") {
      return { ok: false as const, issues: [{ code: "BUSY", severity: "error" as const, kind: "profile" as const, message: "已有连接,请先停止" }] };
    }
    switching.value = true;
    suppressAutoRestart = false; // 用户主动连接:恢复事件接收
    logs.value = [];
    lastReport.value = null; // 新一轮连接:旧延迟徽章失效
    stopReason.value = "";
    try {
      const configJson = renderConfigJson(profile);
      const listen: ListenEndpoint[] = profile.listen.map((l) => ({ proto: l.proto, addr: l.addr, port: l.port }));
      trace(`connect:start profile=${profile.id}`);
      await api.startRuntime(profile.id, configJson, listen, true);
      trace(`connect:startRuntime returned, phase=${phase.value}`);
      // ★ 竞态修复:invoke 往返期间 Rust 的 starting/running/stopped 事件可能已先到达。
      // naive 就绪仅需 ~2ms("Listening on" 秒出),running 常在 startRuntime 返回前就绪;
      // 若这里无条件覆写回 starting,后续再无第二个事件 → UI 永远卡「处理中」。
      // (as Phase 显式拓宽:避开函数头 guard 跨 await 残留的旧窄化)
      const cur = phase.value as Phase;
      if (cur !== "running" && cur !== "failed") {
        phase.value = "starting";
      }
      activeProfileId.value = profile.id;
      const ok = await waitRunning(profile.id, 15000);
      trace(`connect:waitRunning ok=${ok} phase=${phase.value}`);
      if (!ok) {
        suppressAutoRestart = true; // 不再被后台重启的 starting/running 接管 UI
        // 兜底:15s 内始终未到 running(也未收到 failed 事件)时,不能把 UI
        // 留在 starting —— 否则状态栏永远是「处理中」。落成 failed 展示「重试」。
        if (phase.value === "starting") {
          phase.value = "failed";
          if (!stopReason.value) stopReason.value = "启动超时(15s 未就绪),详见诊断日志";
          trace(`connect:timeout fallback → failed`);
        }
      }
      if (ok && opts.autoSysProxy) {
        const httpEp = profile.listen.find((l) => l.proto === "http");
        if (httpEp) {
          await api.sysproxyEnable(httpEp.port, opts.sysProxyBypass);
          opts.onSysProxy?.(true);
        }
      }
      return { ok, issues };
    } catch (e) {
      // Tauri invoke 以 {code,message} 对象 reject;String(e) 会变 "[object Object]",
      // 必须提取 message(如「本地监听端口 3080 已被占用」)才有诊断价值。
      const err = e as { message?: string } | string;
      const msg = typeof err === "string" ? err : (err?.message ?? JSON.stringify(e));
      trace(`connect:startRuntime rejected: ${msg}`);
      stopReason.value = msg;
      phase.value = "failed";
      return { ok: false as const, issues: [] };
    } finally {
      switching.value = false;
    }
  }

  /**
   * 等待就绪:事件优先,每 500ms 轮询 Rust 权威状态兜底。
   * 动机(实测):`runtime:state` 事件在某些时序下不到达 WebView(naive 2ms 就绪,
   * running 事件丢失 → UI 永远卡「处理中」)。invoke 通道本身可靠(start_runtime
   * 能落地),故轮询 runtime_status 做真相校准 —— 即使事件桥完全失效,
   * UI 也会在 ≤500ms 内收敛到真实状态。
   */
  async function waitRunning(profileId: string, timeoutMs: number): Promise<boolean> {
    const t0 = Date.now();
    for (;;) {
      // 事件路径若可用,phase 早已推进 → 立即返回
      if (phase.value === "running" && activeProfileId.value === profileId) return true;
      if (phase.value === "failed" || phase.value === "idle") return false;
      // 轮询权威状态(失败不致命,继续等事件)
      try {
        const s: RuntimeState = await api.runtimeStatus();
        if (s.state === "running" || s.state === "stopped" || s.state === "idle") {
          applyState(s);
          if (s.state === "running") {
            trace(`waitRunning: poll → running(${s.profileId})`);
            return true;
          }
          if (s.state === "stopped" || s.state === "idle") return false; // applyState 已落 failed/idle
        }
      } catch { /* IPC 不可用:退回事件驱动 */ }
      if (Date.now() - t0 > timeoutMs) return false;
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  async function disconnect(restoreSysProxy = true) {
    suppressAutoRestart = true; // 停止:屏蔽退避重启的 starting 事件
    switching.value = true;
    try {
      await api.stopRuntime();
    } finally {
      switching.value = false;
    }
    if (restoreSysProxy) {
      try {
        await api.sysproxyDisable();
      } catch { /* 快照不存在则忽略 */ }
    }
    phase.value = "idle";
    stopReason.value = "";
  }

  /**
   * 运行中切换到新 Profile:停旧(含还原系统代理)→ 选中新 → 启新。
   * UI 层唯一入口;Sidebar 点击即调,无需先手动停止。
   */
  async function switchTo(
    next: Profile,
    opts: { sysProxyBypass: string; autoSysProxy: boolean; onSysProxy?: (on: boolean) => void },
  ) {
    if (phase.value === "running" || phase.value === "starting") {
      await disconnect(true);
    }
    return connect(next, opts);
  }

  async function runTest(listen: ListenEndpoint[]) {
    lastReport.value = await api.testConnectivity(
      listen.map((l) => ({ proto: l.proto, addr: l.addr, port: l.port })),
    );
    return lastReport.value;
  }

  function clearLogs() {
    logs.value = [];
  }

  return {
    phase, activeProfileId, stopReason, logs, autoScroll, lastReport, switching,
    isRunning, isBusy, canEdit,
    init, connect, disconnect, switchTo, runTest, clearLogs,
  };
});
