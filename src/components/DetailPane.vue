<script setup lang="ts">
import { computed, ref } from "vue";
import { NButton, NTabs, NTabPane } from "naive-ui";
import { useProfilesStore } from "../stores/profiles";
import { useRuntimeStore } from "../stores/runtime";
import { validateProfile } from "../lib/validate";
import IssueList from "./IssueList.vue";
import ServerForm from "./profile/ServerForm.vue";
import ListenEditor from "./profile/ListenEditor.vue";
import AdvancedForm from "./profile/AdvancedForm.vue";
import DebugForm from "./profile/DebugForm.vue";

const profilesStore = useProfilesStore();
const runtimeStore = useRuntimeStore();

/**
 * 用 string 而非联合字面量:naive 的 tabsProps 把 value 声明为 [String, Number],
 * onUpdate:value 传回 string | number,联合字面量会被 vue-tsc 判为不可赋值。
 */
const tab = ref<string>("server");
const profile = computed(() => profilesStore.current!);

const issues = computed(() => (profile.value ? validateProfile(profile.value) : []));
const readOnly = computed(() => !runtimeStore.canEdit);

const tabErrs = computed<Record<string, number>>(() => {
  const map: Record<string, number> = { server: 0, listen: 0, adv: 0, diag: 0 };
  for (const i of issues.value) {
    if (i.severity !== "error") continue;
    const key = i.kind === "listen" ? "listen" : i.kind === "hop" || i.kind === "chain" ? "server"
      : i.kind === "advanced" ? "adv" : i.kind === "debug" ? "diag" : "server";
    map[key] = (map[key] ?? 0) + 1;
  }
  return map;
});

/** 新建且未填 host → 显示新手引导 */
const isNewcomer = computed(() => profile.value?.server[0]?.host?.trim() === "");

async function save() {
  if (!profile.value) return;
  await profilesStore.save({ ...profile.value });
}
</script>

<template>
  <section class="detail">
    <!-- n-tabs 取代原手写 .tabs/.tab:原型 mockup.html 已验证的形态。
         :animated="false" 是关键 —— 它为 true 时 naive 才渲染 .n-tabs-pane-wrapper,
         为 false 时 .n-tab-pane 直接是 .n-tabs 的子元素(Tabs.mjs:864),
         所以滚动容器规则必须同时覆盖两者(见下方 CSS 踩坑记录)。
         pane-style="padding:0" 把内边距交给 .n-tab-pane 规则统一控制,避免双重 padding。 -->
    <n-tabs v-model:value="tab" type="line" size="small" :animated="false"
            class="detail-tabs" pane-style="padding:0">
      <template #suffix>
        <n-button size="tiny" :type="profilesStore.isDirty ? 'primary' : 'default'"
          :disabled="!profilesStore.isDirty || readOnly" @click="save">
          {{ profilesStore.isDirty ? "● 保存" : "已保存" }}
        </n-button>
      </template>

      <n-tab-pane name="server">
        <template #tab>服务器<span v-if="tabErrs.server" class="verr">({{ tabErrs.server }})</span></template>
        <!-- 锁定态按 pane 施加而非整个 tab-content:n-tab-pane 的 display-directive
             默认 "if"(TabPane.mjs:15),非活动 pane 不渲染,没有"4 个分支之后的共享底部"。
             诊断 pane 不加 .ro —— 运行中仍要能看日志(UI_SPEC §6)。 -->
        <div :class="{ ro: readOnly }">
          <div class="note-readonly" v-if="readOnly">🔒 运行中 — 配置已锁定,停止后可修改</div>
          <div v-if="isNewcomer" class="guide-card">
            <div class="guide-title">🚀 三步开始</div>
            <ol>
              <li>填<b>地址</b>:你的 NaïveProxy 服务器域名(如 <span class="kbd">example.com</span>)</li>
              <li>填<b>用户名/密码</b>:服务器管理员给你的凭据</li>
              <li>点底部 <b>➔ 连接</b>:状态变绿即成功,浏览器走 socks://127.0.0.1:1080</li>
            </ol>
            <div class="guide-tip">💡 只有分享链接?点左下角 <b>⤓ 导入</b> 一键填入</div>
          </div>
          <ServerForm :profile="profile" :issues="issues" @change="profilesStore.markDirty()" />
          <IssueList :issues="issues" />
        </div>
      </n-tab-pane>

      <n-tab-pane name="listen">
        <template #tab>本地监听<span v-if="tabErrs.listen" class="verr">({{ tabErrs.listen }})</span></template>
        <div :class="{ ro: readOnly }">
          <div class="note-readonly" v-if="readOnly">🔒 运行中 — 配置已锁定,停止后可修改</div>
          <ListenEditor :profile="profile" :issues="issues" @change="profilesStore.markDirty()" />
          <IssueList :issues="issues" />
        </div>
      </n-tab-pane>

      <n-tab-pane name="adv">
        <template #tab>高级</template>
        <div :class="{ ro: readOnly }">
          <div class="note-readonly" v-if="readOnly">🔒 运行中 — 配置已锁定,停止后可修改</div>
          <AdvancedForm :profile="profile" :issues="issues" @change="profilesStore.markDirty()" />
          <IssueList :issues="issues" />
        </div>
      </n-tab-pane>

      <n-tab-pane name="diag">
        <template #tab>诊断<span v-if="tabErrs.diag" class="verr">({{ tabErrs.diag }})</span></template>
        <DebugForm :profile="profile" :issues="issues" @change="profilesStore.markDirty()" />
        <IssueList :issues="issues" />
      </n-tab-pane>
    </n-tabs>
  </section>
