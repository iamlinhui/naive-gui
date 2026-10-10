<script setup lang="ts">
import { computed } from "vue";
import { NInputNumber, NSelect, NButton, NButtonGroup, useMessage } from "naive-ui";
import type { Profile } from "../../lib/schema";
import type { ValidationIssue } from "../../lib/validate";

const props = defineProps<{ profile: Profile; issues: ValidationIssue[] }>();
const emit = defineEmits<{ change: [] }>();
const message = useMessage();

const listenIssue = (i: number) => props.issues.find((x) => x.kind === "listen" && x.index === i && x.severity === "error");

const protoOptions = [
  { label: "socks", value: "socks" },
  { label: "http", value: "http" },
];
const addrOptions = [
  { label: "127.0.0.1", value: "127.0.0.1" },
  { label: "0.0.0.0", value: "0.0.0.0" },
  { label: "::1", value: "::1" },
];

/**
 * 当前监听命中的模板(与 mockup.html 的 tplOn 同源)。
 * 关键:端口无关,只按「协议 + 数量」结构匹配 —— 用户把 1080 改成别的,
 * 只要还是"单个 socks / socks+http 两条",按钮仍应高亮。
 * 旧实现要求端口精确等于 1080/8080,改端口后高亮就丢,是"选中逻辑不对"的根因。
 * 三态:socks / socks+http / custom(其余,含用户手改的任何形态)。
 */
const tplOn = computed<"socks" | "socks+http" | "custom">(() => {
  const l = props.profile.listen;
  if (l.length === 1 && l[0].proto === "socks" && l[0].addr === "127.0.0.1") return "socks";
  if (l.length === 2 && l[0].proto === "socks" && l[1].proto === "http") return "socks+http";
  return "custom";
});

function applyTpl(kind: "socks" | "socks+http" | "custom") {
  if (kind === "custom") {
    // 自定义 = 保留当前监听不动(原型语义),仅提示用户可自由增删
    message.info("当前为自定义监听,可自由增删");
    return;
  }
  if (kind === "socks") {
    props.profile.listen = [{ proto: "socks", addr: "127.0.0.1", port: 1080 }];
  } else {
    props.profile.listen = [
      { proto: "socks", addr: "127.0.0.1", port: 1080 },
      { proto: "http", addr: "127.0.0.1", port: 8080 },
    ];
  }
  emit("change");
}
function add() {
  props.profile.listen.push({ proto: "socks", addr: "127.0.0.1", port: 1080 + props.profile.listen.length });
  emit("change");
}
function del(i: number) {
  if (props.profile.listen.length > 1) props.profile.listen.splice(i, 1);
  emit("change");
}
</script>

<template>
  <div class="card">
    <div class="card-title">
      本地监听
      <!-- 预置模板:n-button-group 包三个,高亮 = tplOn(端口无关的结构匹配) -->
      <div class="tpl-btns">
        <n-button-group size="tiny">
          <n-button :type="tplOn === 'socks' ? 'primary' : 'default'" @click="applyTpl('socks')">socks</n-button>
          <n-button :type="tplOn === 'socks+http' ? 'primary' : 'default'" @click="applyTpl('socks+http')">socks+http</n-button>
          <n-button :type="tplOn === 'custom' ? 'primary' : 'default'" @click="applyTpl('custom')">自定义</n-button>
        </n-button-group>
      </div>
    </div>
    <div v-for="(l, i) in profile.listen" :key="i" class="lrow" :class="{ 'lrow-err': listenIssue(i) }">
      <n-select v-model:value="l.proto" :options="protoOptions" size="small" style="width: 100px"
        @update:value="emit('change')" />
      <n-select v-model:value="l.addr" :options="addrOptions" size="small" style="width: 124px"
        @update:value="emit('change')" />
      <n-input-number v-model:value="l.port" :min="1" :max="65535" size="small" style="width: 104px"
        :show-button="false" @update:value="emit('change')" />
      <span class="spacer"></span>
      <n-button size="tiny" circle type="error" title="删除此监听" :disabled="profile.listen.length <= 1"
        @click="del(i)">🗑</n-button>
      <span class="hint err" v-if="listenIssue(i)" style="flex: 1">{{ listenIssue(i)?.message }}</span>
    </div>
    <n-button size="small" dashed style="margin-top: 10px" @click="add">＋ 添加监听</n-button>
    <div class="note">
      ⓘ socks:应用兼容性最好;http:可作为系统代理端点。<br />
      ⚠ 多代理链模式下,监听与链<b>按位置一一配对</b>(V-P-07)。
    </div>
  </div>
</template>

<style scoped>
.lrow { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.lrow-err { border-left: 2px solid var(--red); padding-left: 8px; border-radius: 2px; }
.tpl-btns { margin-left: auto; }
.note b { color: var(--text-dim); }
</style>
