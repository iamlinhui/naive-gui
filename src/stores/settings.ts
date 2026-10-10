/**
 * settingsStore:AppSettings 读写 + 系统代理状态镜像 + 主题解析(单一真源)。
 */
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { api, listen, type AppSettings, type SysproxyStatus } from "../lib/ipc";

const DEFAULTS: AppSettings = {
  language: "zh-CN",
  theme: "auto",
  naiveBinaryPath: null,
  autoStartApp: false,
  autoConnectProfileId: null,
  minimizeToTray: true,
  setSystemProxyOnConnect: true,
  sysProxyBypass: "localhost;127.*;10.*;172.16.*-172.31.*;192.168.*;<local>",
};

export const useSettingsStore = defineStore("settings", () => {
  const settings = ref<AppSettings>({ ...DEFAULTS });
  const sysproxy = ref<SysproxyStatus | null>(null);
  const naiveVersion = ref<string | null>(null);
  /** 生效的 naive 二进制路径(显式设置或程序同目录自动发现) */
  const naiveBinary = ref<string | null>(null);
  /** 来源:explicit = 设置页指定,bundled = 程序同目录打包自带 */
  const naiveBinarySource = ref<"explicit" | "bundled" | null>(null);
  /** 生效数据目录(便携模式 = <程序目录>/data) */
  const dataDir = ref<{ path: string; portable: boolean } | null>(null);

  /** 系统当前配色(供 theme=auto 跟随) */
  const systemDark = ref(
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
      : true,
  );

  /** 解析后的生效主题:dark | light(仅两态,auto 已在此消解) */
  const effectiveTheme = computed<"dark" | "light">(() => {
    if (settings.value.theme === "light") return "light";
    if (settings.value.theme === "dark") return "dark";
    return systemDark.value ? "dark" : "light";
  });

  if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener?.("change", (e) => {
      systemDark.value = e.matches;
    });
  }

  async function load() {
    try {
      settings.value = { ...DEFAULTS, ...(await api.getSettings()) };
    } catch {
      settings.value = { ...DEFAULTS };
    }
    await refreshSysproxy();
    await refreshNaiveBinary();
    try {
      dataDir.value = await api.getDataDir();
    } catch {
      dataDir.value = null;
    }
  }

  async function persist() {
    await api.setSettings(settings.value);
  }

  /**
   * 解析生效二进制 + 版本检测:后端按「显式路径 → 程序同目录」顺序解析,
   * 路径留空也能拿到打包自带的 naive.exe(§5.4)。
   */
  async function refreshNaiveBinary() {
    try {
      const r = await api.resolveNaiveBinary();
      naiveBinary.value = r.path;
      naiveBinarySource.value = r.source;
    } catch {
      naiveBinary.value = null;
      naiveBinarySource.value = null;
    }
    if (naiveBinary.value) {
      await detect(naiveBinary.value);
    } else {
      naiveVersion.value = null;
    }
  }

  async function refreshSysproxy() {
    try {
      sysproxy.value = await api.sysproxyStatus();
    } catch {
      sysproxy.value = null;
    }
  }

  async function detect(path: string) {
    try {
      const r = await api.detectNaiveBinary(path);
      naiveVersion.value = r.ok ? (r.version ?? null) : null;
      return r;
    } catch {
      naiveVersion.value = null;
      return { ok: false, error: "检测失败" };
    }
  }

  async function init() {
    await listen<boolean>("sysproxy:healed", () => {
      refreshSysproxy();
    });
  }

  return {
    settings, sysproxy, naiveVersion, naiveBinary, naiveBinarySource, dataDir, systemDark, effectiveTheme,
    load, persist, refreshSysproxy, refreshNaiveBinary, detect, init,
  };
});
