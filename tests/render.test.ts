import { describe, it, expect } from "vitest";
import { renderConfig, renderConfigJson } from "../src/lib/render";
import { newProfile } from "../src/lib/schema";
import type { Profile } from "../src/lib/schema";

const base = (): Profile => ({
  ...newProfile("t"),
  server: [{ scheme: "https", host: "example.com", port: 443, auth: { user: "u", pass: "p" } }],
});

describe("render: 基础渲染", () => {
  it("最小配置(README 示例)", () => {
    const p = base();
    const cfg = renderConfig(p);
    expect(cfg).toEqual({
      listen: ["socks://127.0.0.1:1080"],
      proxy: "https://u:p@example.com:443",
      log: "",
    });
  });

  it("多监听渲染为数组,socks+http 常见组合", () => {
    const p = base();
    p.listen = [
      { proto: "socks", addr: "127.0.0.1", port: 1080 },
      { proto: "http", addr: "127.0.0.1", port: 8080 },
    ];
    expect(renderConfig(p).listen).toEqual([
      "socks://127.0.0.1:1080",
      "http://127.0.0.1:8080",
    ]);
  });

  it("无认证时 URI 不含 @;无 auth 对象", () => {
    const p = base();
    p.server = [{ scheme: "https", host: "a.example" }];
    expect(renderConfig(p).proxy).toBe("https://a.example:443");
  });

  it("端口缺省用协议默认端口(https 443 / http 80 / socks 1080 / quic 443)", () => {
    const p = base();
    p.server = [{ scheme: "http", host: "a.example" }];
    expect(renderConfig(p).proxy).toBe("http://a.example:80");
    p.server = [{ scheme: "socks", host: "1.2.3.4" }];
    expect(renderConfig(p).proxy).toBe("socks://1.2.3.4:1080");
    p.server = [{ scheme: "quic", host: "a.example" }];
    expect(renderConfig(p).proxy).toBe("quic://a.example:443");
  });
});

describe("render: userinfo 编码 / IPv6", () => {
  it("特殊字符凭据百分号编码(: 与 @ 是定界符,必须编码)", () => {
    const p = base();
    p.server = [{ scheme: "https", host: "a.example", auth: { user: "a:b", pass: "p@:/" } }];
    expect(renderConfig(p).proxy).toBe("https://a%3Ab:p%40%3A%2F@a.example:443");
  });

  it("IPv6 host 加方括号", () => {
    const p = base();
    p.server = [{ scheme: "https", host: "2001:db8::1", port: 8443 }];
    p.listen = [{ proto: "socks", addr: "::1", port: 1080 }];
    expect(renderConfig(p).proxy).toBe("https://[2001:db8::1]:8443");
    expect(renderConfig(p).listen).toEqual(["socks://[::1]:1080"]);
  });

  it("监听认证渲染进 userinfo", () => {
    const p = base();
    p.listen = [{ proto: "socks", addr: "127.0.0.1", port: 1080, auth: { user: "lu", pass: "lp" } }];
    expect(renderConfig(p).listen).toEqual(["socks://lu:lp@127.0.0.1:1080"]);
  });
});

describe("render: 覆盖项语义(§4.3)", () => {
  it("未设置的覆盖项不写入 config.json(吃 naive 默认)", () => {
    const p = base();
    p.debug = { log: "none" };
    const cfg = renderConfig(p);
    expect(cfg).not.toHaveProperty("tunnel-timeout");
    expect(cfg).not.toHaveProperty("idle-timeout");
    expect(cfg).not.toHaveProperty("insecure-concurrency");
    expect(cfg).not.toHaveProperty("log");
    expect(cfg).not.toHaveProperty("no-post-quantum");
  });

  it("显式设置才写入", () => {
    const p = base();
    p.advanced = { insecureConcurrency: 2, tunnelTimeout: 900, idleTimeout: 300 };
    const cfg = renderConfig(p);
    expect(cfg["insecure-concurrency"]).toBe(2);
    expect(cfg["tunnel-timeout"]).toBe(900);
    expect(cfg["idle-timeout"]).toBe(300);
  });

  it("log 三态:stderr→'';none→省略;file→路径(naive_config.cc:291)", () => {
    const p = base();
    p.debug = { log: "stderr" };
    expect(renderConfig(p).log).toBe("");
    p.debug = { log: "none" };
    expect(renderConfig(p).log).toBeUndefined();
    p.debug = { log: { file: "C:/logs/naive.log" } };
    expect(renderConfig(p).log).toBe("C:/logs/naive.log");
  });

  it("no-post-quantum 仅 true 写入(naive 按键存在判定,naive_config.cc:324)", () => {
    const p = base();
    p.debug = { log: "stderr", noPostQuantum: false };
    expect(renderConfig(p)).not.toHaveProperty("no-post-quantum");
    p.debug = { log: "stderr", noPostQuantum: true };
    expect(renderConfig(p)["no-post-quantum"]).toBe(true);
  });
});

describe("render: 代理链", () => {
  it("多跳链逗号分隔;末跳是 Naive 服务端", () => {
    const p = base();
    p.server = [
      { scheme: "https", host: "front.example", port: 443 },
      { scheme: "https", host: "naive.example", port: 443, auth: { user: "u", pass: "p" } },
    ];
    expect(renderConfig(p).proxy).toBe(
      "https://front.example:443,https://u:p@naive.example:443",
    );
  });

  it("multi 模式:proxy 为数组,与 listen 按位置配对", () => {
    const p = base();
    p.routingMode = "multi";
    p.listen = [
      { proto: "socks", addr: "127.0.0.1", port: 1080 },
      { proto: "socks", addr: "127.0.0.1", port: 1081 },
    ];
    p.chains = [
      [{ scheme: "https", host: "a.example", port: 443 }],
      [{ scheme: "quic", host: "b.example", port: 443 }],
    ];
    expect(renderConfig(p).proxy).toEqual([
      "https://a.example:443",
      "quic://b.example:443",
    ]);
  });

  it("multi 模式但 chains 为空 → 回退 single(防御)", () => {
    const p = base();
    p.routingMode = "multi";
    p.chains = [];
    expect(renderConfig(p).proxy).toBe("https://u:p@example.com:443");
  });

  it("renderConfigJson 输出 2 空格缩进带尾换行", () => {
    const s = renderConfigJson(base());
    expect(s.endsWith("\n")).toBe(true);
    expect(JSON.parse(s).listen).toEqual(["socks://127.0.0.1:1080"]);
  });
});
