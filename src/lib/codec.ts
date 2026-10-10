/**
 * URI 编解码工具:userinfo 百分号编码、IPv6 括号(DESIGN.md §14 lib/codec.ts)。
 *
 * 依据:
 * - listen userinfo 由 naive 做 UnescapeBinaryURLComponent 解码(naive_config.cc:50-55)
 * - proxy userinfo 由 GetIdentityFromURL 提取(标准 percent-encoding)
 * - IPv6 host 必须带方括号才符合 GURL 语法
 */

/**
 * userinfo 中可安全不编码的字符(RFC 3986 unreserved + sub-delims)。
 * 注意 ':' 与 '@' 不在其中:
 * - ':' 是 GURL 切分 username/password 的定界符,出现即破坏解析;
 * - '@' 是 userinfo 与 host 的定界符。
 */
const RESERVED = /[A-Za-z0-9\-._~!$&'()*+,;=]/;

/** userinfo 百分号编码(':' 与 '@' 等定界符一律编码) */
export function encodeUserinfo(s: string): string {
  let out = "";
  for (const ch of s) {
    if (RESERVED.test(ch)) out += ch;
    else {
      const bytes = new TextEncoder().encode(ch);
      for (const b of bytes) out += "%" + b.toString(16).toUpperCase().padStart(2, "0");
    }
  }
  return out;
}

/** 百分号解码(decodeURIComponent 的宽容版:孤立 % 不抛错) */
export function decodeUserinfo(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** 判断是否 IPv6 字面量(含 %zone 的情形按不含处理,GUI 不支持 zone) */
export function isIPv4(s: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return false;
  return m.slice(1).every((o) => {
    const n = Number(o);
    return n <= 255 && !(o.length > 1 && o.startsWith("0"));
  });
}

export function isIPv6(s: string): boolean {
  if (!s.includes(":")) return false;
  const bare = s.startsWith("[") && s.endsWith("]") ? s.slice(1, -1) : s;
  if (bare.includes("%")) return false;
  if (!/^[0-9A-Fa-f:.]+$/.test(bare)) return false;
  if (bare === "::") return true;

  // 按 "::" 切:至多一处压缩
  const dc = bare.split("::");
  if (dc.length > 2) return false;

  let head: string[], tail: string[];
  if (dc.length === 2) {
    head = dc[0] === "" ? [] : dc[0].split(":");
    tail = dc[1] === "" ? [] : dc[1].split(":");
    // "::" 两侧不允许再出现空组(如 ":a::b"、"a::b:")
    if (head.some((g) => g === "") || tail.some((g) => g === "")) return false;
  } else {
    head = bare.split(":");
    if (head.some((g) => g === "")) return false; // 孤立的 ":" 非法
    tail = [];
  }

  const all = [...head, ...tail];
  if (all.length === 0) return false;
  const v4tail = isIPv4(all[all.length - 1]);
  const hexGroups = v4tail ? all.slice(0, -1) : all;
  if (hexGroups.some((g) => !/^[0-9A-Fa-f]{1,4}$/.test(g))) return false;
  const groups = hexGroups.length;
  if (dc.length === 2) return groups <= 8; // 压缩形式
  return groups === 8 || (v4tail && groups === 6); // 非压缩:8 组,或 6 组 + IPv4 尾
}

export function isIpLiteral(s: string): boolean {
  return isIPv4(s) || isIPv6(s);
}

/** host 渲染进 URI:IPv6 加括号 */
export function formatHost(host: string): string {
  return isIPv6(host) ? `[${host}]` : host;
}

/** 渲染 userinfo:用户名与密码分别编码,中间用明文 ':' 分隔 */
export function formatUserinfo(user: string, pass: string): string {
  return `${encodeUserinfo(user)}:${encodeUserinfo(pass)}`;
}

/** 解析 URI 的 host/port(去掉 []);host 留空表示无效 */
export function parseHostPort(hostPort: string): { host: string; port?: number } | null {
  const m = /^\[([0-9A-Fa-f:.]+)\](?::(\d+))?$/.exec(hostPort);
  if (m) return { host: m[1], port: m[2] ? Number(m[2]) : undefined };
  const m2 = /^([^:]+)(?::(\d+))?$/.exec(hostPort);
  if (m2) return { host: m2[1], port: m2[2] !== undefined ? Number(m2[2]) : undefined };
  return null;
}
