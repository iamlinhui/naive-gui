import { describe, it, expect } from "vitest";
import { encodeUserinfo, decodeUserinfo, isIPv4, isIPv6, isIpLiteral, formatHost, formatUserinfo, parseHostPort } from "../src/lib/codec";

describe("userinfo 编解码", () => {
  it("保留字符不编码", () => {
    expect(encodeUserinfo("abc-._~!$&'()*+,;=")).toBe("abc-._~!$&'()*+,;=");
  });
  it("定界符 : 与 @ 必须编码(GURL 按它们切分 userinfo)", () => {
    expect(encodeUserinfo("a:b")).toBe("a%3Ab");
    expect(encodeUserinfo("us@er")).toBe("us%40er");
  });
  it("user/pass 结构:@ / : 等必须编码,分隔符 : 保留", () => {
    expect(formatUserinfo("us@er", "pa:ss")).toBe("us%40er:pa%3Ass");
  });
  it("非 ASCII 按 UTF-8 百分号编码", () => {
    expect(encodeUserinfo("中文")).toBe("%E4%B8%AD%E6%96%87");
  });
  it("解码往返", () => {
    expect(decodeUserinfo("%E4%B8%AD%E6%96%87")).toBe("中文");
    expect(decodeUserinfo("us%40er")).toBe("us@er");
  });
  it("孤立 % 不抛错(宽容)", () => {
    expect(decodeUserinfo("100%")).toBe("100%");
  });
});

describe("IPv4 判定", () => {
  it.each(["127.0.0.1", "0.0.0.0", "192.168.1.1", "255.255.255.255"])("%s 是 IPv4", (s) => {
    expect(isIPv4(s)).toBe(true);
  });
  it.each(["256.1.1.1", "1.2.3", "a.b.c.d", "01.2.3.4", "localhost", "1.2.3.4.5"])("%s 不是 IPv4", (s) => {
    expect(isIPv4(s)).toBe(false);
  });
});

describe("IPv6 判定", () => {
  it.each(["::1", "::", "2001:db8::1", "fe80::1", "2001:db8:0:0:0:0:2:1"])("%s 是 IPv6", (s) => {
    expect(isIPv6(s)).toBe(true);
  });
  it.each(["2001:db8:::1", "::ffff:192.168.1.1.1", "example.com", "1.2.3.4", ":1", "1:"])("%s 不是 IPv6", (s) => {
    expect(isIPv6(s)).toBe(false);
  });
  it("IPv4-mapped 是 IPv6;isIpLiteral 覆盖两者", () => {
    expect(isIPv6("::ffff:192.168.1.1")).toBe(true);
    expect(isIpLiteral("::ffff:192.168.1.1")).toBe(true);
    expect(isIpLiteral("127.0.0.1")).toBe(true);
    expect(isIpLiteral("example.com")).toBe(false);
  });
});

describe("formatHost / parseHostPort", () => {
  it("IPv6 加括号,IPv4/域名不加", () => {
    expect(formatHost("2001:db8::1")).toBe("[2001:db8::1]");
    expect(formatHost("example.com")).toBe("example.com");
  });
  it("parseHostPort 解析 [v6]:port 与 host:port", () => {
    expect(parseHostPort("[2001:db8::1]:8443")).toEqual({ host: "2001:db8::1", port: 8443 });
    expect(parseHostPort("example.com:443")).toEqual({ host: "example.com", port: 443 });
    expect(parseHostPort("example.com")).toEqual({ host: "example.com", port: undefined });
  });
});
