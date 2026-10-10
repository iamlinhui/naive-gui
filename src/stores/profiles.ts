/**
 * profilesStore:列表 CRUD、当前选中、脏状态跟踪(UI_SPEC §9.4)。
 */
import { defineStore } from "pinia";
import { ref, computed, toRaw } from "vue";
import type { Profile } from "../lib/schema";
import { newProfile } from "../lib/schema";
import { api } from "../lib/ipc";

/**
 * rename 的结果:失败原因要能区分,组件才能给出对应的行内提示
 * (UI_SPEC §8「位置红框行内报错(无 general error)」的同一原则)。
 * changed=false 表示名称没变(用户提交了原名),此时不算失败、也不该标脏。
 */
export type RenameResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: "empty" | "duplicate" | "missing"; message: string };

export const useProfilesStore = defineStore("profiles", () => {
  const profiles = ref<Profile[]>([]);
  const currentId = ref<string | null>(null);
  /** 未保存修改的 profile id 集合 */
  const dirty = ref(new Set<string>());
  const loaded = ref(false);

  const current = computed(() => profiles.value.find((p) => p.id === currentId.value) ?? null);
  const isDirty = computed(() => currentId.value !== null && dirty.value.has(currentId.value));
  /** 该 id 是否从未保存到磁盘(dirty 集合中的都是) */
  function isUnsaved(id: string): boolean {
    return dirty.value.has(id);
  }

  async function load() {
    try {
      const file = await api.listProfiles();
      profiles.value = (file.profiles ?? []) as Profile[];
    } catch (e) {
      console.warn("加载 profiles 失败(可能首次启动)", e);
      profiles.value = [];
    }
    loaded.value = true;
    if (!currentId.value && profiles.value.length > 0) {
      currentId.value = profiles.value[0].id;
    }
  }

  function select(id: string) {
    currentId.value = id;
  }

  function create(name?: string): Profile {
    const p = newProfile(name || `服务器 ${profiles.value.length + 1}`);
    profiles.value.push(p);
    currentId.value = p.id;
    markDirty(p.id);
    return p;
  }

  function markDirty(id?: string) {
    dirty.value.add(id ?? currentId.value ?? "");
  }

  async function save(profile: Profile) {
    profile.updatedAt = Date.now();
    await api.saveProfile(profile);
    dirty.value.delete(profile.id);
    const idx = profiles.value.findIndex((p) => p.id === profile.id);
    if (idx >= 0) profiles.value[idx] = { ...profile };
  }

  async function remove(id: string) {
    const p = profiles.value.find((x) => x.id === id);
    // 未保存的(仅内存中)直接移除;已保存的先调后端删除
    if (p && !dirty.value.has(id)) {
      try {
        await api.deleteProfile(id);
      } catch (e) {
        // 磁盘上也没有(从未保存过)→ 忽略,继续本地移除
        console.warn("deleteProfile:", e);
      }
    }
    profiles.value = profiles.value.filter((x) => x.id !== id);
    dirty.value.delete(id);
    if (currentId.value === id) {
      currentId.value = profiles.value[0]?.id ?? null;
    }
  }

  /** 拖拽排序:移动到新位置并持久化整个顺序(后端按数组序重写) */
  function reorder(fromId: string, toIndex: number) {
    const fromIndex = profiles.value.findIndex((p) => p.id === fromId);
    if (fromIndex < 0 || fromIndex === toIndex) return;
    const [moved] = profiles.value.splice(fromIndex, 1);
    profiles.value.splice(toIndex, 0, moved);
    persistOrder();
  }

  /** 把当前列表顺序写回磁盘(删除时也顺带保持顺序) */
  async function persistOrder() {
    try {
      const { api: a } = await import("../lib/ipc");
      await a.reorderProfiles(profiles.value.map((p) => p.id));
    } catch (e) {
      console.warn("reorder 持久化失败(未保存的配置尚不在磁盘,忽略):", e);
    }
  }

  /**
   * 重命名(UI_SPEC §8:侧栏右键 → 名称输入,enter 确认)。
   * 校验放在 store 而非组件:空名违反 zod 的 `name: z.string().min(1).trim()`,
   * 重名会让侧栏无法区分条目 —— 两者都必须挡住,不能只靠 UI 提示。
   * 改名走 dirty 流程(不立即写盘),与用户编辑其它字段一致:改完按「保存」才落盘。
   */
  function rename(id: string, rawName: string): RenameResult {
    const p = profiles.value.find((x) => x.id === id);
    if (!p) return { ok: false, reason: "missing", message: "档案不存在" };
    const name = rawName.trim();
    if (!name) return { ok: false, reason: "empty", message: "名称不能为空" };
    if (profiles.value.some((x) => x.id !== id && x.name === name)) {
      return { ok: false, reason: "duplicate", message: "已存在同名档案" };
    }
    if (name === p.name) return { ok: true, changed: false };
    p.name = name;
    p.updatedAt = Date.now();
    markDirty(id);
    return { ok: true, changed: true };
  }

  /**
   * 复制档案(侧栏右键)。
   * 本地克隆而非调后端 duplicate_profile,有三个原因:
   *  1. 后端按 id 查磁盘,未保存的新档案会 NotFound 直接失败;
   *  2. 后端 push 到列表末尾,而这里要插在源之后(与原型一致,便于对照);
   *  3. 副本保持 dirty,用户可先改名再保存,不会产生一堆「xxx (副本)」垃圾条目。
   */
  function duplicate(id: string): Profile | null {
    const idx = profiles.value.findIndex((p) => p.id === id);
    if (idx < 0) return null;
    const src = profiles.value[idx];
    const base = `${src.name} 副本`;
    let n = base;
    let k = 2;
    while (profiles.value.some((x) => x.name === n)) n = `${base} ${k++}`;
    const now = Date.now();
    // 深拷贝:nested 的 server/listen/advanced/debug 必须独立,否则副本与源共享数组引用,
    // 改一个另一个跟着变。先 toRaw 脱离 Vue reactive proxy —— structuredClone 直接吃
    // proxy 在部分环境会抛 DataCloneError,且 toRaw 拿到的嵌套对象本身就是 raw 的。
    const dup: Profile = {
      ...structuredClone(toRaw(src)),
      id: crypto.randomUUID(),
      name: n,
      createdAt: now,
      updatedAt: now,
    };
    profiles.value.splice(idx + 1, 0, dup);
    markDirty(dup.id);
    return dup;
  }

  /** 导入:直接进列表并选中(不自动保存,让用户先检查) */
  function addImported(p: Profile) {
    profiles.value.push(p);
    currentId.value = p.id;
    markDirty(p.id);
  }

  return {
    profiles, currentId, current, isDirty, isUnsaved, loaded,
    load, select, create, save, remove, duplicate, addImported, markDirty, reorder, persistOrder, rename,
  };
});