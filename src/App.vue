<script setup lang="ts">
import { onMounted, ref, computed, watch } from "vue";
import {
  NConfigProvider, NMessageProvider, darkTheme, zhCN, dateZhCN,
  type GlobalThemeOverrides,
} from "naive-ui";
import { useProfilesStore } from "./stores/profiles";
import { useRuntimeStore } from "./stores/runtime";
import { useSettingsStore } from "./stores/settings";
import TitleBar from "./components/TitleBar.vue";
import ProfileSidebar from "./components/ProfileSidebar.vue";
import DetailPane from "./components/DetailPane.vue";
import StatusBar from "./components/StatusBar.vue";
import SettingsDialog from "./views/SettingsDialog.vue";
import ImportDialog from "./views/ImportDialog.vue";

const profilesStore = useProfilesStore();
const runtimeStore = useRuntimeStore();
const settingsStore = useSettingsStore();

const showSettings = ref(false);
const showImport = ref(false);

/** Naive 主题:auto→跟随系统;dark/light 直接生效 */
const naiveTheme = computed(() => (settingsStore.effectiveTheme === "light" ? null : darkTheme));

/**
 * 主题对齐:表面色钉死到本应用色板(UI_SPEC §9),两套体系(自定义 CSS 变量 + Naive 主题)色值一致。
 * dark: panel #18181c / panel2 #232329 / border #2a2a30;text #ececef / dim #989ba3。
 * light: panel #ffffff / panel2 #eceef2 / border #e0e0e6。
 */
const themeOverrides = computed<GlobalThemeOverrides>(() => {
  const dark = settingsStore.effectiveTheme === "dark";
  const common = dark
    ? {
        // 暗色:对齐 #18a058 品牌绿 + 自有表面色板
        primaryColor: "#18a058",
        primaryColorHover: "#36ad6a",
        primaryColorPressed: "#0c7a43",
        primaryColorSuppl: "#18a058",
        borderRadius: "6px",
        bodyColor: "#101014",
        cardColor: "#18181c",
        modalColor: "#18181c",
        popoverColor: "#232329",
        inputColor: "#232329",
        actionColor: "#232329",
        tableColor: "#18181c",
        borderColor: "#2a2a30",
        dividerColor: "#2a2a30",
        textColorBase: "#ececef",
        textColor1: "#ececef",
        textColor2: "#ececef",
        textColor3: "#989ba3",
        placeholderColor: "#6b6e76",
        iconColor: "#989ba3",
      }
    : {
        // 亮色
        primaryColor: "#18a058",
        primaryColorHover: "#36ad6a",
        primaryColorPressed: "#0c7a43",
        primaryColorSuppl: "#18a058",
        borderRadius: "6px",
        bodyColor: "#f7f8fa",
        cardColor: "#ffffff",
        modalColor: "#ffffff",
        popoverColor: "#ffffff",
        inputColor: "#f4f5f7",
        actionColor: "#eceef2",
        tableColor: "#ffffff",
        borderColor: "#e0e0e6",
        dividerColor: "#e0e0e6",
        textColorBase: "#1f2329",
        textColor1: "#1f2329",
        textColor2: "#1f2329",
        textColor3: "#5f6368",
        placeholderColor: "#9aa0a8",
        iconColor: "#5f6368",
      };
  return { common };
});

/** 根 class:自定义 CSS 变量体系与 Naive 主题同步切换(单一真源 = effectiveTheme) */
const rootClass = computed(() => ({
  light: settingsStore.effectiveTheme === "light",
}));

/**
 * 屏蔽 WebView 默认右键菜单。
 * 例外:input / textarea / contenteditable 内保留原生菜单,否则用户无法复制粘贴。
 * 侧栏 Profile 行有自己的 contextmenu handler(openCtx)并已 .prevent,
 * 事件冒泡到这里再 prevent 一次无害,两者不冲突。
 */
function onGlobalContextMenu(e: MouseEvent) {
  const t = e.target as HTMLElement | null;
  if (t?.closest("input, textarea, [contenteditable='true']")) return;
  e.preventDefault();
}

/** body 底色同步(遮罩/滚动条缝隙不露底) */
watch(
  () => settingsStore.effectiveTheme,
  (t) => {
    if (typeof document !== "undefined") {
      document.body.classList.toggle("light-root", t === "light");
    }
  },
  { immediate: true },
);

onMounted(async () => {
  await settingsStore.load();
  await settingsStore.init();
  await profilesStore.load();
  await runtimeStore.init();
});
</script>

<template>
  <n-config-provider
    :theme="naiveTheme"
    :theme-overrides="themeOverrides"
    :locale="zhCN"
    :date-locale="dateZhCN"
    class="provider-root"
  >
    <n-message-provider placement="bottom">
      <div class="app" :class="rootClass" @contextmenu="onGlobalContextMenu">
        <TitleBar @settings="showSettings = true" />

        <div class="body">
          <ProfileSidebar @import="showImport = true" />
          <DetailPane v-if="profilesStore.current" />
          <div v-else class="empty">
            <div class="empty-art">🛡</div>
            <p>还没有服务器配置</p>
            <n-button type="primary" @click="profilesStore.create()">＋ 新建配置</n-button>
            <n-button quaternary @click="showImport = true">⤓ 导入分享链接</n-button>
          </div>
        </div>

        <StatusBar />

        <SettingsDialog v-if="showSettings" @close="showSettings = false" />
        <ImportDialog v-if="showImport" @close="showImport = false" />
      </div>
    </n-message-provider>
  </n-config-provider>
