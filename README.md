# 竞品情报 · Competitor Intel

单机桌面应用：LLM 研究扫描 + BM25/RAG 威胁分析 + **逐产品遍历匹配** + 竞品库与击败路径。

**展示站（GitHub Pages）→ [https://wangyaominde.github.io/competitor-intel/](https://wangyaominde.github.io/competitor-intel/)**

[![CI](https://github.com/wangyaominde/competitor-intel/actions/workflows/ci.yml/badge.svg)](https://github.com/wangyaominde/competitor-intel/actions/workflows/ci.yml)
[![Build](https://github.com/wangyaominde/competitor-intel/actions/workflows/release.yml/badge.svg)](https://github.com/wangyaominde/competitor-intel/actions/workflows/release.yml)
[![Pages](https://github.com/wangyaominde/competitor-intel/actions/workflows/pages.yml/badge.svg)](https://github.com/wangyaominde/competitor-intel/actions/workflows/pages.yml)

> **隐私**：本仓库**不包含** API Key 与竞品数据。本地运行时密钥与库存在本机用户数据目录；开发模式下在项目 `.data/`（已 gitignore）。

## 功能

| 模块 | 说明 |
|------|------|
| 引导 / 就绪度 | 首次配置清单，完成后自动隐藏 |
| 智能扫描 | Discover → Enrich → 威胁 → Agent 校验（指示灯 + 心跳） |
| **遍历匹配** | 按我方产品**一条一条** RAG 匹配竞品，输出明细并取最高威胁 |
| 竞品库 | 卡片 / 表格 / 3D 威胁空间 |
| 击败路径 | AI 路线图 + 可视化 |
| Loop | cron 定时扫描与通知 |
| 数据 | 导出 / 备份 / 恢复（仅本地） |

## 产品页

静态展示站源码在 [`docs/`](./docs/)，由 Actions 部署到 GitHub Pages：

- 站点：https://wangyaominde.github.io/competitor-intel/
- 工作流：`.github/workflows/pages.yml`（push `docs/**` 或手动触发）

## 快速开始

```bash
git clone https://github.com/wangyaominde/competitor-intel.git
cd competitor-intel
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

安装后用户数据在系统目录（如 macOS `~/Library/Application Support/competitor-intel/`），**不会**写回安装包。

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
| **Build & Release** (`.github/workflows/release.yml`) | tag `v*` 或手动 | 先测再打 macOS + Windows 包，tag 时发布 Release |

发布示例：

```bash
git tag v1.0.0
git push origin v1.0.0
```

Actions → **Build & Release** 产物也可从 Artifact 下载（未打 tag 时手动 `workflow_dispatch`）。

### CI 自测流程说明

1. **Secrets guard**：确认未跟踪 `.data/`、配置 JSON；跑 `check-secrets.js`  
2. **矩阵测试**：三系统 `npm ci` → `npm test`  
3. **构建前测试**：Release workflow 在打包前再跑一遍测试  
4. **平台构建**：`macos-latest` → dmg/zip；`windows-latest` → nsis/portable  
5. **Release**（仅 tag）：上传安装包到 GitHub Releases  

公开仓库默认 **未代码签名**（`CSC_IDENTITY_AUTO_DISCOVERY=false`）。若需公证/签名，自行配置 Apple/Windows 证书 Secrets。

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
