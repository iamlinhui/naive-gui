# NaïveProxy 桌面配置客户端 设计文档

| | |
|---|---|
| 项目代号 | `naive-gui` |
| 技术栈 | Tauri 2 + Rust / Vue 3 + TypeScript |
| 状态 | Draft v1.0 |
| 目标平台 | Windows(主要)/ macOS / Linux(Tauri 天然跨平台,系统集成按平台适配) |
| 读者 | 实现者(本人/协作者)、评审者 |

文档中形如 `naive_config.cc:105` 的引用均指本仓库(`naiveproxy/src/net/tools/naive/`)中的源码位置,作为配置契约的依据。

---

## 1. 项目概述

### 1.1 目标

为 [naive](https://github.com/klzgrad/naiveproxy) 命令行客户端提供图形界面:

1. **Profile 管理**:新建/编辑/删除/导入/导出服务器配置档案;
2. **一键连接**:渲染 `config.json` → 拉起 naive 子进程 → 健康检查 → 状态反馈;
3. **日志面板**:实时查看 naive stderr 输出;
4. **连通性测试**:本地端口 + 端到端(SOCKS/HTTP 隧道)分级探测;
5. **系统集成**(Windows 优先):系统代理一键设置与还原、托盘、开机自启、单实例。

### 1.2 非目标(v1 不做)

- 不修改 naive 源码、不内置代理内核(naive 以外部子进程方式使用);
- 不做流量统计/分流规则(那是路由器/Clash 类工具的领域);
- 不做服务端(Caddy/forwardproxy)配置生成(v2 可考虑);
- 不做 naive 二进制自动下载(naive 以资源文件随包分发,见 §2.2 D10;v2 可选自动下载 GitHub Releases 更新)。

### 1.3 核心用户故事

- 我粘贴一个 `naive+https://user:pass@example.com` 分享链接,点"连接",系统代理生效,能上网;
- 我在多个服务器之间一键切换,切换时旧进程干净退出、系统代理无残留;
- 连不上时,界面能告诉我:是本地端口问题、服务器认证问题,还是网络不通;
- 我能实时看到 naive 的日志,定位问题后关掉日志不留痕迹(默认隐私优先)。

---

## 2. 总体架构

### 2.1 架构图

```
┌─────────────────────────── Tauri App ────────────────────────────┐
│  WebView (Vue 3 + TS)                Rust Backend (tokio)        │
│  ┌────────────────────────┐          ┌────────────────────────┐  │
│  │ 视图/组件 (§9)          │          │ commands/  (§8 IPC)     │  │
│  │ Pinia stores           │ ◄──────► │ process/   进程管理(§7) │  │
│  │ lib/schema.ts          │  IPC+事件 │ nettest/   连通性(§7.6) │  │
│  │ lib/render.ts   ───────┼──渲染JSON │ sysproxy/  (§10)       │  │
│  │ lib/validate.ts        │          │ store/     持久化(§6.3) │  │
│  └────────────────────────┘          └───────────┬────────────┘  │
└──────────────────────────────────────────────────┼───────────────┘
                                                   │ spawn + pipe
                                                   ▼
                                       naive.exe <config.json>
                                                   │
                                                   ▼
                              socks://127.0.0.1:1080 / http://127.0.0.1:8080
```

### 2.2 进程模型与关键决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | naive 以**子进程**运行,GUI 不链接/不修改其源码 | naive 每次 Chrome 版本 rebase(README"Notes for downstream"),二进制契约解耦,升级互不影响 |
| D2 | GUI 与 naive 的**唯一契约** = `config.json` + stderr 文本 + 退出码 | 契约面最小化;用户可拿导出的 config.json 手工运行排障 |
| D3 | 配置的 **render/parse/validate 全部在前端 TS 实现**(纯函数) | 单一实现源;表单需要实时校验;vitest 表驱动测试直接复用 §5 规则表;Rust 侧不重复实现,只做 IO |
| D4 | v1 **同时只运行一个 Profile** | 避免端口冲突与状态混乱;进程管理器内部支持多进程,UI 层面收窄,v2 可放开 |
| D5 | 密码 v1 以明文存本地 `profiles.json`(文件 ACL 保护),提供"不记住密码"选项 | Windows Credential Manager 集成留 v2(见 §11) |
| D6 | UI 组件库选 **Naive UI**(备选 Element Plus) | Vue3 + TS 优先、体积可控、表单组件齐全(与 NaïveProxy 同名纯属巧合) |
| D7 | 系统代理经 `sysproxy` crate 设置,带**快照/还原** | clash-verge 同款方案,支持 Win/macOS/Linux |
| D8 | 配置传递用**文件路径**,绝不用 `--listen= --proxy=` 命令行 | 密码会出现在进程命令行(任务管理器/WMI 可见),文件方式不泄露 |
| D9 | 每次连接**重写** `runtime/<id>/config.json` | Profile 即唯一事实源,杜绝手改运行文件导致的漂移 |
| D10 | naive 二进制**随包分发**(`bundle.resources` → 程序同目录),路径解析:设置显式路径 → 程序同目录自动发现 | 分发即用、用户零配置;显式路径仍可覆盖(如自行换内核版本) |
| D11 | 数据目录**双模式**:程序同目录存在 `portable` 标记(打包版默认携带)→ `<程序目录>/data`;否则或目录不可写 → `%APPDATA%`;首次切换自动迁移 | 「整个文件夹拷到哪,配置就跟到哪」的便携分发;系统安装场景退回系统目录,数据不丢 |

### 2.3 技术栈清单

**前端**:`vue@3.5+`、`typescript`、`vite`、`pinia`、`naive-ui`、`zod`(Profile schema)、`vue-i18n`(zh-CN / en,v1.1)。

**Rust 侧**:`tokio`(进程/异步)、`serde`/`serde_json`、`sysproxy`(系统代理)、`reqwest`(socks + http 代理探测)、`thiserror`/`anyhow`。

**Tauri 插件**:`single-instance`(单实例)、`autostart`(开机自启)、`dialog`(文件选择)、`opener`(打开目录/链接)、`log`(应用自身日志)。**不使用** shell 插件——子进程由 Rust 侧自行管理,权限面更小。

---

## 3. 配置契约:naive config.json 规范(自源码提炼)

> 本节是整个项目的**外部契约**,render/validate 必须逐条对应。来源:`naive_config.cc`、`naive_config.h`、`naive_proxy_bin.cc`、`USAGE.txt`。

### 3.1 字段总表

| 字段 | 类型 | 默认值 | 说明与约束 |
|---|---|---|---|
| `listen` | string 或 string[] | `socks://0.0.0.0:1080` | URI 语法 `<proto>://[user:pass@][addr][:port]`;proto ∈ {`socks`,`http`,`redir`};**`redir` 仅 Linux**(`naive_config.cc:38`);addr 必须是 **IP 字面量**(以 `IPAddress(string)` 解析,主机名会监听失败);userinfo 解析时做 URL 解码(`naive_config.cc:50-55`) |
| `proxy` | string 或 string[] | 无(直连) | 每个数组元素是一条**逗号分隔的代理链**;URI 语法 `<scheme>://[user:pass@]host[:port]`;scheme ∈ {`http`,`https`,`quic`,`socks`};**空字符串是硬错误**(`naive_config.cc:170`);端口缺省按协议(https/443, http/80, socks/1080, quic/443) |
| `insecure-concurrency` | int/string | 1 | ≥1;>1 降低抗流量分析强度,>4 强烈不建议 |
| `tunnel-timeout` | int/string(秒) | 1800(Android 600) | ≥1;会中断 SSH 等长连接 |
| `idle-timeout` | int/string(秒) | 600(Android 300) | ≥1 |
| `extra-headers` | string | 无 | CRLF 分隔的 `Name: value` 行(`naive_config.cc:159`) |
| `host-resolver-rules` | string | 无 | 如 `"MAP proxy.example.com 1.2.3.4"` |
| `resolver-range` | string(CIDR) | `100.64.0.0/10` | **仅 IPv4**;IPv6 报错(`naive_config.cc:281`);仅 redir 模式用到 |
| `log` | string | 无(LOG_NONE) | 非空 → 写文件;**空串 → 输出到 stderr**(`naive_config.cc:291-304`)。默认无日志是隐私设计 |
| `log-net-log` | string(路径) | 无 | NetLog,敏感 |
| `ssl-key-log-file` | string(路径) | 无 | **可解密全部流量**,最高敏感 |
| `no-post-quantum` | 任意(键存在即生效) | 未设置 | `value.contains(...)` 判断**键存在**(`naive_config.cc:324`),因此 render 只能在 true 时写入;写 `false` 也会被当作开启! |

### 3.2 代理链规则(易错点集中区)

1. **位置配对**:proxy 数组 ≥2 时,**listen 数量必须相等,按位置一一配对**(每条链对应一个 listen);仅 1 条链时所有 listen 共用(`naive_proxy_bin.cc:524-529`,违反则进程直接退出);
2. **QUIC 顺序**:链中 QUIC 跳必须全部位于任何 TCP 跳**之前**(`naive_config.cc:208-213`,否则 "QUIC proxy cannot follow TCP-based proxies");
3. **SOCKS 限制**:不支持链式(链长 >1 含 SOCKS 即错误,`naive_config.cc:238-248`)、不支持认证(带认证仅 stderr 警告、**不中断**,`naive_config.cc:225-227`)、无 Naive padding;
4. **padding 语义**:链中**最后一跳**自动协商 Naive padding(USAGE.txt:68),无需 UI 配置;UI 只需提示"SOCKS 作为末跳无 padding"。

### 3.3 其他行为细节(影响 UI/实现)

- `"listen": []`(空数组)→ 保留默认单监听 `socks://0.0.0.0:1080`(`naive_config.cc:95-97` 的 clear 条件);
- `"proxy": []`(空数组)→ 等效直连(循环体不执行,chains 为空);想直连就**不写该键**;
- 启动成功标志:stderr 出现 `Listening on <proto>://<addr>:<port>`(`naive_proxy_bin.cc:549`,LOG(INFO));
- 端口监听失败:stderr `Failed to listen on ...` 后进程退出码非 0;
- config 解析错误:stderr `Invalid ...`(cerr 直写,`naive_config.cc` 各处)→ 理论上被 §5 校验拦截,出现即视为 GUI bug;
- `redir` 模式会在同端口 UDP 启动内置 DNS 解析器(USAGE.txt:50);
- naive 无参数运行时使用 CWD 的 `config.json`;GUI 始终传**绝对路径**。

### 3.4 配置示例

最小配置(README 示例):

```json
{
  "listen": "socks://127.0.0.1:1080",
  "proxy": "https://user:pass@example.com",
  "log": ""
}
```

GUI 渲染的多链 + 高级配置示例:

```json
{
  "listen": ["socks://127.0.0.1:1080", "http://127.0.0.1:8080"],
  "proxy": ["https://u:p@a.example", "quic://u2:p2@b.example,https://c.example"],
  "insecure-concurrency": 2,
  "tunnel-timeout": 900,
  "extra-headers": "X-Header: v",
  "host-resolver-rules": "MAP a.example 1.2.3.4",
  "log": ""
}
```

---

## 4. 数据模型

### 4.1 Profile(前端 TS,zod schema)

```ts
type ProxyScheme = 'https' | 'http' | 'quic' | 'socks';

interface ProxyHop {
  scheme: ProxyScheme;
  host: string;                 // 域名或 IP(IPv6 渲染时加 [])
  port?: number;                // 缺省 → 协议默认端口
  auth?: { user: string; pass: string };
}
type ProxyChain = ProxyHop[];   // 长度 1 = 单跳;最后一跳 = Naive 服务端

interface ListenEndpoint {
  proto: 'socks' | 'http' | 'redir';   // redir 仅 Linux 平台显示
  addr: string;                 // 必须 IP 字面量
  port: number;                 // 1-65535
  auth?: { user: string; pass: string };  // 本地入站认证(redir 忽略)
}

interface Profile {
  id: string;                   // uuid v4
  name: string;
  schemaVersion: 1;
  createdAt: number; updatedAt: number;

  server: ProxyChain;           // 默认/唯一代理链
  routingMode: 'single' | 'multi';
  chains?: ProxyChain[];        // multi 模式:长度必须等于 listen.length(≥2)

  listen: ListenEndpoint[];     // ≥1
  advanced: {
    insecureConcurrency?: number;   // 不设 → 不写入 config(用 naive 默认 1)
    tunnelTimeout?: number;
    idleTimeout?: number;
    extraHeaders?: string;
    hostResolverRules?: string;
    resolverRange?: string;
  };
  debug: {
    log: 'stderr' | 'none' | { file: string };   // 默认 'stderr'(GUI 捕获显示)
    logNetLog?: string;
    sslKeyLogFile?: string;
    noPostQuantum?: boolean;
  };
}
```

### 4.2 AppSettings

```ts
interface AppSettings {
  language: 'zh-CN' | 'en';
  theme: 'auto' | 'light' | 'dark';
  naiveBinaryPath: string | null;      // naive 可执行文件路径
  autoStartApp: boolean;               // 开机自启(autostart 插件)
  autoConnectProfileId: string | null; // 启动 App 后自动连接
  minimizeToTray: boolean;             // 关闭按钮 → 隐藏到托盘
  setSystemProxyOnConnect: boolean;    // 连接成功后自动设系统代理
  sysProxyBypass: string;              // 默认见 §10.3
}
```

### 4.3 概念映射(Profile → config.json)

| Profile 概念 | config.json 键 | 备注 |
|---|---|---|
| `listen[]` | `listen`(数组) | 始终渲染为数组(单元素也用数组,naive 两种都接受) |
| `server`(single) | `proxy`(string) | 单链渲染为字符串 |
| `chains[]`(multi) | `proxy`(数组) | 长度 == listen.length 已由校验保证 |
| `advanced.*` | 对应键 | **仅显式设置才写入**(undefined → 省略,吃 naive 默认值) |
| `debug.log` | `log` | `stderr` → `""`;`none` → 省略;`{file}` → 路径 |
| `debug.noPostQuantum` | `no-post-quantum` | **仅 true 时写 `true`**(键存在即生效,见 §3.1) |

---

## 5. 校验规则表(validate.ts 的实现规格)

错误码 `V-xx-nn`,级别 error(阻断保存/启动)/ warning(提示)/ info(说明)。

### 5.1 监听(listen)

| ID | 规则 | 级别 |
|---|---|---|
| V-L-01 | proto ∈ {socks, http, redir} | error |
| V-L-02 | redir 仅在 Linux 平台可选(其余平台隐藏该选项) | error |
| V-L-03 | addr 必须是合法 IPv4/IPv6 **字面量**(快捷选项:127.0.0.1 / 0.0.0.0 / ::1) | error |
| V-L-04 | port ∈ [1, 65535] | error |
| V-L-05 | 同一 Profile 内端口重复;或与常见端口(80/443 等)冲突提示 | warning |
| V-L-06 | 本地入站认证的特殊字符将在渲染时百分号编码(自动处理) | info |

### 5.2 代理链(proxy)

| ID | 规则 | 级别 |
|---|---|---|
| V-P-01 | scheme ∈ {https, http, quic, socks} | error |
| V-P-02 | host 非空,且为合法域名或 IP | error |
| V-P-03 | port ∈ [1, 65535] 或留空(用协议默认) | error |
| V-P-04 | 链内 QUIC 跳必须全部位于 TCP 跳之前(§3.2-2) | error |
| V-P-05 | 链长 >1 时不得包含 SOCKS 跳(§3.2-3) | error |
| V-P-06 | SOCKS 跳携带认证 → 不支持,保存时将被忽略 | warning |
| V-P-07 | multi 模式:chains.length ≥2 且 === listen.length(§3.2-1) | error |
| V-P-08 | 提示:padding 仅对链末跳自动协商;SOCKS 末跳无 padding | info |
| V-P-09 | 多跳链(前置 CDN/中转)场景提示:末跳才是 Naive 服务端 | info |

### 5.3 高级 / 诊断

| ID | 规则 | 级别 |
|---|---|---|
| V-A-01 | insecureConcurrency ≥1;>1 显示安全性警示文案;>4 强警示(USAGE.txt:80-86 原文口径) | warning |
| V-A-02 | tunnelTimeout / idleTimeout ≥1(秒) | error |
| V-A-03 | resolverRange 须为合法 IPv4 CIDR;非 redir 模式下设置时提示无效 | error / warning |
| V-A-04 | extraHeaders 每行须为合法 `Name: value`(CRLF 分隔) | warning |
| V-D-01 | log 文件路径的父目录存在且可写(启动前由 Rust 复核) | error |
| V-D-02 | logNetLog / sslKeyLogFile 开启需二次确认弹窗(隐私) | warning |

### 5.4 启动前检查(Rust 侧)

- naive 二进制解析(§2.2 D10):设置显式路径 → 程序同目录 `naive[.exe]`(打包自带);都缺失 → 报错列出尝试过的位置,指引放文件或去设置页;
- `runtime/<profileId>/` 可写;
- 二进制版本检测:`naive --version` 输出解析(用于顶栏徽章 + "保持最新"提醒,README 强调旧版本指纹会偏离 Chrome)。

---

## 6. 存储设计

### 6.1 文件布局(§2.2 D11:双模式)

```
{dataRoot}/                            # 便携模式:Windows/Linux <程序目录>/data
                                       #           macOS <NaiveGUI.app 同级>/data
                                       # 标准模式:Windows %APPDATA%/com.naive-gui.app
                                       #           macOS ~/Library/Application Support/com.naive-gui.app
  settings.json                        # AppSettings(原子写)
  profiles.json                        # Profile[](原子写:temp + rename)
  runtime/<profileId>/config.json      # 每次连接重写(§2.2 D9)
  runtime/<profileId>/*.log            # naive.log / state.log / ui.log / naive.pid
  sysproxy.snapshot.json               # 系统代理快照(§10.4)
  logs/app.log                         # GUI 自身日志(tauri-plugin-log,滚动)
```

- **便携判定**:exe 同目录存在 `portable` 标记文件(打包版经 `bundle.resources` 默认携带,开发模式无标记;macOS 标记位于 `NaiveGUI.app/Contents/Resources/`,数据目录取 .app 同级以保持「文件夹便携」语义);
- **回退**:标记存在但程序目录不可写(如装进 Program Files、挂载只读 DMG)→ 自动退回系统目录;
- **迁移**:首次以便携模式启动时,把系统目录既有的 `profiles.json`/`settings.json`/`sysproxy.snapshot.json` 拷贝进便携数据根(只补不覆盖,来回切换不丢数据)。

### 6.2 原子写

所有持久化 JSON 走"写临时文件 → rename"两步,避免崩溃导致半截文件;读取时 schema 不符 → 备份损坏文件后重建空库并提示。

### 6.3 schema 版本与迁移

`profiles.json` 顶层带 `schemaVersion`;加载时按版本链式迁移(1 → 2 → …),每步纯函数 + 单测。v1 即为版本 1。

---

## 7. 进程管理器(Rust)

### 7.1 状态机

```
              start()              ready 检测通过(§7.3)
  idle ───────────────► starting ─────────────────► running
   ▲                       │                            │
   │        失败/超时/早退  │                     stop() │
   │                       ▼                            ▼
   │                    stopped ◄────────────────── stopping ──优雅期到──► 强杀
   │                   (reason)      ▲
   └──────── 崩溃自动重启(§7.5)──────┘
```

状态:`idle | starting | running | stopping | stopped{ reason: user | crash | failed-to-start, exitCode? }`。状态变更通过事件 `runtime:state` 推送前端,Pinia `runtimeStore` 是 UI 侧唯一状态源。

### 7.2 spawn 细节

- 命令:`naive.exe <abs-path-to-config.json>`,无其他参数(§2.2 D8);
- Windows:`CREATE_NO_WINDOW (0x08000000)` 防止控制台闪窗;`stdout` 忽略、**stderr 建管道**;
- 工作目录设为 `runtime/<profileId>/`(相对路径的 log 文件落到这里);
- 进程句柄存入 `Manager`(tokio Mutex HashMap);App 退出钩子里统一 terminate(§7.4)。

### 7.3 ready 检测

1. 逐行读 stderr,正则匹配 `^Listening on (\w+)://([^\s:]+):(\d+)`(`naive_proxy_bin.cc:549`)→ 状态转 `running`;
2. 兜底:starting 后 10s 内未见到该行 → 主动 TCP 探测所有 listen 端口,通 → `running`,不通 → `failed-to-start`(保留已收到的 stderr 供诊断);
3. stderr 每行原样转发事件 `runtime:log`(带时间戳),前端日志面板滚动显示,环形缓冲最近 5000 行。

### 7.4 stop 与退出清理

- `stop()`:Windows `taskkill /T /F` 等效(直接 kill 子进程;naive 无子进程树,`Child::kill` 即可)→ `stopping` → 确认退出 → `stopped(user)`;
- App 正常退出:停进程 → **还原系统代理快照**(§10.4)→ 退出;
- App 崩溃残留:下次启动检测"系统代理指向本机端口但无存活进程" → 自动还原并提示(自愈)。

### 7.5 崩溃重启策略

`running` 状态下进程意外退出 → `stopped(crash)`;若存活时长 <60s,按退避 2s/4s/8s/16s/32s 自动重启,5 次后放弃并在 UI 报错;存活 >60s 视为稳定运行过,重启计数清零。自动重启可通过 Profile 级开关关闭(默认开)。

### 7.6 连通性测试(nettest)

分两级,输入为 listen 端点列表:

| 级 | 方法 | 判定 |
|---|---|---|
| L1 本地 | tokio `TcpStream::connect`(addr 为 0.0.0.0/:: 时改连 127.0.0.1/::1) | 连通 = 本地服务活着 |
| L2 端到端 | `reqwest` + `Proxy::all(socks5://127.0.0.1:port)` 或 `http://…`,GET `http://cp.cloudflare.com/generate_204`,另测 `https://www.google.com/generate_204`(可选) | 204/任意 HTTP 状态 = 隧道通;记录耗时 |

结果码(`TestReport`):`local-tcp-fail | socks-handshake-fail | tunnel-error(疑似服务器认证/不可达) | timeout | ok{latencyMs}`。前端按层级给出差异化文案("检查本地端口/防火墙" vs "检查服务器地址与认证" vs "服务器可达但隧道失败")。

---

## 8. Tauri IPC API

### 8.1 Commands

| 命令 | 参数 → 返回 | 说明 |
|---|---|---|
| `list_profiles` | → `Profile[]` | 含完整字段 |
| `save_profile` | `Profile` → `()` | 前端已校验;Rust 只做 JSON 落盘 |
| `delete_profile` / `duplicate_profile` | `id` → `()` / `Profile` | 删除前若在运行则先 stop |
| `import_from_text` | `text` → `Profile` | 自动识别 naive+ URL / config.json(解析在前端) |
| `start_runtime` | `{ profileId, configJson }` → `()` | 渲染在前端;Rust 写文件 + spawn(§7) |
| `stop_runtime` | → `()` | |
| `runtime_status` | → `RuntimeStatus` | 断线重连后主动拉取 |
| `test_connectivity` | `ListenEndpoint[]` → `TestReport` | §7.6 |
| `sysproxy_status` / `sysproxy_enable` / `sysproxy_disable` | | §10 |
| `get_settings` / `set_settings` | | |
| `detect_naive_binary` | `path` → `{ ok, version }` | 跑 `--version` 解析 |
| `open_path` | `path` → `()` | opener 插件封装(打开 runtime 目录等) |

### 8.2 Events(Rust → UI)

| 事件 | payload |
|---|---|
| `runtime:log` | `{ profileId, ts, line }` |
| `runtime:state` | `{ profileId, state, reason?, exitCode? }` |

### 8.3 安全基线

- CSP 严格限定 `self`,无远程内容;capabilities 仅授予上述命令与所需插件;
- 所有命令在本机文件系统上的写操作仅限 `appDataDir` 子树(导出/日志文件路径除外,且须经用户通过 dialog 显式选择)。

---

## 9. 前端设计

### 9.1 视图结构(单窗口,无路由)

```
App.vue
├─ TitleBar            # 标题 + naive 版本徽章 + 主题切换 + 设置按钮
├─ MainLayout
│  ├─ ProfileSidebar   # 顶部状态条(状态点/延迟徽章)+ 列表(名称/状态点)、新建、导入
│  └─ DetailPane       # 选中 Profile 的编辑区 + 运行区
│     ├─ Tabs: [服务器] [本地监听] [高级] [诊断]
│     └─ ActionBar     # 连接/停止、系统代理开关、测试按钮
├─ SettingsDialog      # AppSettings(二进制路径、自启、语言、主题…)
├─ ImportDialog        # 粘贴 naive+ URL / 选择 config.json
└─ TrayIcon            # 显示/隐藏、快速切换 Profile、连接/断开、退出
```

### 9.2 线框图(主窗口)

```
┌────────────────────────────────────────────────────────────────────┐
│ NaïveProxy 客户端      [naive v131.0.6778.85]        🌓  ⚙          │
├──────────────┬─────────────────────────────────────────────────────┤
│ ● 运行中 23ms │  [服务器] [本地监听] [高级] [诊断]                    │
│ 配置档案     │─────────────────────────────────────────────────────│
│ ● 服务器 A    │  协议   (https)(quic)(http)(socks)  ← Segmented      │
│ ○ 服务器 B    │  地址   [ example.com        ]  端口 [443]           │
│ ○ 公司中转    │  认证   用户 [______]  密码 [********] [👁]           │
│ ＋导入  ＋新建 │  ▸ 代理链(高级,默认收起:单跳时隐藏)                  │
│              │                                                     │
├──────────────┴─────────────────────────────────────────────────────┤
│ ● 运行中  socks://127.0.0.1:1080   [测试]   系统代理 [ON]   [停止]  │
└────────────────────────────────────────────────────────────────────┘
```

要点:

- **服务器 Tab**:90% 用户只填 scheme/host/port/user/pass;默认 `https` + 443;展开"代理链"后才出现多跳编辑(上/下移、增删跳,实时执行 V-P-04/05/06);
- **本地监听 Tab**:行式编辑器(proto 下拉 + addr + port),预置模板按钮 `[socks 1080]` `[socks+http]`;multi 模式下每行左侧显示配对链的摘要(V-P-07 联动校验);
- **高级 Tab**:全部为可选覆盖项,空 = 用 naive 默认;`insecure-concurrency` 带警示文案(引用 USAGE 口径);
- **诊断 Tab**:日志面板(自动滚动/暂停/复制/清空/导出)+ 连通性测试按钮与结果分级展示 + `log-net-log`/`ssl-key-log-file`(黄底警告区,V-D-02 二次确认)。
- **侧栏顶部状态条**:状态点 + 状态文字 + 延迟徽章(连通性测试耗时,阈值见 UI_SPEC §3);底部 StatusBar 不再重复显示延迟徽章。

### 9.3 交互流:连接

```
点击[连接]
  → validate(profile)        error? → 行内标红,终止
  → renderConfig(profile)    → configJson
  → start_runtime            → starting(按钮转菊花)
  ← runtime:state running    → 自动执行 setSystemProxyOnConnect?
  → test_connectivity(L2)    → 状态条延迟徽章
  失败任意一步 → 状态条红色 + 诊断链接(跳诊断 Tab)
```

切换 Profile = stop(旧)→ start(新)串行执行,期间按钮锁定防重入。

### 9.4 Pinia stores

| store | 职责 |
|---|---|
| `profilesStore` | 列表 CRUD、当前选中、脏状态跟踪(未保存提醒) |
| `runtimeStore` | 订阅 `runtime:state/log`,派生 `isRunning/currentProfile/logs ring buffer` |
| `settingsStore` | AppSettings 读写、i18n/主题应用 |
| `sysproxyStore` | 系统代理状态镜像 + 开关 |

---

## 10. 系统代理集成

### 10.1 实现

`sysproxy` crate(Windows 注册表 / macOS networksetup / GNOME);设置 `ProxyServer` 为 **http 监听端点**(SOCKS 监听不能直接作系统代理)。若 Profile 只有 socks 监听而用户要开系统代理 → 引导一键"添加 http://127.0.0.1:8080 监听"。

### 10.2 生效范围说明(UI 文案)

仅影响 WinINET/WinHTTP 系应用;命令行工具、部分 UWP/浏览器自定义配置不受影响 → 帮助页说明。

### 10.3 默认 bypass

`localhost;127.*;10.*;172.16.*-172.31.*;192.168.*;<local>`(可编辑)。

### 10.4 快照与还原

`sysproxy_enable` 前把当前 `ProxyEnable/ProxyServer/AutoConfigURL` 存入 `settings.json` 旁的 `sysproxy.snapshot.json`;`disable` / App 退出 / 下次启动自愈(§7.4)时恢复;快照文件带进程存活标记防止误还原。

---

## 11. 安全与隐私设计

| 项 | 设计 |
|---|---|
| 威胁模型 | 本地单用户工具;敏感面 = 服务器凭据、日志、ssl-key-log |
| 凭据 | v1 明文存 `profiles.json`(依赖用户目录 ACL);每 Profile 可勾选"不保存密码"(每次连接时询问);v2:Windows Credential Manager(`keyring` crate) |
| 默认隐私 | 默认 `log: ""`(仅 GUI 内存中查看,**不落盘**);`log-net-log`、`ssl-key-log-file` 默认关闭且置于警告区,开启需二次确认(V-D-02)——对齐 naive "默认无日志" 的隐私立场 |
| 进程命令行 | 不传 `--proxy=`,密码不进命令行(§2.2 D8) |
| runtime config.json | 含明文密码,位于数据目录(便携模式随程序文件夹走,勿分享整个文件夹);导出 config.json 时弹窗提醒"内含密码" |
| Tauri | CSP self-only;capability 最小化(§8.3);发布产物走 updater 签名(v1.1) |
| 更新提醒 | 顶栏显示 naive 版本;README 要求"始终用最新版保持与 Chrome 指纹一致" → 版本过旧时提示(不自动联网查询,v2 可选) |

---

## 12. 错误处理

- **前端**:校验错误行内展示(锚点到出错 Tab);运行错误走通知(toast)+ 诊断 Tab 深链;
- **Rust**:`thiserror` 定义 `AppError`(NotFound / Io / Spawn / SysProxy / NetTest …),`serde` 序列化为 `{ code, message }` 供前端 i18n;
- **GUI 自身日志**:`tauri-plugin-log` 写 `logs/app.log`(与 naive 日志分离,便于排障)。

---

## 13. 测试策略

| 层 | 工具 | 内容 |
|---|---|---|
| render / parse / validate 单测 | vitest | **表驱动**,用例直接来自 §3/§5 规则表(含 §3.3 全部边角:空数组、空串、QUIC 顺序、SOCKS 链、no-post-quantum 存在语义);golden-file:Profile → 期望 config.json 快照 |
| 导入解析 | vitest | `naive+https://u:p@h:port#name`、config.json 反解析(含多链/百分比编码) |
| 进程管理 | cargo test + **fake-naive** | 用一个测试用小二进制(打印 `Listening on …` 后 sleep,响应 kill,可注入崩溃/超时)驱动 FSM:ready、早退、崩溃退避、stop 超时强杀 |
| nettest | cargo test | 对本地起的 dummy SOCKS/HTTP server 测各结果码 |
| 手工清单 | docs | 真实 naive + 真实服务器:连接/系统代理/托盘/自启/单实例/退出还原 |

---

## 14. 项目目录结构

```
naive-gui/
├── DESIGN.md                     # 本文档
├── README.md                     # 项目说明(环境/开发/打包/便携模式/CI)
├── .github/workflows/            # GitHub Actions:test(单测)+ release(手动发布构建)
├── package.json / vite.config.ts / tsconfig.json
├── src/                          # Vue 前端
│   ├── components/
│   │   ├── profile/              # ServerForm, ProxyChainEditor, ListenEditor,
│   │   │                         # AdvancedForm, DebugForm
│   │   ├── runtime/              # StatusBar, LogPanel, ConnectivityPanel
│   │   └── common/               # 表单控件、对话框
│   ├── stores/                   # profiles / runtime / settings / sysproxy
│   ├── lib/
│   │   ├── schema.ts             # Profile 类型 + zod
│   │   ├── render.ts             # Profile → config.json(纯函数)
│   │   ├── parse.ts              # naive+ URL / config.json → Profile
│   │   ├── validate.ts           # §5 规则表实现
│   │   └── codec.ts              # userinfo 百分号编码、IPv6 括号
│   ├── views/                    # MainLayout, SettingsDialog, ImportDialog
│   ├── i18n/                     # zh-CN / en
│   ├── App.vue / main.ts
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs                # builder + state + 插件注册
│   │   ├── error.rs
│   │   ├── commands/             # profiles.rs runtime.rs sysproxy.rs settings.rs misc.rs
│   │   ├── process/              # manager.rs fsm.rs ready.rs
│   │   ├── nettest/mod.rs
│   │   ├── sysproxy/mod.rs       # 快照/还原/自愈
│   │   └── store/mod.rs          # 原子读写
│   ├── capabilities/             # 最小权限声明
│   └── tauri.conf.json
├── tests/                        # fake-naive 及测试资产
└── docs/
```

---

## 15. 里程碑

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| M0 骨架 | Tauri+Vue 项目、布局、Profile CRUD(内存 + 落盘)、设置页 | 能新建/编辑/删除 Profile 并持久化重启不丢 |
| M1 配置内核 | zod schema、render/parse/validate 全量单测、导入/导出 | §13 表驱动用例全绿;示例 Profile 渲染结果与手工核对一致 |
| M2 进程管理 | spawn/stop/FSM、stderr 面板、ready 检测、崩溃退避、fake-naive e2e | 真实 naive 可连可断,日志实时滚动,崩溃 5 次退避后报错 |
| M3 集成 | 连通性测试、系统代理快照/还原/自愈、托盘、自启、单实例 | 切换/退出后系统代理无残留;托盘可快速切换 |
| M4 发布 | NSIS 安装包、图标、帮助页、(v1.1)签名更新器 | 干净 Win 机器安装即用 |

---

## 16. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| naive 新版调整配置面(上游 rebase) | §3 契约表 + 源码行号引用,变更时只需核对一处;render 快照测试暴露差异 |
| stderr 解析(ready 行)随上游改动 | 双保险:超时后回退端口探测(§7.3) |
| 杀软误报(无名签名 + 拉起子进程) | M4 代码签名;文档说明 |
| WebView2 依赖(Win10 以下) | 安装器捆绑引导 |
| 系统代理对部分应用不生效 | 帮助页说明 + bypass 可编辑 |
| 多 Profile 并发(v2) | 进程管理器已按 Map 设计,UI 收窄即可放开 |

---

## 附录 A:naive stderr 关键行与处理

| stderr 内容(源码) | 含义 | GUI 处理 |
|---|---|---|
| `Listening on <proto>://<addr>:<port>`(`naive_proxy_bin.cc:549`) | 监听成功 | ready 信号 |
| `Failed to listen on …`(`naive_proxy_bin.cc:543`) | 端口/地址不可用 | failed-to-start,提示端口占用 |
| `Invalid …`(`naive_config.cc` 各处) | config 非法 | 理论被 §5 拦截;出现即 GUI bug,提示上报 |
| `QUIC proxy cannot follow TCP-based proxies` | 链顺序错误 | 理论被 V-P-04 拦截 |
| `SOCKS proxy with auth is not supported` | SOCKS 带认证 | 理论被 V-P-06 拦截(warning) |
| `Proxying via …`(`naive_proxy_bin.cc:236`) | 链信息 | 日志面板原样展示 |

## 附录 B:术语

- **跳(hop)/ 链(chain)**:一条 proxy 数组元素是链,链内逗号分隔的 URI 是跳;末跳 = Naive 服务端;
- **padding**:NaïveProxy 填充协议,CONNECT 帧带 `padding` 头即启用,自动协商;
- **ready**:naive 完成 listen 且可接受本地连接的状态。
