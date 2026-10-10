<script setup lang="ts">
import { computed, ref } from "vue";
import { NInputNumber, NInput } from "naive-ui";
import type { Profile } from "../../lib/schema";
import type { ValidationIssue } from "../../lib/validate";
import { renderConfigJson } from "../../lib/render";

const props = defineProps<{ profile: Profile; issues: ValidationIssue[] }>();
const emit = defineEmits<{ change: [] }>();

const showMore = ref(false);
const showPreview = ref(false);

/**
 * 原始 config.json 只读预览(原型高级 Tab 第三折叠项)。
 * renderConfigJson 是纯函数(DESIGN.md §4.3),computed 随编辑实时重算 ——
 * 让用户在连接前就能核对将写入 naive 的确切 JSON(尤其 multi 模式下 listen↔chains 的配对顺序)。
 * 注意:这是"将要写入"的预览,不是磁盘上已保存的内容(未保存的改动也会反映)。
 */
const previewJson = computed(() => renderConfigJson(props.profile));
</script>

<template>
  <div class="card">
    <div class="card-title">连接调优 <span class="hint" style="margin: 0">留空 = 使用 naive 默认值</span></div>
    <div class="field-row wide">
      <label>并发连接数</label>
      <n-input-number v-model:value="profile.advanced.insecureConcurrency" :min="1" :max="64" placeholder="1"
        size="small" style="width: 160px" :show-button="false" @update:value="emit('change')" />
      <span class="hint" v-if="!profile.advanced.insecureConcurrency" style="margin: 0">naive 默认 1(最强抗流量分析)</span>
    </div>
    <div class="warnbar y" v-if="(profile.advanced.insecureConcurrency ?? 1) > 1 && (profile.advanced.insecureConcurrency ?? 1) <= 4">
      <i>⚠</i><span>多连接更易被流量分析识别,与 NaïveProxy 的设计目标相悖。建议 ≤4,优先尝试 2。</span>
    </div>
    <div class="warnbar r" v-if="(profile.advanced.insecureConcurrency ?? 1) > 4">
      <i>⛔</i><span>上游强烈建议不超过 4 个连接(USAGE.txt:86)。</span>
    </div>
    <div class="field-row wide">
      <label>隧道轮换 (s)</label>
      <n-input-number v-model:value="profile.advanced.tunnelTimeout" :min="1" placeholder="1800"
        size="small" style="width: 160px" :show-button="false" @update:value="emit('change')" />
      <span class="hint" style="margin: 0">会中断 SSH 等长连接</span>
    </div>
    <div class="field-row wide">
      <label>空闲超时 (s)</label>
      <n-input-number v-model:value="profile.advanced.idleTimeout" :min="1" placeholder="600"
        size="small" style="width: 160px" :show-button="false" @update:value="emit('change')" />
    </div>
  </div>

  <div class="card">
    <div class="adv-head" @click="showMore = !showMore">
      <span class="chev">{{ showMore ? '▾' : '▸' }}</span> HTTP 头 / 域名解析
      <span class="hint" style="margin: 0">进阶:自定义请求头与 DNS 解析规则</span>
    </div>
    <div v-if="showMore" class="adv-body">
      <div class="field-row wide">
        <label>extra-headers</label>
        <n-input v-model:value="profile.advanced.extraHeaders" placeholder="X-Header: value(CRLF 分隔)" size="small"
          style="flex: 1" @update:value="(v: string) => { profile.advanced.extraHeaders = v || undefined; emit('change'); }" />
      </div>
      <div class="field-row wide">
        <label>host-resolver-rules</label>
        <n-input v-model:value="profile.advanced.hostResolverRules" placeholder="MAP a.example 1.2.3.4" size="small"
          style="flex: 1" @update:value="(v: string) => { profile.advanced.hostResolverRules = v || undefined; emit('change'); }" />
      </div>
      <div class="field-row wide">
        <label>resolver-range</label>
        <n-input v-model:value="profile.advanced.resolverRange" placeholder="100.64.0.0/10" size="small"
          style="flex: 1" @update:value="(v: string) => { profile.advanced.resolverRange = v || undefined; emit('change'); }" />
        <span class="hint" style="margin: 0">仅 redir 模式</span>
      </div>
    </div>
  </div>

  <!-- 原始 config.json 预览:只读,展开时才渲染(避免每次编辑都重排大段文本) -->
  <div class="card">
    <div class="adv-head" @click="showPreview = !showPreview">
      <span class="chev">{{ showPreview ? '▾' : '▸' }}</span> 原始 config.json(只读预览)
      <span class="hint" style="margin: 0">将写入 naive 的确切内容</span>
    </div>
    <div v-if="showPreview" class="prev">{{ previewJson }}</div>
  </div>
</template>

<style scoped>
.adv-head { display: flex; align-items: center; gap: 8px; cursor: pointer; color: var(--text);
  font-size: 13.5px; font-weight: 600; padding: 2px 0; user-select: none; letter-spacing: .2px; }
.adv-head .chev { color: var(--text-dim); font-size: 12px; width: 12px; flex-shrink: 0; }
.adv-head:hover .chev { color: var(--blue); }
.adv-body { padding: 14px 0 0 20px; }
/* 原型 .prev 同款:等宽、pre-wrap、暗底,让 JSON 层次清晰 */
.prev { background: var(--panel2); border: 1px solid var(--border); border-radius: 6px;
  padding: 10px 12px; margin-top: 12px; font-size: 12px; line-height: 1.85;
  font-family: "Cascadia Code", Consolas, monospace; white-space: pre-wrap; word-break: break-all;
  color: var(--text-dim); max-height: 340px; overflow-y: auto; }
i { font-style: normal; flex-shrink: 0; }
</style>
