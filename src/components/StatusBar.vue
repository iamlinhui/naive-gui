<script setup lang="ts">
import { computed, ref } from "vue";
import { NButton, NSwitch } from "naive-ui";
import { useProfilesStore } from "../stores/profiles";
import { useRuntimeStore } from "../stores/runtime";
import { useSettingsStore } from "../stores/settings";
import { renderConfig } from "../lib/render";

const profilesStore = useProfilesStore();
const runtimeStore = useRuntimeStore();
const settingsStore = useSettingsStore();

const toastMsg = ref("");
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(msg: string) {
  toastMsg.value = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toastMsg.value = ""), 2600);
}

const dotClass = computed(() =>
  runtimeStore.phase === "running" ? "green" :
  runtimeStore.phase === "starting" || runtimeStore.phase === "stopping" ? "yellow" :
  runtimeStore.phase === "failed" ? "red" : "",
);

const statusText = computed(() => {
  switch (runtimeStore.phase) {
    case "idle": return "未连接";
    case "starting": return "连接中…";
    case "running": return "运行中";
    case "stopping": return "停止中…";
    case "failed": return "连接失败";
  }
});

const statusColor = computed(() =>
  runtimeStore.phase === "running" ? "var(--green)" :
  runtimeStore.phase === "starting" || runtimeStore.phase === "stopping" ? "var(--yellow)" :
  runtimeStore.phase === "failed" ? "var(--red)" : "var(--text)",
);

const subText = computed(() => {
  if (runtimeStore.phase === "running" || runtimeStore.phase === "starting") {
    if (testFailText.value) return testFailText.value;
    const p = profilesStore.current;
    if (p) {
      const cfg = renderConfig(p);
      return cfg.listen.join(" · ");
    }
  }
  if (runtimeStore.phase === "failed") return runtimeStore.stopReason || "详见诊断日志";
  const v = settingsStore.naiveVersion;
  return v ? `naive v${v} · 配置就绪` : settingsStore.naiveBinary ? "naive 版本未知" : "未找到 naive.exe(程序目录/设置路径)";
});

const sysProxyOn = computed(() => !!settingsStore.sysproxy?.enable);

/** 测试未通过时的简短原因(状态栏第二行) */
const testFailText = computed(() => {
  const r = runtimeStore.lastReport;
  const l2 = r?.l2;
  if (!l2 || l2.result === "ok") return "";
  if (l2.result === "local-tcp-fail") return "测试失败:本地端口不可达";
  if (l2.result === "timeout") return "测试失败:超时";
  if (l2.result === "proxy-handshake-fail") return "测试失败:代理握手失败";
  return "测试失败:隧道错误";
});

async function mainAction() {
  const p = profilesStore.current;
  if (!p) return;
  if (runtimeStore.phase === "running" || runtimeStore.phase === "starting") {
    await runtimeStore.disconnect(true);
    toast("已停止连接,系统代理已还原");
  } else {
    const r = await runtimeStore.connect(p, {
      sysProxyBypass: settingsStore.settings.sysProxyBypass,
      autoSysProxy: settingsStore.settings.setSystemProxyOnConnect,
      onSysProxy: () => settingsStore.refreshSysproxy(),
    });
    if (r.ok) {
      toast("已连接" + (sysProxyOn.value ? " · 系统代理已开启" : ""));
      await runtimeStore.runTest(p.listen);
      await settingsStore.refreshSysproxy();
    } else {
      toast(r.issues.some((i) => i.severity === "error") ? "校验失败,请检查表单" : "连接失败,详见日志");
    }
  }
}

async function toggleSysProxy() {
  if (sysProxyOn.value) {
    await fetchSysproxy("disable");
  } else {
    const p = profilesStore.current;
    const httpEp = p?.listen.find((l) => l.proto === "http");
    if (!httpEp) {
      toast("需要 http 监听端点才能设置系统代理(本地监听 Tab 添加)");
      return;
    }
    await fetchSysproxy("enable");
  }
  await settingsStore.refreshSysproxy();
  toast(sysProxyOn.value ? "系统代理已开启" : "系统代理已还原");
}

async function fetchSysproxy(action: "enable" | "disable") {
  const { api } = await import("../lib/ipc");
  const p = profilesStore.current;
  const httpEp = p?.listen.find((l) => l.proto === "http");
  if (action === "enable" && httpEp) {
    await api.sysproxyEnable(httpEp.port, settingsStore.settings.sysProxyBypass);
  } else if (action === "disable") {
    await api.sysproxyDisable();
  }
}
</script>

<template>
  <footer class="statusbar">
    <div class="st-dot" :class="dotClass"></div>
    <div class="st-main">
      <div class="st-text" :style="{ color: statusColor }">{{ statusText }}</div>
      <div class="st-sub">{{ subText }}</div>
    </div>
    <span class="spacer"></span>
    <div class="sysproxy-toggle">
      <span>系统代理</span>
      <n-switch :value="sysProxyOn" size="small" :disabled="!runtimeStore.isRunning" @update:value="toggleSysProxy" />
    </div>
    <n-button v-if="runtimeStore.phase === 'starting' || runtimeStore.phase === 'stopping'"
      size="small" type="warning" disabled loading>
      {{ runtimeStore.phase === 'starting' ? '连接中…' : '停止中…' }}
    </n-button>
    <n-button size="small" type="error" secondary v-else-if="runtimeStore.phase === 'running'" @click="mainAction">
      ■ 断开
    </n-button>
    <n-button size="small" type="error" v-else-if="runtimeStore.phase === 'failed'" @click="mainAction">
      ↻ 重试
    </n-button>
    <n-button size="small" type="primary" v-else :disabled="runtimeStore.switching || !profilesStore.current" @click="mainAction">
      ▶ 连接
    </n-button>

    <div class="toast" v-if="toastMsg">{{ toastMsg }}</div>
  </footer>
</template>

<style scoped>
.statusbar { height: 62px; border-top: 1px solid var(--border); display: flex; align-items: center;
  gap: 12px; padding: 0 18px; flex-shrink: 0; position: relative; }
.st-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--text-faint); flex-shrink: 0; }
.st-dot.green { background: var(--green); box-shadow: 0 0 10px var(--green-glow); }
.st-dot.yellow { background: var(--yellow); animation: pulse 1.2s infinite; }
.st-dot.red { background: var(--red); }
@keyframes pulse { 50% { opacity: .3; } }
.st-main { min-width: 0; }
.st-text { font-weight: 600; }
.st-sub { font-size: 12px; color: var(--text-dim); font-family: Consolas, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 330px; }
/* 延迟徽章已移到侧栏列表上方(ProfileSidebar 的 .sidebar-status),此处不再重复 */
.sysproxy-toggle { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-dim);
  flex-shrink: 0; }
.toast { position: absolute; top: -44px; left: 50%; transform: translateX(-50%);
  background: var(--panel2); border: 1px solid var(--border); color: var(--text);
  padding: 8px 18px; border-radius: 8px; font-size: 12.5px; box-shadow: 0 8px 30px rgba(0,0,0,.4);
  white-space: nowrap; }
</style>
