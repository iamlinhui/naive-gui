<script setup lang="ts">
import { computed, ref } from "vue";
import { NButton, NEmpty, NModal, NCard, NSpace, NDropdown, NInput, useMessage, type DropdownOption } from "naive-ui";
import { useProfilesStore } from "../stores/profiles";
import { useRuntimeStore } from "../stores/runtime";
import { useSettingsStore } from "../stores/settings";

const emit = defineEmits<{ import: [] }>();
const profilesStore = useProfilesStore();
const runtimeStore = useRuntimeStore();
const settingsStore = useSettingsStore();
const message = useMessage();

const dotClass = computed(() => {
  if (!runtimeStore.isRunning && runtimeStore.phase !== "starting") return "";
  return runtimeStore.phase === "running" ? "green" : runtimeStore.phase === "starting" ? "yellow" : "red";
});

/* ── 连接状态条(配置列表上方):状态点 + 文字 + 延迟徽章 ──
   延迟徽章从底部状态栏挪到这里(UI_SPEC §3):与列表同视野,看谁在跑时顺带看到耗时。
   徽章靠 .show(visibility)控制显隐,不清 DOM 避免布局跳动;断开时 lastReport
   已在 runtimeStore 置空(applyState),徽章随之消失,不留陈旧值。 */
const statusText = computed(() => {
  switch (runtimeStore.phase) {
    case "idle": return "未连接";
    case "starting": return "连接中…";
    case "running": return "运行中";
    case "stopping": return "停止中…";
    case "failed": return "连接失败";
  }
});
const statusCls = computed(() =>
  runtimeStore.phase === "running" ? "on" :
  runtimeStore.phase === "starting" || runtimeStore.phase === "stopping" ? "busy" :
  runtimeStore.phase === "failed" ? "err" : "",
);
const latency = computed(() => {
  const r = runtimeStore.lastReport;
  if (r?.l2?.result === "ok") return r.l2.latencyMs;
  return null;
});
/** 配色阈值与 mockup.html 的 latCls 同源:<200 good / <400 mid / 其余 bad */
const latCls = computed(() => {
  const v = latency.value;
  if (v === null) return "";
  return v < 200 ? "good" : v < 400 ? "mid" : "bad";
});

/** 点击其他 Profile:运行中 = 一键切换(停旧启新),空闲 = 仅选中 */
async function switchTo(id: string) {
  if (runtimeStore.isBusy) return;
  if (id === profilesStore.currentId) return;
  profilesStore.select(id);
  if (runtimeStore.phase === "running" || runtimeStore.phase === "starting") {
    const next = profilesStore.current;
    if (next) {
      await runtimeStore.switchTo(next, {
        sysProxyBypass: settingsStore.settings.sysProxyBypass,
        autoSysProxy: settingsStore.settings.setSystemProxyOnConnect,
      });
    }
  }
}

/* ── 删除:确认弹窗 ── */
const confirmDelId = ref<string | null>(null);
const confirmDelName = computed(() =>
  profilesStore.profiles.find((x) => x.id === confirmDelId.value)?.name ?? "",
);

async function doDelete() {
  const id = confirmDelId.value;
  if (!id) return;
  const name = confirmDelName.value;
  confirmDelId.value = null;
  if (runtimeStore.activeProfileId === id && runtimeStore.isRunning) {
    await runtimeStore.disconnect(true);
  }
  await profilesStore.remove(id);
  message.success(`已删除「${name}」`);
}

/* ── HTML5 原生拖拽排序 ──
   结构:外层 .profile-row(不可拖,承载 dragover/drop 与插入指示线) > 内层 .profile(可拖)。
   右键菜单用 trigger="manual" + 绝对坐标的共享单例,不在每行渲染 trigger,
   因此不会给 .profile-row 插入包裹元素、也不影响 drop 指示线的定位。 */
const dragId = ref<string | null>(null);
const overIndex = ref<number | null>(null);

