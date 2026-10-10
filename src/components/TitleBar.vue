<script setup lang="ts">
import { useSettingsStore } from "../stores/settings";

const settingsStore = useSettingsStore();

async function minimize() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().minimize();
}
async function toggleMax() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().toggleMaximize();
}
async function closeApp() {
  // 关闭按钮不在此断开连接:交给后端 CloseRequested 按 minimize_to_tray 决策——
  // 「隐藏到托盘」需保持 naive 进程与系统代理后台续跑,故不能提前 disconnect。
  // 真正退出(未勾选托盘)时,后端 quit_app 会统一停进程 + 还原系统代理。
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}
</script>

<template>
  <header class="titlebar" data-tauri-drag-region>
    <span class="logo">N</span>
    <span class="name" data-tauri-drag-region>NaïveProxy 客户端</span>
    <span class="badge" v-if="settingsStore.naiveVersion" data-tauri-drag-region
      title="建议保持最新版本以匹配 Chrome 指纹">
      naive v{{ settingsStore.naiveVersion }}
    </span>
    <span class="spacer" data-tauri-drag-region></span>
    <button class="icon-btn" title="设置" @click="$emit('settings')">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    </button>
    <button class="wbtn" title="最小化" @click="minimize">
      <svg width="11" height="11" viewBox="0 0 11 11"><rect x="1" y="5" width="9" height="1.2" fill="currentColor" /></svg>
    </button>
    <button class="wbtn" title="最大化/还原" @click="toggleMax">
      <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.2">
        <rect x="1.5" y="1.5" width="8" height="8" />
      </svg>
    </button>
    <button class="wbtn close" title="关闭" @click="closeApp">
      <svg width="11" height="11" viewBox="0 0 11 11" fill="none" stroke="currentColor" stroke-width="1.2">
        <path d="M1.5 1.5 L9.5 9.5 M9.5 1.5 L1.5 9.5" />
      </svg>
    </button>
  </header>
</template>

<style scoped>
.titlebar { height: 40px; display: flex; align-items: center; gap: 10px; padding: 0 6px 0 14px;
  border-bottom: 1px solid var(--border); flex-shrink: 0; -webkit-user-select: none; }
.logo { width: 18px; height: 18px; border-radius: 5px;
  background: linear-gradient(135deg,#2080f0,#18a058);
  display: inline-flex; align-items: center; justify-content: center; color: #fff; font-size: 10px; font-weight: 700; }
.name { font-weight: 600; font-size: 12.5px; }
.badge { font-size: 11px; color: var(--text-dim); background: var(--panel2);
  border: 1px solid var(--border); padding: 2px 8px; border-radius: 10px; }
.spacer { flex: 1; }
.icon-btn { width: 30px; height: 30px; border-radius: 6px; border: none; background: transparent;
  color: var(--text-dim); cursor: pointer; margin-right: 4px;
  display: inline-flex; align-items: center; justify-content: center; }
.icon-btn:hover { background: var(--panel2); color: var(--text); }
.wbtn { width: 44px; height: 40px; border: none; background: transparent; color: var(--text-dim);
  cursor: pointer; display: inline-flex; align-items: center; justify-content: center; }
.wbtn:hover { background: var(--panel2); color: var(--text); }
.wbtn.close:hover { background: var(--red); color: #fff; }
</style>
