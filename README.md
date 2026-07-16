# 竞品情报 · Competitor Scout

单机桌面应用：LLM 研究扫描 + BM25/RAG 威胁判定 + **逐产品对比表**（分析用，不入判定）+ 竞品库与击败路径。

Local desktop app: LLM research scan + BM25/RAG threat scoring + **param-by-param compare tables** (analysis only, not in scoring) + competitor library & beat roadmap.

**在线 Demo · Live Demo（GitHub Pages）→ [https://wangyaominde.github.io/competitor-scout/](https://wangyaominde.github.io/competitor-scout/)**  
与桌面端**同一套 `app.js` + `app.css` + 3D**；`mock-api` 注入示例数据，**无需配置大模型**。  
Same UI as the desktop app; `mock-api` injects sample data — **no real LLM required**.

[![CI](https://github.com/wangyaominde/competitor-scout/actions/workflows/ci.yml/badge.svg)](https://github.com/wangyaominde/competitor-scout/actions/workflows/ci.yml)
[![Build](https://github.com/wangyaominde/competitor-scout/actions/workflows/release.yml/badge.svg)](https://github.com/wangyaominde/competitor-scout/actions/workflows/release.yml)
[![Pages](https://github.com/wangyaominde/competitor-scout/actions/workflows/pages.yml/badge.svg)](https://github.com/wangyaominde/competitor-scout/actions/workflows/pages.yml)

> **隐私 · Privacy**：本仓库**不包含** API Key 与竞品数据。本地运行时密钥与库存在本机用户数据目录；开发模式下在项目 `.data/`（已 gitignore）。  
> This repo contains **no** API keys or competitor data. Secrets and libraries live in the OS user data dir (or `.data/` in dev, gitignored).

## 功能 · Features

| 模块 · Module | 说明 · Description |
|------|------|
| 引导 / 就绪度 · Onboarding / Readiness | 首次配置清单，完成后自动隐藏 · First-run checklist; auto-hides when done |
| 智能扫描 · Smart Scan | Discover → Enrich → 威胁 → Agent 校验（指示灯 + 心跳） · Discover → Enrich → Threat → Agent verify |
| **参数对比表 · Param compare** | 规格/价格等**参数逐项**对齐；**不写入**威胁判定 · Spec/price rows aligned; **not** used in scoring |
| 竞品库 · Competitors | 卡片 / 表格 / 3D 威胁空间 · Cards / table / 3D threat space |
| 击败路径 · Beat Roadmap | AI 路线图 + 可视化 · AI roadmap + visualization |
| Loop | cron 定时扫描与通知 · Scheduled scans & notifications |
| 数据 · Data | 导出 / 备份 / 恢复（仅本地） · Export / backup / restore (local only) |

## 在线 Demo · Live Demo

可交互 Demo 在 [`docs/`](./docs/) · Interactive demo in [`docs/`](./docs/):

- 直接跑桌面端 `app.js` / `threat-viz.js` / `app.css` · Same desktop `app.js` / viz / CSS
- `mock-api.js` 模拟 `window.api`（无真实 LLM、无本地文件） · Mocks `window.api` (no real LLM / files)
- 地址 · URL：https://wangyaominde.github.io/competitor-scout/

## 快速开始 · Quick start

```bash
git clone https://github.com/wangyaominde/competitor-scout.git
cd competitor-scout
npm install
npm start
```

开发模式（DevTools）· Dev mode (with DevTools):

```bash
npm run dev
```

国内网络若 Electron 下载失败 · If Electron download fails in China:

```bash
# macOS / Linux
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install

# Windows PowerShell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install
```

## 本地打包 · Package locally

```bash
npm run dist:mac   # → dist/*.dmg *.zip
npm run dist:win   # → dist/*.exe (Windows or matching runner)
npm run dist       # current platform
```

安装后用户数据在系统目录（如 macOS `~/Library/Application Support/competitor-scout/`），**不会**写回安装包。  
User data stays in the OS app-support dir and is **not** written back into the install package.

## 自测 · Tests

```bash
npm test
# 等价于 · equivalent to:
# npm run test:secrets  # 防泄漏 · no secrets / .data committed
# npm run test:smoke    # 文件、IPC、核心逻辑 · files, IPC, core smoke
# npm run test:system   # 校验、BM25、威胁、导出 · validation, BM25, threat, export
```

可选 GUI 端到端（本机有显示器时）· Optional GUI e2e (when a display is available):

```bash
npm run test:e2e
```

## GitHub CI / CD

| Workflow | 触发 · Trigger | 做什么 · What it does |
|----------|------|--------|
| **CI** (`.github/workflows/ci.yml`) | push / PR | 密钥护栏 + Ubuntu/macOS/Windows 上 `npm test` · secret guard + tests |
| **Build & Release** | push **main** / tag `v*` / manual | 测试 → 打 macOS+Windows 包 → 发布 · test → package → release |

### 自动编译 / 下载 · Auto-build / download

| 触发 · Trigger | 结果 · Result |
|------|------|
| 推送到 `main` · Push to `main` | 自动打包并发布 **[Latest](https://github.com/wangyaominde/competitor-scout/releases/tag/latest)**（正式 Release） · Auto package & publish **Latest** |
| `git tag v1.x.x && git push --tags` | 带版本号的 **Release** · Versioned **Release** |
| Actions 手动 Run · Manual workflow | 同上 · Same as above |

```bash
# 正式发版 · Cut a versioned release
git tag v1.0.0
git push origin v1.0.0
```

安装包在 [Releases](https://github.com/wangyaominde/competitor-scout/releases)；Actions Artifact 保留 30 天。  
Installers: [Releases](https://github.com/wangyaominde/competitor-scout/releases); Actions artifacts kept 30 days.

公开仓库默认 **未 Apple 公证 / 未代码签名**。安装包英文名：**CompetitorScout**。  
Public builds are **not** Apple-notarized / code-signed by default. Package name: **CompetitorScout**.

### macOS 提示「已损坏，无法打开」· “Damaged, can’t be opened”

这是 **Gatekeeper 隔离**，不是安装包坏了。下载并拖到「应用程序」后在终端执行：  
This is **Gatekeeper quarantine**, not a bad binary. After dragging to Applications:

```bash
xattr -cr /Applications/CompetitorScout.app
open /Applications/CompetitorScout.app
```

发布物仅 **3 个包** · Release artifacts (**3 packages**):

| 平台 · Platform | 文件 · File |
|------|------|
| Mac M 系列 · Apple Silicon | `CompetitorScout-*-mac-arm64.dmg` |
| Mac Intel | `CompetitorScout-*-mac-x64.dmg` |
| Windows | `CompetitorScout-*-win-x64.exe` |

## 首次使用 · First use

1. 配置 LLM（OpenAI 兼容：DeepSeek / 通义 / MiniMax / Kimi / Ollama…）· Configure LLM (OpenAI-compatible)  
2. 填写「我的产品」· Fill in **My Products**  
3. 智能扫描 → 竞品库确认 · Smart Scan → confirm in Competitors  
4. 可选开启 Loop · Optionally enable Loop  

**请勿**把 API Key 写进代码或提交 `.data/`。  
**Do not** commit API keys or `.data/`.

## 技术栈 · Tech stack

- Electron 33 · 纯 JS 本地存储 · electron-store · node-cron · Three.js  
- Electron 33 · pure-JS local storage · electron-store · node-cron · Three.js  

## License

MIT
