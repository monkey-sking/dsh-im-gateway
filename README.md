# @lijian-ui/dsh-im-gateway

[English](./README.en.md) | 简体中文

> 为 **DeepSeek Harness (dsh)** 提供多 IM 通道接入的网关插件：钉钉 / QQ / 个人微信，支持扫码绑定与流式回复。

[![npm version](https://img.shields.io/npm/v/@lijian-ui/dsh-im-gateway)](https://www.npmjs.com/package/@lijian-ui/dsh-im-gateway)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## 功能特性

- **统一网关服务** — 一个插件、三个通道。所有通道都汇聚到单一的 `ctx.imGateway` 核心：会话管理、斜杠命令、流式回复、状态广播。
- **钉钉** — 出站 WebSocket 长连接，群聊 + 单聊，@ 提及过滤，**AI 卡片流式输出**（实时增量回复），斜杠命令。
- **QQ** — WebSocket 网关（官方 `qqbot-nodejs` SDK），私聊（c2c）+ 群聊，**扫码绑定机器人**（免去开放平台手动创建），**流式消息**（c2c）。
- **个人微信（iLink）** — 官方 iLink 长轮询协议，**扫码登录 + 配对码**，仅单聊，媒体（AES-128-ECB CDN）收发。
- **多机器人实例** — 同一通道类型可配置多个实例（例如两个钉钉机器人），各自独立凭据。
- **内置斜杠命令** — `/help`、`/model`、`/status`、`/new`、`/reset`、`/stop` 等（见下文）。
- **设置页 UI** — 在官方 dsh web UI 内渲染完整的设置页（「IM 通道」），扫码绑定就在这里完成。
- **流式回复** — 钉钉 AI 卡片、QQ stream_messages；渠道不支持流式时自动回退纯文本。

---

## 安装

需要 DeepSeek Harness (dsh)——本插件是标准 **dsh bundle**，通过官方插件通道安装。

### 从 npm 安装（推荐）

```bash
dsh plugin --profile web add @lijian-ui/dsh-im-gateway
```

npm 包自带预构建的 `lib/` — **无需构建授权**（不需要 `allowBuilds`）。

### 从 tarball 安装

```bash
npm pack @lijian-ui/dsh-im-gateway
dsh plugin --profile web add ./dsh-im-gateway-0.1.0.tgz
```

### 从 GitHub 安装

```bash
dsh plugin --profile web add github:lijian-ui/dsh-im-gateway
```

> Git 安装拉取的是**源码**，首次安装需要批准包的 `prepare` 构建脚本（pnpm ≥ 10）。按提示把包键加进 profile 的 `pnpm-workspace.yaml` → `allowBuilds` 即可。优先用 npm / tarball 方式可跳过此步。

### 验证安装

```bash
dsh --profile web --dump-config     # 应看到 "# == @lijian-ui/dsh-im-gateway" 配置层
dsh --profile web                   # 启动后浏览器打开设置 → 「IM 通道」
```

---

## 快速上手

1. 打开 dsh web UI → **设置 → IM 通道**。
2. 点击**添加通道**。
3. 选择通道类型：
   - **QQ**：点击**扫码登录** → 手机 QQ 扫码 → 凭据自动填入 → 保存。
   - **个人微信**：点击**扫码登录** → 手机微信扫码 →（如要求则输入配对码）→ 凭据自动填入 → 保存。
   - **钉钉**：手动填写 AppKey / AppSecret（或直接编辑配置文件）→ 保存。
4. 在 IM 客户端给机器人发消息 — 回复实时流式返回。

> 配置存储在 `~/.dsh/settings.yaml`（`im-gateway.channels`）。在 UI 保存配置会**热重载**通道（无需重启）。

---

## 斜杠命令

在任何 IM 通道里发给机器人：

| 命令 | 说明 |
| --- | --- |
| `/help` | 列出可用命令 |
| `/model` | 用 emoji 编号列出模型；`/model 1` 或 `/model <名称>` 切换（无会话时 → 设为下次会话默认模型） |
| `/status` | 通道 / cwd / 当前模型 / agent 状态 |
| `/new` `/reset` `/clear` | 开启全新会话 |
| `/stop` | 中止当前回复 |

---

## 配置

所有配置都可在设置页编辑；底层 schema 在 `~/.dsh/settings.yaml`：

```yaml
im-gateway:
  channels:
    - id: dingtalk-main
      type: dingtalk
      name: 主机器人
      enabled: true
      config:
        clientId: "..."
        clientSecret: "..."
        # callbackBaseUrl, appId, botAppId, baseUrl, botId, cdnBaseUrl, pollIntervalMs...
```

| 字段 | 适用渠道 | 含义 |
| --- | --- | --- |
| `clientId` / `clientSecret` | dingtalk | 钉钉应用 key / secret（Stream 模式） |
| `appId` / `clientSecret` | qq | QQ 开放平台凭据（扫码绑定所得） |
| `token` / `botId` / `baseUrl` / `cdnBaseUrl` | weixin | iLink 凭据（扫码绑定所得） |
| `enabled` | 全部 | 该实例是否连接 |

---

## 架构

```
IM 客户端 ──► 通道适配器 (dingtalk / qq / weixin)
                   │  ImInboundMessage
                   ▼
             ctx.imGateway（核心）
                   │  ensureSession → agent.followup
                   ▼
            dsh harness agent（LLM 循环）
                   │  会话事件 (turn/start, assistant/chunk, tool/call, turn/end)
                   ▼
        流式回复 → 适配器 beginStream/streamText/endStream
                   │  (AI 卡片 / stream_messages / 纯文本回退)
                   ▼
                IM 客户端
```

- **Host 半**（node）：`src/index.ts`（apply）、`src/gateway/`（核心 + 斜杠命令）、`src/channels/`（dingtalk / qq / weixin + 协议助手）、`src/remote.ts`（设置页的 Typert RPC）、`src/sync.ts`（保存配置后热重载通道）。
- **Client 半**（浏览器）：`src/client/` — 设置页「IM 通道」（添加/编辑弹窗 + 扫码登录 + 状态点）。
- **多机器人**：`channels` 是数组，同一 `type` 可多次出现。

### 扩展点

第三方可以不 fork 直接注册自己的通道：

```ts
import { ImChannelAdapter } from '@lijian-ui/dsh-im-gateway'   // peerDependency 引用核心

class MyChannelAdapter implements ImChannelAdapter { /* ... */ }
ctx.imGateway.registerChannel(myAdapter)
```

---

## 开发

```bash
git clone https://github.com/lijian-ui/dsh-im-gateway.git
cd dsh-im-gateway
npm install
npm run build          # tsdown → lib/
npm run watch          # 保存自动重编译
npm run typecheck
```

本地 link 进 dsh profile：

```bash
dsh plugin --profile web add ./   # 从本目录安装（link）
```

> **Windows 注意**：dsh 子进程从 `package.json` 的 `main` 加载 `lib/index.js` — 修改 `src/` 后必须 `npm run build` 再重启 dsh 进程（它的 require 缓存会保留旧模块）。

---

## 常见问题

- **插件没有任何日志** — cordis 默认把 `ctx.logger.*` 缓存进内存。本插件在 apply 时注册了 console exporter，日志会出现在 dsh 子进程 stderr（桌面壳会加 `[dsh]` 前缀）。
- **QQ 客户端一直显示「连接中」** — 流式开得太早或没收干净。本插件在**第一个文本增量**时才开流，并在 `turn/end` 无条件收流（0.1.x 已修复）。
- **能对话但不流式** — 渠道回退到了纯文本（例如 QQ 群聊不支持 `stream_messages`；微信本身没有流式概念）。这是设计行为。

---

## 许可

MIT © lijian-ui

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 构建 — 独立插件，与 DeepSeek 无隶属或背书关系。