function onDrop(index: number) {
  if (dragId.value) {
    profilesStore.reorder(dragId.value, index);
  }
  dragId.value = null;
  overIndex.value = null;
}
function onDragEnd() {
  dragId.value = null;
  overIndex.value = null;
}
function onDragOver(index: number) {
  overIndex.value = index;
}
/** 离开该行时清掉指示线(用函数而非模板内联赋值,避免依赖编译器对 ref 的处理) */
function onDragLeave(index: number) {
  if (overIndex.value === index) overIndex.value = null;
}

/* ── 右键菜单(UI_SPEC §8:重命名入口)──
   ✕ 快捷删除按钮已移除:删除统一走右键菜单 + 二次确认,避免误点毁数据。
   naive 的 onClick 绑在 .n-dropdown-option-body(子元素)上,用 @select 事件拿 key 即可,
   不需要自己找 DOM。注意 key 类型是 string | number(DropdownOption 的定义),不能窄化成 string。 */
const ctxShow = ref(false);
const ctxX = ref(0);
const ctxY = ref(0);
const ctxTargetId = ref<string | null>(null);

/** 目标档案是否正在运行(naive 只在它的监听端口上跑,故只有运行中的档案可测) */
const ctxTargetRunning = computed(
  () => runtimeStore.isRunning && runtimeStore.activeProfileId === ctxTargetId.value,
);

/* 「测试连通性」从状态栏挪到这里(UI_SPEC §8.1),按用户要求收进右键菜单。
   非运行档案置灰而非隐藏:让用户知道有此功能、也知道为何不可点(提示在测试时给出)。 */
const ctxOptions = computed<DropdownOption[]>(() => [
  { label: "测试连通性", key: "test", disabled: !ctxTargetRunning.value },
  { type: "divider", key: "d0" },
  { label: "重命名", key: "rename" },
  { label: "复制档案", key: "duplicate" },
  { type: "divider", key: "d1" },
  { label: "删除", key: "delete" },
]);

function openCtx(e: MouseEvent, id: string) {
  ctxTargetId.value = id;
  ctxX.value = e.clientX;
  ctxY.value = e.clientY;
  ctxShow.value = true;
}
function onCtxSelect(key: string | number) {
  ctxShow.value = false;
  const id = ctxTargetId.value;
  if (!id) return;
  if (key === "test") void testConnectivity(id);
  else if (key === "rename") openRename(id);
  else if (key === "duplicate") doDuplicate(id);
  else if (key === "delete") confirmDelId.value = id;
}

/** 端到端连通性测试:本地端口可达(L1)+ 隧道握手(L2),结果写 lastReport 供侧栏顶部延迟徽章显示 */
async function testConnectivity(id: string) {
  const p = profilesStore.profiles.find((x) => x.id === id);
  if (!p) return;
  if (!ctxTargetRunning.value) {
    message.warning("请先连接该配置后再测试");
    return;
  }
  message.info("测试中…");
  const r = await runtimeStore.runTest(p.listen);
  const l2 = r?.l2;
  if (!l2) return;
  // 用 switch 穷尽 TestResult 的 5 个分支:TS 对每个 case 精确收窄,
  // 不会出现 "detail" in l2 恒真导致 else 分支 l2 被收窄成 never 的问题。
  switch (l2.result) {
    case "ok":
      message.success(`✓ 隧道连通 ${l2.latencyMs}ms`);
      break;
    case "local-tcp-fail":
      message.error("✕ 本地端口不可达");
      break;
    case "timeout":
      message.error("✕ 超时(隧道无响应)");
      break;
    case "proxy-handshake-fail":
      message.error("✕ 代理握手失败");
      break;
    case "tunnel-error":
      message.error(`✕ 隧道失败:${l2.detail}`);
      break;
  }
}

function doDuplicate(id: string) {
  const dup = profilesStore.duplicate(id);
  if (!dup) {
    message.error("复制失败:找不到该档案");
    return;
  }
  profilesStore.select(dup.id);
  message.success(`已复制为「${dup.name}」`);
}

