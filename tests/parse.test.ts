import { describe, it, expect } from "vitest";
import { parseNaiveShareUrl, parseConfigJson, importFromText, ImportError } from "../src/lib/parse";
import { newProfile } from "../src/lib/schema";
import { renderConfig } from "../src/lib/render";

describe("parse: naive+ 分享链接", () => {
  it("完整链接 → 单跳 Profile,hash 作名称", () => {
    const p = parseNaiveShareUrl("naive+https://user:pass@example.com:443#我的服务器");
    expect(p.name).toBe("我的服务器");
    expect(p.server).toEqual([
      { scheme: "https", host: "example.com", port: 443, auth: { user: "user", pass: "pass" } },
    ]);
    expect(p.routingMode).toBe("single");
  });

  it("无端口 → 填协议默认端口;无 hash → host 作名称", () => {
    const p = parseNaiveShareUrl("naive+https://u:p@a.example");
    expect(p.server[0]).toEqual({ scheme: "https", host: "a.example", port: 443, auth: { user: "u", pass: "p" } });
    expect(p.name).toBe("a.example");
  });

  it("quic 协议", () => {
    const p = parseNaiveShareUrl("naive+quic://u:p@b.example:8443");
    expect(p.server[0].scheme).toBe("quic");
    expect(p.server[0].port).toBe(8443);
  });

  it("特殊字符凭据百分号解码", () => {
    const p = parseNaiveShareUrl("naive+https://u%40x:p%3A%40@a.example");
    expect(p.server[0].auth).toEqual({ user: "u@x", pass: "p:@" });
  });

  it("非法 scheme 抛 ImportError", () => {
    expect(() => parseNaiveShareUrl("naive+ftp://a.example")).toThrow(ImportError);
  });
});

describe("parse: config.json 反解析", () => {
  it("README 最小示例", () => {
    const p = parseConfigJson(`{
      "listen": "socks://127.0.0.1:1080",
      "proxy": "https://user:pass@example.com",
      "log": ""
    }`);
    expect(p.listen).toEqual([{ proto: "socks", addr: "127.0.0.1", port: 1080 }]);
    expect(p.server).toEqual([
      { scheme: "https", host: "example.com", port: 443, auth: { user: "user", pass: "pass" } },
    ]);
    expect(p.debug.log).toBe("stderr");
  });  it("多监听数组 + multi 链数组", () => {
    const p = parseConfigJson(`{
      "listen": ["socks://127.0.0.1:1080", "socks://127.0.0.1:1081"],
      "proxy": ["https://a.example", "quic://b.example,https://c.example"]
    }`);
    expect(p.routingMode).toBe("multi");
    expect(p.chains).toHaveLength(2);
    expect(p.chains![1]).toHaveLength(2); // 链内多跳
    expect(p.chains![1][1].scheme).toBe("https");
  });

  it("无 proxy 键 → server 为空壳(直连)", () => {
    const p = parseConfigJson(`{ "listen": "socks://127.0.0.1:1080" }`);
    expect(p.server).toEqual([{ scheme: "https", host: "" }]);
  });

  it("覆盖项还原(键存在才设)", () => {
    const p = parseConfigJson(`{
      "listen": "socks://127.0.0.1:1080",
      "proxy": "https://a.example",
      "insecure-concurrency": 2,
      "tunnel-timeout": 900,
      "no-post-quantum": true,
      "log-net-log": "C:/netlog.json"
    }`);
    expect(p.advanced.insecureConcurrency).toBe(2);
    expect(p.advanced.tunnelTimeout).toBe(900);
    expect(p.debug.noPostQuantum).toBe(true);
    expect(p.debug.logNetLog).toBe("C:/netlog.json");
  });

  it("坏 JSON / 缺 listen / 坏类型 抛 ImportError", () => {
    expect(() => parseConfigJson("{")).toThrow(ImportError);
    expect(() => parseConfigJson(`{"proxy": "https://a.example"}`)).toThrow(/listen/);
    expect(() => parseConfigJson(`{"listen": [42], "proxy": "https://a.example"}`)).toThrow(ImportError);
  });
});

describe("parse × render: 往返", () => {
  const cases: { name: string; json: string }[] = [
    { name: "README 示例", json: `{"listen":"socks://127.0.0.1:1080","proxy":"https://user:pass@example.com","log":""}` },
    { name: "多监听", json: `{"listen":["socks://127.0.0.1:1080","http://127.0.0.1:8080"],"proxy":"https://a.example"}` },
    { name: "多跳链", json: `{"listen":"socks://127.0.0.1:1080","proxy":"https://front.example:443,https://u:p@end.example:443"}` },
    { name: "multi 数组", json: `{"listen":["socks://127.0.0.1:1080","socks://127.0.0.1:1081"],"proxy":["https://a.example","quic://b.example"]}` },
    { name: "IPv6 监听", json: `{"listen":"socks://[::1]:1080","proxy":"https://a.example"}` },
  ];

  for (const c of cases) {
    it(`往返一致:${c.name}`, () => {
      const p1 = parseConfigJson(c.json);
      const r1 = renderConfig(p1);
      const p2 = parseConfigJson(JSON.stringify(r1));
      const r2 = renderConfig(p2);
      expect(r2).toEqual(r1);
    });
  }

  it("分享链接 → render 得到标准 config", () => {
    const p = parseNaiveShareUrl("naive+https://user:pass@example.com#t");
    expect(renderConfig(p)).toEqual({
      listen: ["socks://127.0.0.1:1080"],
      proxy: "https://user:pass@example.com:443",
      log: "",
    });
  });
});

describe("importFromText 自动识别", () => {
  it("naive+ 前缀 → url", () => {
    expect(importFromText("naive+https://u:p@a.example").kind).toBe("url");
  });
  it("{ 开头 → config", () => {
    expect(importFromText(`{"listen":"socks://127.0.0.1:1080"}`).kind).toBe("config");
  });
  it("其他 → 抛错", () => {
    expect(() => importFromText("hello world")).toThrow(ImportError);
  });
});
