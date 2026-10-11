<script setup lang="ts">
import { computed, ref } from "vue";
import {
  NModal, NCard, NInput, NButton, NSwitch, NRadioGroup, NRadioButton, NForm, NFormItem, NAlert, NSpace,
} from "naive-ui";
import { useSettingsStore } from "../stores/settings";

const emit = defineEmits<{ close: [] }>();
const settingsStore = useSettingsStore();
const s = settingsStore.settings;

const browsePath = ref(s.naiveBinaryPath ?? "");
const detecting = ref(false);
const detectResult = ref<{ ok: boolean; version?: string; error?: string } | null>(null);

/**
 * 主题选项:值必须用 store/DEFAULTS 里真实的 "auto"(settings.ts:10),
 * 不能照搬 mockup 原型的 "system" —— 后端持久化的是 auto,写 system 会导致
 * effectiveTheme 落到兜底分支(settings.ts:35)。标签沿用原型的「深色/浅色/跟随系统」。
 */
const themeOptions = [
  { label: "跟随系统", value: "auto" },
  { label: "暗色", value: "dark" },
  { label: "亮色", value: "light" },
];

async function detect() {
  if (!browsePath.value) return;
  detecting.value = true;
  detectResult.value = await settingsStore.detect(browsePath.value);
  if (detectResult.value?.ok) {
    s.naiveBinaryPath = browsePath.value;
  }
  detecting.value = false;
}

/** 当前生效内核的一行说明(§5.4:显式路径 → 程序同目录自动发现)。
    文案不写死文件名 —— Windows 是 naive.exe,macOS/Linux 是 naive,
    统一以「内核」通称,具体文件由后端按平台解析。 */
const binLine = computed(() => {
  if (settingsStore.naiveBinarySource === "bundled") {
    return settingsStore.naiveVersion
      ? `✓ 内核 v${settingsStore.naiveVersion}(程序自带)`
      : "✓ 程序自带内核";
  }
  if (settingsStore.naiveBinarySource === "explicit") {
    return `✓ 内核:${settingsStore.naiveBinary}`;
  }
  return "⚠ 未找到内核:放程序目录,或在上方指定路径";
});

/** 数据目录一行说明(§6.4):便携 = 随文件夹走,否则系统目录 */
const dataLine = computed(() => {
  const d = settingsStore.dataDir;
  if (!d) return "";
  return `数据:${d.path}${d.portable ? "(便携)" : "(系统)"}`;
});

async function save() {
  s.naiveBinaryPath = browsePath.value || null;
  await settingsStore.persist();
  // 路径变更后刷新生效二进制与顶栏版本徽章
  await settingsStore.refreshNaiveBinary();
  emit("close");
}
</script>

<template>
  <n-modal :show="true" @update:show="(v: boolean) => { if (!v) emit('close'); }">
    <n-card title="设置" style="width: 560px" :bordered="false" closable @close="emit('close')">
      <n-form label-placement="left" label-width="130">
        <n-form-item label="naive 路径">
          <n-space :wrap="false" style="width: 100%">
            <n-input v-model:value="browsePath" placeholder="留空 = 自动用程序同目录内核" style="flex: 1" />
            <n-button :loading="detecting" @click="detect">检测</n-button>
          </n-space>
        </n-form-item>
        <n-form-item :show-label="false">
          <n-alert :type="settingsStore.naiveBinarySource ? 'success' : 'warning'" style="width: 100%">
            {{ binLine }} · {{ dataLine }}
          </n-alert>
        </n-form-item>
        <n-form-item v-if="detectResult && detectResult.ok !== true" :show-label="false">
          <n-alert type="error" style="width: 100%">{{ detectResult.error }}</n-alert>
        </n-form-item>
        <n-form-item v-if="detectResult?.ok" :show-label="false">
          <n-alert type="success" style="width: 100%">
            检测到 v{{ detectResult.version }} · 建议保持最新版本以匹配 Chrome 指纹
          </n-alert>
        </n-form-item>

        <!-- 主题:原型用 n-radio-group 分段按钮(比下拉少一次点击) -->
        <n-form-item label="界面主题">
          <n-radio-group v-model:value="s.theme" size="small">
            <n-radio-button v-for="o in themeOptions" :key="o.value" :value="o.value" :label="o.label" />
          </n-radio-group>
        </n-form-item>

        <n-form-item label="开机自启">
          <n-switch v-model:value="s.autoStartApp" />
        </n-form-item>
        <!-- 关闭时最小化到托盘:后端 lib.rs:74-84 拦截 CloseRequested 读这个值决定
             隐藏到托盘还是真退出,naive 在托盘期间继续运行。原型也有此项,app 之前漏暴露。 -->
        <n-form-item label="关闭时最小化到托盘">
          <n-switch v-model:value="s.minimizeToTray" />
          <span class="hint" style="margin-left: 12px">关闭后 naive 继续运行</span>
        </n-form-item>
        <n-form-item label="连接后自动设系统代理">
          <n-switch v-model:value="s.setSystemProxyOnConnect" />
        </n-form-item>

        <!-- 代理 bypass:原型设置页没有此项,但它是 sysproxyEnable 的真实入参
             (StatusBar.ts:131),控制哪些地址不走系统代理,必须保留。 -->
        <n-form-item label="代理 bypass">
          <n-input v-model:value="s.sysProxyBypass" type="textarea" :autosize="{ minRows: 2, maxRows: 4 }"
            placeholder="localhost;127.*;10.*;172.16.*-172.31.*;192.168.*;<local>"
            style="font-family: Consolas, monospace" />
        </n-form-item>
      </n-form>

      <template #footer>
        <n-space justify="end">
          <n-button @click="emit('close')">取消</n-button>
          <n-button type="primary" @click="save">保存设置</n-button>
        </n-space>
      </template>
    </n-card>
  </n-modal>
</template>

<style scoped>
.hint { font-size: 12px; color: var(--text-faint); }
</style>
