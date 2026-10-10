<script setup lang="ts">
import { ref, computed } from "vue";
import { NModal, NCard, NInput, NButton, NAlert, NSpace } from "naive-ui";
import { useProfilesStore } from "../stores/profiles";
import { importFromText, ImportError } from "../lib/parse";
import type { Profile } from "../lib/schema";

const emit = defineEmits<{ close: [] }>();
const profilesStore = useProfilesStore();

const text = ref("");
const error = ref("");

const preview = computed(() => {
  if (!text.value.trim()) return null;
  try {
    error.value = "";
    const { kind, profile } = importFromText(text.value);
    return { kind, profile } as { kind: string; profile: Profile };
  } catch (e) {
    error.value = e instanceof ImportError ? e.message : String(e);
    return null;
  }
});

function doImport() {
  if (!preview.value) return;
  profilesStore.addImported(preview.value.profile);
  emit("close");
}
</script>

<template>
  <n-modal :show="true" @update:show="(v: boolean) => { if (!v) emit('close'); }">
    <n-card title="导入配置" style="width: 560px" :bordered="false" closable @close="emit('close')">
      <p class="lead">
        粘贴分享链接(<span class="kbd">naive+https://user:pass@host:port#名称</span>)或完整 config.json:
      </p>
      <n-input
        v-model:value="text"
        type="textarea"
        :rows="3"
        placeholder="naive+https://user:pass@example.com:443#我的服务器"
        style="font-family: Consolas, monospace"
      />

      <div class="prev" v-if="preview">
        识别为 <b>{{ preview.kind === "url" ? "分享链接" : "config.json" }}</b>
        <template v-if="preview.kind === 'url'">
          <br />名称:<b>{{ preview.profile.name }}</b> · 协议:<b>{{ preview.profile.server[0].scheme }}</b>
          · 地址:<b>{{ preview.profile.server[0].host }}{{ preview.profile.server[0].port ? ":" + preview.profile.server[0].port : "" }}</b>
          <br />认证:<b>{{ preview.profile.server[0].auth ? preview.profile.server[0].auth.user + " / ••••••" : "无" }}</b>
        </template>
        <template v-else>
          <br />监听:<b>{{ preview.profile.listen.map((l) => `${l.proto}://${l.addr}:${l.port}`).join(", ") }}</b>
          <br />代理:<b>{{ preview.profile.routingMode === "multi" ? `${preview.profile.chains?.length ?? 0} 条链` : (preview.profile.server[0]?.host || "直连") }}</b>
        </template>
      </div>
      <n-alert v-if="error" type="error" style="margin-top: 10px">{{ error }}</n-alert>

      <template #footer>
        <n-space justify="end">
          <n-button @click="emit('close')">取消</n-button>
          <n-button type="primary" :disabled="!preview" @click="doImport">导入</n-button>
        </n-space>
      </template>
    </n-card>
  </n-modal>
</template>

<style scoped>
.lead { color: var(--text-dim); font-size: 12.5px; line-height: 1.7; margin-bottom: 10px; }
.prev { background: var(--panel2); border: 1px solid var(--border); border-radius: 6px;
  padding: 10px 12px; font-size: 12px; line-height: 1.9; margin-top: 10px; }
.prev b { color: var(--blue); }
.kbd { background: var(--panel2); border: 1px solid var(--border); border-radius: 4px;
  padding: 0 5px; font-size: 11px; font-family: Consolas, monospace; }
</style>