</template>

<style>
/* 全局基础 = mockup.html 的设计体系(UI_SPEC §9),与 Naive UI 暗色主题同源(#18a058/#101014) */
:root {
  --bg: #101014; --panel: #18181c; --panel2: #232329; --border: #2a2a30;
  --text: #ececef; --text-dim: #989ba3; --text-faint: #6b6e76;
  --green: #18a058; --green-glow: rgba(24,160,88,.45);
  --blue: #2080f0; --red: #d03050; --yellow: #f0a020;
  --yellow-bg: rgba(240,160,32,.08); --yellow-border: rgba(240,160,32,.35);
  --radius: 8px; --ctrl-h: 28px;
  --sidebar-active: rgba(32,128,240,.16);
}
.app.light,
body.light-root {
  --bg: #f7f8fa; --panel: #ffffff; --panel2: #eceef2; --border: #e0e0e6;
  --text: #1f2329; --text-dim: #5f6368; --text-faint: #9aa0a8;
  --green-glow: rgba(24,160,32,.3);
  --sidebar-active: rgba(32,128,240,.12);
  --log-bg: #f4f5f7;
}
/* 暗色默认补充变量 */
:root { --log-bg: #0c0c10; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body, #app { height: 100%; }
body {
  background: var(--bg); color: var(--text);
  font-family: "Inter","SF Pro Text","HarmonyOS Sans SC","Microsoft YaHei",system-ui,sans-serif;
  font-size: 13px; overflow: hidden; user-select: none;
}/* 亮色时 body 底色跟随,避免弹窗/遮罩缝隙露暗底;变量也挂 body 供 teleport 弹窗继承 */
body.light-root { background: #f7f8fa; color: #1f2329; }
.provider-root { height: 100%; }
.app { height: 100vh; display: flex; flex-direction: column; background: var(--panel); }
.body { flex: 1; display: flex; min-height: 0; }
.empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; }
.empty-art { font-size: 42px; opacity: .5; }
.empty p { color: var(--text-dim); }
/* 弹性占位:必须全局 —— mockup.html 里它是页面级规则,而 TitleBar.vue 的是 scoped,
   只对 TitleBar 生效。StatusBar 也用 class="spacer" 把主按钮推到最右,
   没有这条全局规则 flex:1 不生效,按钮就会紧贴状态文字而不是贴右边。 */
.spacer { flex: 1; }
.field-row { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
.field-row:last-child { margin-bottom: 0; }
/* 必须用 `.field-row > label`(直接子元素):naive-ui 的 n-radio-button 根元素本身就是 <label>
   (RadioButton.mjs:16),后代选择器会把 width:52px / text-align:right / flex-shrink:0 强加到
   分段按钮上,按钮被压成等宽 52px、内容区仅剩 ~24px,"跟随系统"这类四字标签需 64px,
   配合 overflow:visible 便向右突出到按钮边框外。手写 label 是 .field-row 直接子元素,
   naive 的按钮嵌在 .n-radio-group 内,故 > 可精准区分。当前 app 全部 9 个 label 均为直接子元素。 */
.field-row > label { width: 52px; color: var(--text-dim); text-align: right; flex-shrink: 0;
  font-size: 12.5px; line-height: 1.35; }
/* 宽标签变体:高级/诊断页字段名较长(extra-headers 等),label 宽度放宽到 130px */
.field-row.wide > label { width: 130px; }
.card { background: var(--panel2); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 16px 18px; margin-bottom: 16px; }
.card:last-child { margin-bottom: 0; }
.card-title { font-size: 13.5px; font-weight: 600; margin-bottom: 14px; display: flex;
  align-items: center; gap: 8px; letter-spacing: .2px; }
.hint { font-size: 12px; color: var(--text-faint); }
.hint.err { color: var(--red); }
.note { font-size: 12px; color: var(--text-faint); margin-top: 12px; line-height: 1.7; }
.warnbar { display: flex; gap: 8px; align-items: flex-start; padding: 8px 12px; border-radius: 6px;
  font-size: 12px; margin: 4px 0 14px; }
.warnbar.y { background: var(--yellow-bg); border: 1px solid var(--yellow-border); color: var(--yellow); }
.warnbar.r { background: rgba(208,48,80,.08); border: 1px solid rgba(208,48,80,.4); color: var(--red); }
.warnbar i { font-style: normal; flex-shrink: 0; }

/* ── 按钮/分段控件 ──
   原先这里有手写的 .btn-sm / .btn-icon / .seg / .tpl-btns 四组原语,
   现已全部改用 naive 组件:n-button(size tiny/small、circle、dashed、:type)、
   n-radio-group + n-radio-button(协议分段)、n-button-group(监听模板)。
   与 mockup.html 原型保持一致,不再维护平行的手写 CSS。
   注意:.tpl-btns 移到了 ListenEditor.vue 的 scoped 样式里(唯一使用者)。 */

::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: var(--border); border-radius: 4px; }
::-webkit-scrollbar-track { background: transparent; }
</style>
