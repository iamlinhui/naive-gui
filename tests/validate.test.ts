import { describe, it, expect } from "vitest";
import { validateProfile, hasErrors, type ValidationIssue } from "../src/lib/validate";
import { newProfile } from "../src/lib/schema";
import type { Profile } from "../src/lib/schema";

const base = (): Profile => ({
  ...newProfile("t"),
  server: [{ scheme: "https", host: "example.com", port: 443 }],
});

const codes = (issues: ValidationIssue[]) => issues.map((i) => i.code);
const errs = (issues: ValidationIssue[]) => issues.filter((i) => i.severity === "error").map((i) => i.code);

/* navigator.userAgent 在 jsdom 下不是 Linux → V-L-02 生效 */
describe("V-L: 监听校验", () => {
  it("合法监听无 error", () => {
    expect(errs(validateProfile(base()))).toEqual([]);
  });

  it("V-L-03: 主机名不是 IP 字面量", () => {
    const p = base();
    p.listen = [{ proto: "socks", addr: "localhost", port: 1080 }];
    expect(errs(validateProfile(p))).toContain("V-L-03");
  });

  it("V-L-03: 合法 IPv4/IPv6 通过", () => {
    const p = base();
    p.listen = [
      { proto: "socks", addr: "127.0.0.1", port: 1080 },
      { proto: "http", addr: "::1", port: 8080 },
    ];
    expect(errs(validateProfile(p))).toEqual([]);
  });

  it("V-L-04: 端口越界", () => {
    const p = base();
    p.listen = [{ proto: "socks", addr: "127.0.0.1", port: 70000 }];
    expect(errs(validateProfile(p))).toContain("V-L-04");
  });

  it("V-L-05: 端口重复", () => {
    const p = base();
    p.listen = [
      { proto: "socks", addr: "127.0.0.1", port: 1080 },
      { proto: "http", addr: "127.0.0.1", port: 1080 },
    ];
    expect(errs(validateProfile(p))).toContain("V-L-05");
  });

  it("V-L-02: redir 在非 Linux 平台报错", () => {
    const p = base();
    p.listen = [{ proto: "redir", addr: "127.0.0.1", port: 1080 }];
    expect(errs(validateProfile(p))).toContain("V-L-02");
  });
});

describe("V-P: 代理校验", () => {
  it("V-P-02: host 非法", () => {
    const p = base();
    p.server = [{ scheme: "https", host: "bad host!", port: 443 }];
    expect(errs(validateProfile(p))).toContain("V-P-02");
  });

  it("V-P-03: 端口越界", () => {
    const p = base();
    p.server = [{ scheme: "https", host: "a.example", port: 0 }];
    expect(errs(validateProfile(p))).toContain("V-P-03");
  });

  it("V-P-04: QUIC 排在 TCP 之后(naive_config.cc:208)", () => {
    const p = base();
    p.server = [
      { scheme: "https", host: "front.example", port: 443 },
      { scheme: "quic", host: "b.example", port: 443 },
    ];
    expect(errs(validateProfile(p))).toContain("V-P-04");
  });

  it("V-P-04: QUIC 在前合法", () => {
    const p = base();
    p.server = [
      { scheme: "quic", host: "q.example", port: 443 },
      { scheme: "https", host: "end.example", port: 443 },
    ];
    expect(errs(validateProfile(p))).toEqual([]);
  });

  it("V-P-05: 多跳链含 SOCKS(naive_config.cc:238)", () => {
    const p = base();
    p.server = [
      { scheme: "socks", host: "1.2.3.4", port: 1080 },
      { scheme: "https", host: "end.example", port: 443 },
    ];
    expect(errs(validateProfile(p))).toContain("V-P-05");
  });

  it("V-P-05: 单跳 SOCKS 合法;但带认证出 V-P-06 warning", () => {
    const p = base();
    p.server = [{ scheme: "socks", host: "1.2.3.4", port: 1080, auth: { user: "u", pass: "p" } }];
    const issues = validateProfile(p);
    expect(errs(issues)).toEqual([]);
    expect(codes(issues)).toContain("V-P-06");
  });

  it("V-P-07: multi 模式链数 ≠ 监听数(naive_proxy_bin.cc:524)", () => {
    const p = base();
    p.routingMode = "multi";
    p.listen = [{ proto: "socks", addr: "127.0.0.1", port: 1080 }];
    p.chains = [
      [{ scheme: "https", host: "a.example", port: 443 }],
      [{ scheme: "https", host: "b.example", port: 443 }],
    ];
    expect(errs(validateProfile(p))).toContain("V-P-07");
  });

  it("V-P-07: 链数 === 监听数 且 ≥2 通过", () => {
    const p = base();
    p.routingMode = "multi";
    p.listen = [
      { proto: "socks", addr: "127.0.0.1", port: 1080 },
      { proto: "socks", addr: "127.0.0.1", port: 1081 },
    ];
    p.chains = [
      [{ scheme: "https", host: "a.example", port: 443 }],
      [{ scheme: "https", host: "b.example", port: 443 }],
    ];
    expect(errs(validateProfile(p))).toEqual([]);
  });

  it("V-P-09: 多跳链出 info 提示(末跳 = Naive 服务端)", () => {
    const p = base();
    p.server = [
      { scheme: "https", host: "front.example", port: 443 },
      { scheme: "https", host: "end.example", port: 443 },
    ];
    const infos = validateProfile(p).filter((i) => i.severity === "info");
    expect(infos.map((i) => i.code)).toContain("V-P-09");
  });
});

describe("V-A: 高级校验", () => {
  it("V-A-01: 并发 >1 出 warning,>4 更严重文案", () => {
    const p = base();
    p.advanced = { insecureConcurrency: 2 };
    expect(validateProfile(p).find((i) => i.code === "V-A-01")?.severity).toBe("warning");
    p.advanced = { insecureConcurrency: 8 };
    expect(validateProfile(p).find((i) => i.code === "V-A-01")?.severity).toBe("warning");
    p.advanced = { insecureConcurrency: 0 };
    expect(errs(validateProfile(p))).toContain("V-A-01");
  });

  it("V-A-02: 超时 <1 报错", () => {
    const p = base();
    p.advanced = { tunnelTimeout: 0 };
    expect(errs(validateProfile(p))).toContain("V-A-02");
  });

  it("V-A-03: resolverRange 非法 CIDR 报错;合法但无 redir 出 warning", () => {
    const p = base();
    p.advanced = { resolverRange: "not-a-cidr" };
    expect(errs(validateProfile(p))).toContain("V-A-03");
    p.advanced = { resolverRange: "100.64.0.0/10" };
    const i = validateProfile(p).find((x) => x.code === "V-A-03");
    expect(i?.severity).toBe("warning");
  });
});

describe("V-D: 诊断校验", () => {
  it("V-D-02: sslKeyLogFile 开启出 warning", () => {
    const p = base();
    p.debug = { log: "stderr", sslKeyLogFile: "C:/keys.log" };
    const i = validateProfile(p).find((x) => x.code === "V-D-02");
    expect(i?.severity).toBe("warning");
    expect(i?.message).toContain("解密");
  });
});

describe("hasErrors", () => {
  it("error 存在 → true;仅 warning/info → false", () => {
    const p = base();
    expect(hasErrors(validateProfile(p))).toBe(false);
    p.listen = [{ proto: "socks", addr: "localhost", port: 1080 }];
    expect(hasErrors(validateProfile(p))).toBe(true);
  });
});
