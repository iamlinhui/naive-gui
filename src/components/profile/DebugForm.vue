<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { NInput, NButton, NSwitch, NModal, NCard, NSpace } from "naive-ui";
import { useRuntimeStore } from "../../stores/runtime";
import type { Profile } from "../../lib/schema";
import type { ValidationIssue } from "../../lib/validate";
const props = defineProps<{ profile: Profile; issues: ValidationIssue[] }>();
const emit = defineEmits<{ change: [] }>();
const runtimeStore = useRuntimeStore();

const logEl = ref<HTMLElement | null>(null);

watch(
  () => runtimeStore.logs.length,
  async () => {
    if (runtimeStore.autoScroll) {
      await nextTick();
      if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight;
    }
  },
);

function ts(t: number) {
  return new Date(t * 1000).toTimeString().slice(0, 8);
}

function lineCls(line: string) {
  // 必须用 includes 而非 startsWith:naive 真实 stderr 每行都带日志前缀,例如
  //   [1009/100614.068:INFO:naive_proxy_bin.cc(479)] Listening on socks://127.0.0.1:3080
  // 用 startsWith("Listening on ") 永远匹配不到,就绪行会被染成普通灰色,
  // 绿色"监听成功"高亮形同虚设(这也是后端就绪检测同样改用 contains 的原因)。
  if (line.includes("Listening on ")) return "ok";
  if (line.includes("Failed to listen") || line.includes("Invalid")) return "er";
  return "dim";
}

const testLine = () => {
  const r = runtimeStore.lastReport;
  if (!r) return "尚未测试";
  const l1 = r.l1.map((e) => `${e.proto}:${e.port} ${e.ok ? "✓" : "✕"}`).join(" / ");
  const l2 = r.l2
    ? r.l2.result === "ok"
      ? `隧道 ✓ ${r.l2.latencyMs}ms`
      : `隧道 ✕ ${r.l2.result}`
    : "未测";
  return `L1 [${l1}]  L2 ${l2}`;
};

/** 敏感开关:二次确认(UI_SPEC §7 / V-D-02) */
const pendingSens = ref<string | null>(null);
function sensToggle(key: "logNetLog" | "sslKeyLogFile", on: boolean) {
  if (on) {
    pendingSens.value = null; // 先不打开,等确认
    props.profile.debug[key] = "";
    emit("change");
    pendingSens.value = key;
  } else {
    props.profile.debug[key] = undefined;
    emit("change");
  }
}
const sensDesc: Record<string, string> = {
  logNetLog: "开启后完整的网络事件日志(含域名)将被写入文件。",
  sslKeyLogFile: "开启后所有 TLS 流量的密钥将被写入文件,持有该文件的任何人都可以用 Wireshark 解密你的全部流量。",
};
function confirmSens() {
  pendingSens.value = null;
}
function cancelSens() {
  if (pendingSens.value) {
    props.profile.debug[pendingSens.value as "logNetLog"] = undefined;
    emit("change");
  }
  pendingSens.value = null;
}
</script>

<template>
  <div class="logbar">
    <span class="ttl">日志 <span style="color: var(--text-faint); font-weight: 400; font-size: 11px">(naive stderr · 内存缓冲)</span></span>
    <n-button size="tiny" secondary @click="runtimeStore.autoScroll = !runtimeStore.autoScroll">
      {{ runtimeStore.autoScroll ? "⏸ 暂停滚动" : "▶ 恢复滚动" }}
    </n-button>
    <n-button size="tiny" secondary @click="runtimeStore.clearLogs()">清空</n-button>
  </div>
  <div class="log" ref="logEl">
    <div v-if="runtimeStore.logs.length === 0" class="empty-log">等待连接(日志仅存于内存,不落盘)</div>
    <div v-for="(l, i) in runtimeStore.logs" :key="i">
      <span class="ts">{{ ts(l.ts) }}</span><span :class="lineCls(l.line)">{{ l.line }}</span>
    </div>
  </div>

  <div class="card" style="margin-top: 14px">
    <div class="card-title">连通性测试</div>
    <div class="test-line">{{ testLine() }}</div>
  </div>

  <div class="sens-zone">
    <h4>⚠ 高敏感诊断选项 — 默认关闭</h4>
    <div class="sens-row">
      <span>NetLog</span><span class="desc">log-net-log,完整网络事件</span>
      <n-input v-model:value="profile.debug.logNetLog" placeholder="文件路径(空 = 不开启)" size="small"
        style="flex: 1" @update:value="(v: string) => { profile.debug.logNetLog = v || undefined; emit('change'); }" />
    </div>
    <div class="sens-row">
      <span>SSL 密钥日志</span><span class="desc">ssl-key-log-file,<b style="color: var(--red)">可解密全部流量</b></span>
      <n-input v-model:value="profile.debug.sslKeyLogFile" placeholder="文件路径(空 = 不开启)" size="small"
        style="flex: 1" @update:value="(v: string) => { profile.debug.sslKeyLogFile = v || undefined; emit('change'); }" />
    </div>
    <div class="sens-row">
      <span>禁用后量子密钥交换</span><span class="desc">no-post-quantum</span>
      <n-switch :value="!!profile.debug.noPostQuantum" size="small" style="margin-left: auto"
        @update:value="(v: boolean) => { profile.debug.noPostQuantum = v || undefined; emit('change'); }" />
    </div>
  </div>

  <n-modal :show="!!pendingSens" @update:show="(v: boolean) => { if (!v) cancelSens(); }">
    <n-card title="⚠ 开启敏感诊断?" style="width: 460px" :bordered="false" role="alert">
      <p style="color: var(--red); font-weight: 600; margin-bottom: 10px">
        开启 {{ pendingSens === "logNetLog" ? "NetLog" : "SSL 密钥日志" }}
      </p>
      <p class="desc-p">{{ pendingSens ? sensDesc[pendingSens] : "" }}</p>
      <p class="desc-p">该选项仅用于诊断,平时请保持关闭。确定开启?</p>
      <template #footer>
        <n-space justify="end">
          <n-button @click="cancelSens">取消</n-button>
          <n-button type="error" @click="confirmSens">确认开启</n-button>
        </n-space>
      </template>
    </n-card>
  </n-modal>
</template>

<style scoped>
.logbar { display: flex; gap: 6px; margin-bottom: 8px; align-items: center; }
.logbar .ttl { font-weight: 600; margin-right: auto; font-size: 13px; }
.log { background: var(--log-bg, #0c0c10); border: 1px solid var(--border); border-radius: var(--radius);
  height: 220px; overflow-y: auto; padding: 10px 12px;
  font-family: "Cascadia Code", Consolas, monospace; font-size: 12px; line-height: 1.75; }
.app.light .log, :global(.light) .log { background: #f4f5f7; }
.empty-log { color: var(--text-faint); }
.ts { color: var(--text-faint); margin-right: 8px; }
.ok { color: var(--green); }
.er { color: var(--red); }
.dim { color: var(--text-dim); }
.test-line { font-size: 12.5px; color: var(--text-dim); }
.sens-zone { border: 1px solid var(--yellow-border); background: var(--yellow-bg);
  border-radius: var(--radius); padding: 12px 14px; margin-top: 16px; }
.sens-zone h4 { color: var(--yellow); font-size: 12px; margin-bottom: 10px; }
.sens-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; font-size: 12px; }
.sens-row .desc { color: var(--text-dim); }
.desc-p { color: var(--text-dim); font-size: 12.5px; line-height: 1.7; margin-bottom: 10px; }
</style>