/* ── 重命名 modal(§8:名称输入,enter 确认)──
   校验由 store 统一负责(空名违反 zod 的 name.min(1),重名会让列表无法区分),
   组件只把失败原因渲染成行内报错,不弹 general error。 */
const renameId = ref<string | null>(null);
const renameValue = ref("");
const renameErr = ref("");

function openRename(id: string) {
  const p = profilesStore.profiles.find((x) => x.id === id);
  if (!p) return;
  renameId.value = id;
  renameValue.value = p.name;
  renameErr.value = "";
}

function doRename() {
  const id = renameId.value;
  if (!id) return;
  const next = renameValue.value.trim();
  const r = profilesStore.rename(id, renameValue.value);
  if (!r.ok) {
    renameErr.value = r.message;
    return;
  }
  renameId.value = null;
  renameErr.value = "";
  if (r.changed) message.success(`已重命名为「${next}」`);
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-head">配置档案 <span class="drag-tip">拖动排序 · 右键更多</span></div>
    <!-- 连接状态条:列表上方,状态点 + 文字 + 延迟徽章(UI_SPEC §3) -->
    <div class="sidebar-status" :class="statusCls">
      <span class="ss-dot"></span>
      <span class="ss-text">{{ statusText }}</span>
      <span class="latency" :class="[latCls, latency !== null ? 'show' : '']">{{ latency }} ms</span>
    </div>
    <div class="profile-list">
      <div
        v-for="(p, i) in profilesStore.profiles"
        :key="p.id"
        class="profile-row"
        :class="{ 'drop-before': overIndex === i && dragId !== null && dragId !== p.id }"
        @dragover.prevent="onDragOver(i)"
        @dragleave="onDragLeave(i)"
        @drop.prevent="onDrop(i)"
        @contextmenu.prevent="openCtx($event, p.id)"
      >
        <div
          class="profile"
          :class="{
            active: p.id === profilesStore.currentId,
            dragging: dragId === p.id,
          }"
          draggable="true"
          @dragstart="dragId = p.id"
          @dragend="onDragEnd"
          @click="switchTo(p.id)"
        >
          <div class="dot" :class="p.id === profilesStore.currentId ? dotClass : ''"></div>
          <div class="meta">
            <div class="pname">{{ p.name }}</div>
            <div class="phost">{{ p.server[0]?.host || "未设置服务器" }}</div>
          </div>
        </div>
      </div>

      <n-empty v-if="profilesStore.profiles.length === 0" description="还没有配置,点下方新建" size="small" style="margin: 24px 0" />
    </div>

    <div class="sidebar-foot">
      <n-button size="small" secondary style="flex: 1" @click="emit('import')">⤓ 导入</n-button>
      <n-button size="small" secondary style="flex: 1" @click="profilesStore.create()">＋ 新建</n-button>
    </div>

    <!-- 共享右键菜单:manual + 绝对坐标,不给每行渲染 trigger 包裹元素 -->
    <n-dropdown
      trigger="manual"
      :show="ctxShow"
      :x="ctxX"
      :y="ctxY"
      :options="ctxOptions"
      @select="onCtxSelect"
      @clickoutside="ctxShow = false"
    />

    <n-modal :show="renameId !== null" @update:show="(v: boolean) => { if (!v) { renameId = null; renameErr = ''; } }">
      <n-card title="重命名档案" style="width: 400px" :bordered="false" closable @close="renameId = null">
        <n-input
          v-model:value="renameValue"
          placeholder="配置档案名称"
          :status="renameErr ? 'error' : undefined"
          @keyup.enter="doRename"
        />
        <div class="row-err" v-if="renameErr">{{ renameErr }}</div>
        <template #footer>
          <n-space justify="end">
            <n-button size="small" @click="renameId = null">取消</n-button>
            <n-button size="small" type="primary" @click="doRename">确定</n-button>
          </n-space>
        </template>
      </n-card>
    </n-modal>

    <n-modal :show="confirmDelId !== null" @update:show="(v: boolean) => { if (!v) confirmDelId = null; }">
      <n-card title="删除配置?" style="width: 400px" :bordered="false" closable @close="confirmDelId = null">
        <p class="del-p">「<b>{{ confirmDelName }}</b>」将被删除,此操作不可撤销。</p>
        <template #footer>
          <n-space justify="end">
            <n-button size="small" @click="confirmDelId = null">取消</n-button>
            <n-button size="small" type="error" @click="doDelete">删除</n-button>
          </n-space>
        </template>
      </n-card>
    </n-modal>
  </aside>
