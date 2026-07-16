# 竞品情报 · Competitor Scout

单机桌面应用：LLM 研究扫描 + BM25/RAG 威胁判定 + **逐产品对比表**（分析用，不入判定）+ 竞品库与击败路径。

**在线 Demo（GitHub Pages）→ [https://wangyaominde.github.io/competitor-scout/](https://wangyaominde.github.io/competitor-scout/)**  
与桌面端**同一套 UI 壳与 `app.css`**：侧栏 / 仪表盘 / 扫描流水线 / 竞品卡片 / 参数对比（示例数据，无真实 LLM）。

[![CI](https://github.com/wangyaominde/competitor-scout/actions/workflows/ci.yml/badge.svg)](https://github.com/wangyaominde/competitor-scout/actions/workflows/ci.yml)
[![Build](https://github.com/wangyaominde/competitor-scout/actions/workflows/release.yml/badge.svg)](https://github.com/wangyaominde/competitor-scout/actions/workflows/release.yml)
[![Pages](https://github.com/wangyaominde/competitor-scout/actions/workflows/pages.yml/badge.svg)](https://github.com/wangyaominde/competitor-scout/actions/workflows/pages.yml)

> **隐私**：本仓库**不包含** API Key 与竞品数据。本地运行时密钥与库存在本机用户数据目录；开发模式下在项目 `.data/`（已 gitignore）。

## 功能

| 模块 | 说明 |
|------|------|
| 引导 / 就绪度 | 首次配置清单，完成后自动隐藏 |
| 智能扫描 | Discover → Enrich → 威胁 → Agent 校验（指示灯 + 心跳） |
| **参数对比表** | 规格/价格等**参数逐项**对齐表格；**不写入**威胁判定 |
| 竞品库 | 卡片 / 表格 / 3D 威胁空间 |
| 击败路径 | AI 路线图 + 可视化 |
| Loop | cron 定时扫描与通知 |
| 数据 | 导出 / 备份 / 恢复（仅本地） |

## 在线 Demo

可交互 Demo 在 [`docs/`](./docs/)：

- 直接跑桌面端 `app.js` / `threat-viz.js` / `app.css`
- `mock-api.js` 模拟 `window.api`（无真实 LLM、无本地文件）
- 地址：https://wangyaominde.github.io/competitor-scout/

## 快速开始

```bash
git clone https://github.com/wangyaominde/competitor-scout.git
cd competitor-scout
npm install
npm start
```

开发模式（DevTools）：

```bash
npm run dev
```

国内网络若 Electron 下载失败：

```bash
# macOS / Linux
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
npm install

# Windows PowerShell
$env:ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/"
npm install
```

## 本地打包

```bash
npm run dist:mac   # → dist/*.dmg *.zip
npm run dist:win   # → dist/*.exe（需在 Windows 或对应 runner）
npm run dist       # 当前平台
```

安装后用户数据在系统目录（如 macOS `~/Library/Application Support/competitor-scout/`），**不会**写回安装包。

## 自测

```bash
npm test
# 等价于：
# npm run test:secrets  # 防泄漏（禁止提交 .data / 硬编码 key）
# npm run test:smoke    # 文件、IPC、核心逻辑冒烟
# npm run test:system   # 校验、BM25、威胁、导出等系统测试
```

可选 GUI 端到端（本机有显示器时）：

```bash
npm run test:e2e
```

## GitHub CI / CD

| Workflow | 触发 | 做什么 |
|----------|------|--------|
| **CI** (`.github/workflows/ci.yml`) | push / PR | 密钥护栏 + Ubuntu/macOS/Windows 上 `npm test` |
| **Build & Release** | push **main** / tag `v*` / 手动 | 测试 → 打 macOS+Windows 包 → 发布 |

### 自动编译 / 下载

| 触发 | 结果 |
|------|------|
| 推送到 `main` | 自动打包并发布 **[Latest](https://github.com/wangyaominde/competitor-scout/releases/tag/latest)**（正式 Release，非 pre-release） |
| `git tag v1.x.x && git push --tags` | 带版本号的 **Release** |
| Actions 手动 Run | 同上（按当前分支/tag） |

```bash
# 正式发版
git tag v1.0.0
git push origin v1.0.0
```

安装包在 [Releases](https://github.com/wangyaominde/competitor-scout/releases)；Actions Artifact 保留 30 天。

公开仓库默认 **未 Apple 公证 / 未代码签名**。安装包英文名：**CompetitorScout**。

### macOS 提示「已损坏，无法打开」

这是 **Gatekeeper 隔离**，不是安装包坏了。下载并拖到「应用程序」后在终端执行：

```bash
xattr -cr /Applications/CompetitorScout.app
open /Applications/CompetitorScout.app
```

发布物仅 **3 个包**：

| 平台 | 文件 |
|------|------|
| Mac M 系列 | `CompetitorScout-*-mac-arm64.dmg` |
| Mac Intel | `CompetitorScout-*-mac-x64.dmg` |
| Windows | `CompetitorScout-*-win-x64.exe` |

## 首次使用

1. 配置 LLM（OpenAI 兼容：DeepSeek / 通义 / MiniMax / Kimi / Ollama…）  
2. 填写「我的产品」  
3. 智能扫描 → 竞品库确认  
4. 可选开启 Loop  

**请勿**把 API Key 写进代码或提交 `.data/`。

## 技术栈

- Electron 33 · 纯 JS 本地存储 · electron-store · node-cron · Three.js  

## License

MIT
