<script setup lang="ts">
/**
 * 校验问题汇总。错误码前缀与文档一一对应:V-L(监听) V-P(代理) V-A(高级) V-D(诊断)。
 * 注意:本注释里不能写 "V-L-*" + 斜杠 这种形式 —— 星号后紧跟斜杠会提前闭合注释块。
 *
 * 为什么单独成组件而不是留在 DetailPane 里:
 * 改用 n-tabs 后,每个 n-tab-pane 的 display-directive 默认是 "if"
 * (naive-ui/es/tabs/src/TabPane.mjs:15) —— 非活动 pane 完全不渲染,
 * 因此不存在"4 个分支之后的共享底部"位置,问题列表必须在每个 pane 内渲染。
 * 提取成组件避免把同一段模板抄 4 遍。
 */
import type { ValidationIssue } from "../lib/validate";

defineProps<{ issues: ValidationIssue[] }>();
</script>

<template>
  <div v-if="issues.length" class="issues">
    <div v-for="(i, idx) in issues" :key="idx" class="issue" :class="i.severity">
      <span class="icode">{{ i.code }}</span>{{ i.message }}
    </div>
  </div>
</template>

<style scoped>
.issues { margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 6px; }
.issue { font-size: 12px; display: flex; gap: 8px; align-items: baseline; }
.issue.error { color: var(--red); }
.issue.warning { color: var(--yellow); }
.issue.info { color: var(--text-dim); }
.icode { font-size: 10.5px; opacity: .75; background: var(--panel2); padding: 1px 5px; border-radius: 4px;
  flex-shrink: 0; font-family: Consolas, monospace; }
</style>
