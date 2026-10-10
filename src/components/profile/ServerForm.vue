<script setup lang="ts">
import { computed, ref } from "vue";
import { NInput, NInputNumber, NSelect, NSwitch, NInputGroup, NRadioGroup, NRadioButton, NButton } from "naive-ui";
import type { Profile } from "../../lib/schema";
import type { ValidationIssue } from "../../lib/validate";

const props = defineProps<{ profile: Profile; issues: ValidationIssue[] }>();
const emit = defineEmits<{ change: [] }>();

const hop = computed(() => props.profile.server[0]);
const showPass = ref(false);

/* auth 是可选字段(新增/无凭据导入的 profile 没有它)。用惰性访问器替代
   hop.auth!.user 直接访问:undefined.auth 会在渲染期抛 TypeError,炸掉整棵树
   的更新队列 —— 表现为界面整体"点不动"。仅在用户真正输入时才创建 auth 对象,
   避免渲染器把空 auth 误输出为 "://@host"(render.ts 按 auth 存在与否决定写 @)。 */
const authUser = computed({
  get: () => hop.value.auth?.user ?? "",
  set: (v: string) => { (hop.value.auth ??= { user: "", pass: "" }).user = v; },
});
const authPass = computed({
  get: () => hop.value.auth?.pass ?? "",
  set: (v: string) => { (hop.value.auth ??= { user: "", pass: "" }).pass = v; },
});

/** 代理链展开开关:多跳时自动展开 */
const chainOpen = ref(props.profile.server.length > 1);

const schemeOptions = [
  { label: "https", value: "https" },
  { label: "http", value: "http" },
  { label: "quic", value: "quic" },
  { label: "socks", value: "socks" },
];
const SCHEMES = ["https", "http", "quic", "socks"] as const;

/**
 * n-radio-group 的 onUpdateValue 签名是 (value: string & number & boolean) => void
 * (naive-ui/es/radio/src/interface.d.ts:2)。交叉类型可赋值给 string,所以这里收 string
 * 再断言回 ProxyScheme —— 不能用 v-model:value 直接绑 hop.scheme:
 * naive 会把 string & number & boolean 写回 ProxyScheme 联合,vue-tsc 判为不可赋值。
 */
function setScheme(s: string) {
  hop.value.scheme = s as typeof hop.value.scheme;
  emit("change");
}

function addHop() {
  props.profile.server.push({ scheme: "https", host: "", port: 443 });
  chainOpen.value = true;
  emit("change");
}
function delHop(i: number) {
  props.profile.server.splice(i, 1);
  emit("change");
}
function moveHop(i: number, dir: -1 | 1) {
  const j = i + dir;
  if (j < 0 || j >= props.profile.server.length) return;
  [props.profile.server[i], props.profile.server[j]] = [props.profile.server[j], props.profile.server[i]];
  emit("change");
}

const hopIssue = (i: number) => props.issues.find((x) => x.kind === "hop" && x.index === i && x.severity === "error");
</script>

<template>
  <div class="card">
    <div class="card-title">服务器</div>
    <div class="field-row">
      <label>协议</label>
      <!-- n-radio-group + n-radio-button 取代手写 .seg(原型 mockup.html 已验证的形态)。
           踩坑:n-radio-button 的根元素是 <label>(RadioButton.mjs:16),而 App.vue 的
           .field-row > label 有固定宽度 52px —— 必须用子选择器 > 才不会命中它,
           否则四个协议按钮会被压成 52px 宽。 -->
      <n-radio-group :value="hop.scheme" size="small" @update:value="setScheme">
        <n-radio-button v-for="s in SCHEMES" :key="s" :value="s" :label="s" />
      </n-radio-group>
      <span class="hint" v-if="hop.scheme === 'quic'">HTTP/3 — 推荐先测试连通性</span>
    </div>
    <div class="field-row">
      <label>地址</label>
      <n-input-group style="flex: 1">
        <n-input v-model:value="hop.host" placeholder="example.com" size="small"
          :status="hopIssue(0)?.code === 'V-P-02' ? 'error' : undefined" style="flex: 1"
          @update:value="emit('change')" />
        <n-input-number v-model:value="hop.port" :min="1" :max="65535" size="small" style="width: 110px"
          :show-button="false" @update:value="emit('change')" />
      </n-input-group>
    </div>
    <div class="field-row">
      <label>认证</label>
      <n-input v-model:value="authUser" placeholder="用户名" size="small" style="width: 150px"
        @update:value="emit('change')" />
      <n-input v-model:value="authPass" :type="showPass ? 'text' : 'password'" placeholder="密码" size="small"
        style="flex: 1" show-password-on="click" @update:value="emit('change')" />
    </div>
    <div class="hint err" v-if="hopIssue(0)" style="margin: -8px 0 0 64px">
      {{ hopIssue(0)?.message }}
    </div>
  </div>

  <div class="card">
    <div class="card-title">
      代理链
      <span class="hint" style="margin: 0">多跳中转场景</span>
      <n-switch v-model:value="chainOpen" size="small" style="margin-left: auto" />
    </div>
    <template v-if="chainOpen">
      <div v-for="(h, i) in profile.server" :key="i" class="hop" :class="{ 'hop-err': hopIssue(i) }">
        <span class="idx">
          跳 {{ i + 1 }}
          <div v-if="i === profile.server.length - 1" style="font-size: 10px; color: var(--green)">末跳·Naive</div>
          <div v-else style="font-size: 10px; color: var(--text-faint)">前置</div>
        </span>
        <n-input-group style="flex: 1">
          <n-select v-model:value="h.scheme" :options="schemeOptions" size="small" style="width: 96px"
            @update:value="emit('change')" />
          <n-input v-model:value="h.host" placeholder="host" size="small" style="flex: 1"
            @update:value="emit('change')" />
          <n-input-number v-model:value="h.port" :min="1" :max="65535" size="small" style="width: 96px"
            :show-button="false" @update:value="emit('change')" />
        </n-input-group>
        <!-- ↑/↓/✕ 由手写 .btn-icon 换成 n-button circle tiny(原型同款)。
             注意:这里的 ✕ 是"删除此跳",与侧栏已移除的"删除档案"无关,是行内必要操作,保留。 -->
        <n-button size="tiny" circle title="上移" :disabled="i === 0" @click="moveHop(i, -1)">↑</n-button>
        <n-button size="tiny" circle title="下移" :disabled="i === profile.server.length - 1" @click="moveHop(i, 1)">↓</n-button>
        <n-button size="tiny" circle type="error" title="删除此跳" v-if="profile.server.length > 1" @click="delHop(i)">✕</n-button>
      </div>
      <n-button size="small" dashed style="margin-top: 10px" @click="addHop">＋ 添加前置代理</n-button>
      <div class="note">ⓘ 末跳自动协商 Naïve padding;SOCKS 末跳无 padding;QUIC 跳不能排在 TCP 跳之后(V-P-04)。</div>
    </template>
    <div v-else class="note">ⓘ 单跳直连末跳服务器。展开开关可编辑多跳代理链。</div>
  </div>
</template>

<style scoped>
.hop { display: flex; align-items: center; gap: 8px; padding: 8px 0; border-bottom: 1px dashed var(--border); }
.hop:last-of-type { border-bottom: none; }
.hop .idx { width: 52px; font-size: 11px; color: var(--text-faint); flex-shrink: 0; }
.hop-err { border-left: 2px solid var(--red); padding-left: 8px; border-radius: 2px; }
</style>
