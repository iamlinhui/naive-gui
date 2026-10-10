/**
 * profilesStore.rename / duplicate 回归(本轮新增的核心纯逻辑)。
 * 重点覆盖校验分支与克隆语义,避免"改完看着能跑"的假通过。
 * 环境:jsdom(vite.config.ts test.environment)。
 *  - structuredClone / crypto.randomUUID 在 jsdom(Node 18+)可用,newProfile 已依赖后者。
 *  - api.invoke 在非 Tauri 环境会抛(ipc.ts:39),但 rename/duplicate 是纯内存操作,不触达 api;
 *    reorder 会调 persistOrder(内部 try/catch 吞掉 IPC 失败),也不影响断言。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useProfilesStore } from "../src/stores/profiles";
import { newProfile } from "../src/lib/schema";

function seed(store: ReturnType<typeof useProfilesStore>, names: string[]) {
  store.profiles = names.map((n) => newProfile(n));
  store.currentId = store.profiles[0]?.id ?? null;
}

describe("profilesStore.rename", () => {
  let store: ReturnType<typeof useProfilesStore>;
  beforeEach(() => {
    setActivePinia(createPinia());
    store = useProfilesStore();
    seed(store, ["alpha", "beta", "gamma"]);
  });

  it("正常改名并标脏", () => {
    const id = store.profiles[1].id;
    const r = store.rename(id, "delta");
    expect(r).toEqual({ ok: true, changed: true });
    expect(store.profiles[1].name).toBe("delta");
    // dirty 是 store 内部 ref,公开面是 isUnsaved(id)(未落盘即视为脏)
    expect(store.isUnsaved(id)).toBe(true);
  });

  it("两端空格被 trim", () => {
    const r = store.rename(store.profiles[1].id, "  zeta  ");
    expect(r.ok).toBe(true);
    expect(store.profiles[1].name).toBe("zeta");
  });

  it("空名/纯空格被拒绝,reason=empty", () => {
    for (const bad of ["", "   ", "\t\n"]) {
      const r = store.rename(store.profiles[1].id, bad);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("empty");
        expect(r.message).toBe("名称不能为空");
      }
    }
    expect(store.profiles[1].name).toBe("beta"); // 未被改动
    expect(store.isUnsaved(store.profiles[1].id)).toBe(false); // 未标脏
  });

  it("重名被拒绝,reason=duplicate", () => {
    const r = store.rename(store.profiles[1].id, "gamma"); // gamma 已存在
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("duplicate");
      expect(r.message).toBe("已存在同名档案");
    }
    expect(store.profiles[1].name).toBe("beta");
  });

  it("重名判定用 trim 后的值(改名 ' alpha ' 应撞已有 alpha)", () => {
    const r = store.rename(store.profiles[1].id, " alpha ");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("duplicate");
  });

  it("改成自己的原名:ok 但 changed=false,不标脏", () => {
    const id = store.profiles[0].id;
    const r = store.rename(id, "alpha");
    expect(r).toEqual({ ok: true, changed: false });
    expect(store.isUnsaved(id)).toBe(false);
  });

  it("改成自己的 trim 后同名(' alpha ')也算未变", () => {
    const r = store.rename(store.profiles[0].id, " alpha ");
    expect(r).toEqual({ ok: true, changed: false });
  });

  it("不存在的 id:ok=false,reason=missing", () => {
    const r = store.rename("nope", "x");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("missing");
  });

  it("允许两个不同档案先后占用同一被释放的名字", () => {
    // alpha → tmp,beta → alpha(此时不撞名,因为原 alpha 已让出)
    expect(store.rename(store.profiles[0].id, "tmp").ok).toBe(true);
    const r = store.rename(store.profiles[1].id, "alpha");
    expect(r).toEqual({ ok: true, changed: true });
  });
});

describe("profilesStore.duplicate", () => {
  let store: ReturnType<typeof useProfilesStore>;
  beforeEach(() => {
    setActivePinia(createPinia());
    store = useProfilesStore();
    seed(store, ["alpha"]);
  });

  it("副本名 = 源名 + 副本,插在源之后", () => {
    seed(store, ["alpha", "beta"]);
    const dup = store.duplicate(store.profiles[0].id);
    expect(dup).not.toBeNull();
    expect(dup!.name).toBe("alpha 副本");
    expect(store.profiles.map((p) => p.name)).toEqual(["alpha", "alpha 副本", "beta"]);
  });

  it("名字碰撞时递增:副本 → 副本 2 → 副本 3", () => {
    store.duplicate(store.profiles[0].id); // alpha 副本
    store.duplicate(store.profiles[0].id); // alpha 副本 2
    const third = store.duplicate(store.profiles[0].id); // alpha 副本 3
    expect(third!.name).toBe("alpha 副本 3");
    // 顺序是倒置的,这是预期而非 bug:duplicate 总是把副本插在源之后(idx+1,
    // 与原型 mockup.html 的 duplicateProfile 一致,便于与源对照),
    // 所以连续复制同一源时,最新副本紧贴源,旧的被依次往后挤。
    expect(store.profiles.map((p) => p.name)).toEqual([
      "alpha", "alpha 副本 3", "alpha 副本 2", "alpha 副本",
    ]);
    // 递增命名的真正目的:四个名字互不重复(重名会让侧栏无法区分条目)
    const names = store.profiles.map((p) => p.name);
    expect(new Set(names).size).toBe(4);
  });

  it("副本深拷贝:改副本的 server[0].host 不影响源", () => {
    const srcId = store.profiles[0].id;
    store.profiles[0].server[0].host = "src.example";
    const dup = store.duplicate(srcId)!;
    dup.server[0].host = "dup.example";
    expect(store.profiles[0].server[0].host).toBe("src.example"); // 源未被联动改
    // listen 数组也应是独立引用
    dup.listen.push({ proto: "http", addr: "127.0.0.1", port: 8080 });
    expect(store.profiles[0].listen.length).toBe(1);
  });

  it("副本是新 id、标脏、时间戳更新", () => {
    const src = store.profiles[0];
    const dup = store.duplicate(src.id)!;
    expect(dup.id).not.toBe(src.id);
    expect(store.isUnsaved(dup.id)).toBe(true);
    expect(dup.createdAt).toBeGreaterThanOrEqual(src.createdAt);
  });

  it("复制未保存(仅内存)的档案也能成功 —— 不依赖后端", () => {
    // create() 内部已把新档案 push 进 profiles 并选中,不要再手动 push(否则重复入列)
    const p = store.create("brand new");
    expect(store.profiles.filter((x) => x.id === p.id).length).toBe(1);
    const dup = store.duplicate(p.id);
    expect(dup).not.toBeNull();
    expect(dup!.name).toBe("brand new 副本");
  });

  it("不存在的 id 返回 null", () => {
    expect(store.duplicate("nope")).toBeNull();
  });
});

describe("profilesStore.reorder(既有语义回归)", () => {
  let store: ReturnType<typeof useProfilesStore>;
  beforeEach(() => {
    setActivePinia(createPinia());
    store = useProfilesStore();
    seed(store, ["a", "b", "c"]);
  });

  it("拖到目标位:splice 出再 splice 入", () => {
    store.reorder(store.profiles[2].id, 0); // c → 首位
    expect(store.profiles.map((p) => p.name)).toEqual(["c", "a", "b"]);
  });

  it("同位置拖拽是 no-op", () => {
    store.reorder(store.profiles[1].id, 1);
    expect(store.profiles.map((p) => p.name)).toEqual(["a", "b", "c"]);
  });

  it("不存在的 id 是 no-op", () => {
    store.reorder("nope", 0);
    expect(store.profiles.map((p) => p.name)).toEqual(["a", "b", "c"]);
  });
});
