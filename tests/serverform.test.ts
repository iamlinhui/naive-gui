/**
 * 回归:ServerForm 对无 auth 的 hop 渲染不崩溃(新增配置后整个 UI 点不动的根因)。
 */
import { describe, it, expect } from "vitest";
import { mount } from "@vue/test-utils";
import ServerForm from "../src/components/profile/ServerForm.vue";
import { newProfile } from "../src/lib/schema";

describe("ServerForm 渲染安全", () => {
  it("newProfile(无 auth)挂载不抛错", () => {
    const p = newProfile("t");
    // auth 未定义是合法形态(可选字段)
    expect(p.server[0].auth).toBeUndefined();
    expect(() => mount(ServerForm, { props: { profile: p, issues: [] } })).not.toThrow();
  });

  it("有 auth 的 profile 正常挂载且显示用户名", () => {
    const p = newProfile("t");
    p.server[0].auth = { user: "alice", pass: "secret" };
    const w = mount(ServerForm, { props: { profile: p, issues: [] } });
    expect(w.html()).toContain("alice");
  });
});