</template>

<style scoped>
.detail { flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; }

/* ── n-tabs 高度链(踩坑记录,已在 mockup.html 用真实 Chrome 布局验证)──
   1. naive 不存在 .n-tabs-content 这个类,别去找它。
   2. .n-tabs-pane-wrapper 只在 :animated="true" 时渲染(Tabs.mjs:864);
      本组件 animated=false,所以 .n-tab-pane 是 .n-tabs 的直接子元素。
      两条规则都写,才能在改动 animated 后仍然正确滚动。
   3. scoped 样式只作用于本组件模板内的元素,naive 渲染的后代必须用 :deep()。
   4. 少了 min-height:0,flex 子项不会收缩,内容长时会把整个 detail 撑出滚动条。 */
.detail-tabs { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.detail-tabs :deep(.n-tabs-nav) { padding: 0 16px; flex-shrink: 0; }
.detail-tabs :deep(.n-tabs-pane-wrapper) { flex: 1; min-height: 0; overflow-y: auto; }
.detail-tabs :deep(.n-tab-pane) { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 20px !important; }

/* 运行中锁定:与原型同值(.ro) */
.ro { opacity: .5; pointer-events: none; }
.ro .note-readonly { pointer-events: none; }
.verr { color: var(--red); margin-left: 3px; font-size: 11px; }

.note-readonly { display: flex; align-items: center; gap: 8px; margin-bottom: 14px; padding: 8px 12px;
  background: var(--panel2); border: 1px dashed var(--border); border-radius: var(--radius);
  color: var(--text-dim); font-size: 12px; }
.guide-card { background: linear-gradient(135deg, rgba(32,128,240,.10), rgba(24,160,88,.08));
  border: 1px solid rgba(32,128,240,.35); border-radius: 10px; padding: 14px 18px; margin-bottom: 18px; }
.guide-title { font-weight: 700; font-size: 13.5px; margin-bottom: 10px; }
.guide-card ol { margin-left: 18px; display: flex; flex-direction: column; gap: 6px;
  color: var(--text-dim); font-size: 12.5px; }
.guide-card b { color: var(--text); }
.guide-tip { margin-top: 10px; padding-top: 10px; border-top: 1px dashed var(--border);
  color: var(--text-dim); font-size: 12px; }
.guide-tip b { color: var(--blue); }
.kbd { background: var(--panel2); border: 1px solid var(--border); border-radius: 4px;
  padding: 0 5px; font-size: 11px; font-family: Consolas, monospace; }
</style>
