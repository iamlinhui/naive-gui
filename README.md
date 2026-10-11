# NaiveGUI

NaïveProxy 桌面配置客户端:为 [naiveproxy](https://github.com/klzgrad/naiveproxy) 命令行内核提供图形界面 —— 配置档案管理、一键连接、连通性测试、系统代理与托盘集成。

技术栈:Tauri 2 + Rust / Vue 3 + TypeScript + Naive UI + Pinia + Vite。支持 **Windows(NSIS 安装包)** 与 **macOS(dmg / .app,x64 + Apple Silicon)** 打包。

## 功能

- **Profile 管理**:新建/编辑/删除/复制/重命名/拖拽排序,支持 `naive+https://...` 链接与 config.json 导入;
- **一键连接**:渲染 config.json → 拉起 naive 子进程 → ready 检测 → 状态反馈(崩溃自动退避重启);
- **连通性测试**:L1 本地端口探测 + L2 端到端隧道握手,延迟徽章显示在配置列表的条目上(绿 <200ms / 黄 <400ms / 红);
- **系统集成**:系统代理一键设置/还原(快照 + 崩溃自愈)、托盘常驻、开机自启、单实例、关闭最小化到托盘;
- **日志与诊断**:naive stderr 实时面板(内存缓冲,默认不落盘),NetLog / SSL 密钥日志等高敏感选项带二次确认;
- **便携分发**:内核随包分发、同目录自动识别,配置可随文件夹走(见[便携模式](#便携模式配置跟着文件夹走))。

## 环境要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | **≥ 22**(推荐 22 LTS) | Vite 7 硬性要求 |
| pnpm | ≥ 10 | 使用 `pnpm-lock.yaml` |
| Rust | **≥ 1.85** | 依赖链使用 edition 2024,**1.83 及以下会直接编译失败** |
| VS Build Tools | 2019+ | Windows MSVC 链接器(安装时勾选「使用 C++ 的桌面开发」) |
| WebView2 Runtime | 系统自带 | Win10/11 一般已内置 |
| Xcode Command Line Tools | 任意 | 仅 macOS 本地打包需要(`xcode-select --install`) |

## 快速开始

```bash
pnpm install
pnpm test                                  # 前端单测(vitest)
cargo test --manifest-path src-tauri/Cargo.toml   # Rust 单测
```

### 开发模式

tauri-build 在编译期校验打包资源,所以**先放 naive 内核**:

1. 从 [naiveproxy Releases](https://github.com/klzgrad/naiveproxy/releases) 下载 `naiveproxy-<版本>-win-x64.zip`,解压出 `naive.exe`;
2. 放到 `src-tauri/resources/bin/naive.exe`(已 gitignore,不入库;macOS 上则解压 `naiveproxy-<版本>-mac-<x64-x64|arm64-arm64>.tar.xz` 里的 `naive`,同样命名为 `naive.exe` 放这里并 `chmod +x`);
3. 启动:
   ```bash
   pnpm tauri dev
   ```

开发模式下程序在 `src-tauri/target/debug/` 找内核(Windows 为 naive.exe,macOS/Linux 为 naive):要么把内核也拷一份到该目录,要么在应用内 ⚙ 设置里手动指定路径(路径留空 = 自动用程序同目录内核)。

## 本地打包

```bash
pnpm tauri build
# Windows 产物:src-tauri/target/release/bundle/nsis/NaiveGUI_<版本>_x64-setup.exe
# macOS 产物(需在 mac 上执行):src-tauri/target/release/bundle/dmg/*.dmg 与 .../macos/NaiveGUI.app
#   交叉架构:rustup target add aarch64-apple-darwin 后
#   pnpm tauri build --target aarch64-apple-darwin(Apple Silicon)
```

安装后程序目录包含 `naive.exe`(macOS 在 `NaiveGUI.app/Contents/Resources/`)与 `portable` 标记,开箱即用。构建前确保 `src-tauri/resources/bin/naive.exe` 存在(构建期校验)。macOS 本地构建为未签名产物,首次打开需右键 → 打开(Gatekeeper)。

## 便携模式(配置跟着文件夹走)

数据目录按以下规则二选一(实现见 `src-tauri/src/paths.rs`,设计见 `DESIGN.md` §6.1):

- **便携模式**:程序同目录存在 `portable` 标记文件(打包版默认附带;macOS 标记在 `NaiveGUI.app/Contents/Resources/` 内)→ 配置存 `<程序目录>/data/`(profiles.json / settings.json / runtime 等);
  - macOS:数据目录 = `NaiveGUI.app` **同级**的 `data/`(即「文件夹便携」:.app + data 一起拷走);
- **标准模式**:无标记、或程序目录不可写(如装在 Program Files、挂载只读 DMG)→ 存 `%APPDATA%\com.naive-gui.app`(macOS 为 `~/Library/Application Support/com.naive-gui.app`)。

首次以便携模式启动时,自动把系统目录里既有的配置迁移到便携数据目录(只补不覆盖)。**整个文件夹拷到哪,配置就跟到哪**;注意 data 目录内含明文密码,勿把整个文件夹分享给他人。

## CI/CD(GitHub Actions)

| 工作流 | 触发 | 内容 |
|---|---|---|
| `.github/workflows/test.yml` | push / PR | vitest + cargo test(自动创建 naive.exe 占位文件过编译期资源校验) |
| `.github/workflows/release.yml` | 手动(Actions → **Release Build** → 输入版本号) | 构建 Windows(NSIS)+ macOS(x64/arm64 dmg)安装包与便携包 → 发布 GitHub Release |

发版流程:

1. Actions 页面 → Release Build → Run workflow,填版本号(如 `0.1.0`);
2. 构建完成后自动发布 Release `v0.1.0`,附带:
   - `naive-gui-0.1.0-windows-setup.exe`(NSIS 安装包)
   - `naive-gui-0.1.0-windows-portable.zip`(解压即用的便携三件套)
   - `naive-gui-0.1.0-macos-x64.dmg` / `-macos-x64-portable.zip`(Intel)
   - `naive-gui-0.1.0-macos-arm64.dmg` / `-macos-arm64-portable.zip`(Apple Silicon)
3. naive 内核版本在 `release.yml` 的 `env.NAIVE_VERSION` 钉住,升级内核改这一个值即可。

**macOS 产物为未签名构建**(CI 无 Apple 开发者证书,仅 ad-hoc 签名):用户首次打开需右键 → 打开,或执行 `xattr -cr /Applications/NaiveGUI.app` 后再打开。

提交仓库注意:`src-tauri/Cargo.lock` 与 `src-tauri/resources/bin/portable`(0 字节标记文件)需入库;`src-tauri/resources/bin/naive.exe` 已 gitignore。

## 文档

- [DESIGN.md](DESIGN.md) — 架构设计、naive config.json 契约、校验规则、存储/进程/安全设计;
- [UI_SPEC.md](UI_SPEC.md) — 页面规格与交互细节。

## 致谢

- [naiveproxy](https://github.com/klzgrad/naiveproxy)(BSD-3-Clause):本项目以外部子进程方式调用其内核,不修改其源码。naive 版本应**始终保持最新**,以匹配 Chrome 指纹(上游 README 口径)。