</template>

<style scoped>
.sidebar { width: 232px; border-right: 1px solid var(--border); display: flex; flex-direction: column; flex-shrink: 0;
  background: var(--bg); }
.sidebar-head { padding: 12px 14px 6px; font-size: 11px; color: var(--text-faint); letter-spacing: .5px;
  display: flex; justify-content: space-between; align-items: baseline; }
.drag-tip { font-size: 10px; opacity: .7; }
/* ── 连接状态条(列表上方)── */
.sidebar-status { display: flex; align-items: center; gap: 8px; padding: 7px 14px;
  border-bottom: 1px solid var(--border); font-size: 12px; color: var(--text-dim); }
.ss-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-faint); flex-shrink: 0; }
.ss-text { flex: 1; }
.sidebar-status.on .ss-dot { background: var(--green); box-shadow: 0 0 8px var(--green-glow); }
.sidebar-status.on .ss-text { color: var(--green); font-weight: 600; }
.sidebar-status.busy .ss-dot { background: var(--yellow); animation: pulse 1.2s ease-in-out infinite; }
.sidebar-status.err .ss-dot { background: var(--red); }
.sidebar-status.err .ss-text { color: var(--red); }
/* 延迟徽章:visibility 切换而非 DOM 增删,避免布局跳动(与原型 latCls 同阈值) */
.latency { padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600;
  visibility: hidden; flex-shrink: 0; }
.latency.show { visibility: visible; }
.latency.good { color: var(--green); background: rgba(24,160,88,.12); }
.latency.mid { color: var(--yellow); background: var(--yellow-bg); }
.latency.bad { color: var(--red); background: rgba(208,48,80,.12); }
.profile-list { flex: 1; overflow-y: auto; padding-bottom: 4px; }
.profile-row { position: relative; margin: 2px 8px; }
.profile-row.drop-before::before { content: ''; position: absolute; left: 0; right: 0; top: -3px;
  height: 2px; background: var(--blue); border-radius: 1px; z-index: 1; }
/* padding-right 由 22px 收回为 12px:原先那 22px 是给已移除的 ✕ 快捷删除按钮让位的 */
.profile { display: flex; align-items: center; gap: 10px; padding: 9px 12px;
  cursor: grab; border-radius: 7px; border: 1px solid transparent; user-select: none; }
.profile:active { cursor: grabbing; }
.profile:hover { background: var(--panel2); }
.profile.active { background: var(--sidebar-active); border-color: rgba(32,128,240,.4);
  box-shadow: inset 2px 0 0 var(--blue); }
.profile.dragging { opacity: .35; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-faint); flex-shrink: 0; }
.dot.green { background: var(--green); box-shadow: 0 0 8px var(--green-glow); }
.dot.yellow { background: var(--yellow); animation: pulse 1.2s ease-in-out infinite; }
.dot.red { background: var(--red); }
@keyframes pulse { 50% { opacity: .3; } }
.meta { flex: 1; min-width: 0; }
.pname { color: var(--text); font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.profile.active .pname { color: var(--blue); font-weight: 600; }
.phost { color: var(--text-dim); font-size: 11px; margin-top: 2px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: Consolas, monospace; }
.del-p { color: var(--text-dim); font-size: 12.5px; line-height: 1.7; }
.del-p b { color: var(--text); }
.row-err { color: var(--red); font-size: 12px; margin-top: 6px; }
.sidebar-foot { margin-top: auto; padding: 10px 14px; display: flex; gap: 8px; border-top: 1px solid var(--border); }
</style>
