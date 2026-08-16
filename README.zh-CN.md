# @lijian-ui/dsh-im-gateway — DeepSeek Harness 多 IM 通道网关插件

> 把钉钉、QQ、个人微信（iLink）机器人接入 DeepSeek Harness（dsh）的 agent，支持扫码绑定、流式回复、斜杠命令与设置页可视化配置。

[![npm version](https://img.shields.io/npm/v/@lijian-ui/dsh-im-gateway)](https://www.npmjs.com/package/@lijian-ui/dsh-im-gateway)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## 一、这是什么

`@lijian-ui/dsh-im-gateway` 是 **DeepSeek Harness（dsh）官方插件体系**下的一个组合包（bundle）：一个统一的核心网关 + 三个渠道适配器，让你在钉钉 / QQ / 微信上跟 harness agent 对话。

- **一个插件，三种渠道**：所有渠道都走同一个 `ctx.imGateway` 核心（会话管理、斜杠命令、流式回复、状态广播）。
- **扫码绑定，开箱即用**：QQ 和微信不需要去开放平台手动创建机器人——设置页里点「扫码登录」，手机一扫凭据自动填好。
- **流式回复**：钉钉 AI 卡片实时出字、QQ stream_messages 逐字推送；不支持流式的渠道自动降级为整条文本。
- **多机器人实例**：同一个渠道类型可以配多个机器人（比如两个钉钉 bot），各自独立凭据。
- **Web 设置页**：在官方 dsh Web UI 里多出「IM 通道」设置页，扫码、配置、在线状态一目了然。

---

## 二、功能特性

### 钉钉（dingtalk）
- 出站 WebSocket 长连接（官方 Stream 模式），**无需 webhook**
- 单聊 + 群聊；群聊仅响应 @机器人 的消息（防打扰）
- **AI 卡片流式输出**：回复像"打字机"一样实时出字，含工具调用提示、完成动画
- 引用回复 / 图片 / 语音转文字等入站能力

### QQ
- 官方 `@tencent-connect/qqbot-nodejs` WebSocket 网关
- 私聊（c2c）+ 群聊（仅 @ 响应）
- **扫码绑定机器人**：`qqbot-connector` 扫码后自动拿到 AppID / AppSecret，免去开放平台手动创建
- **流式消息**（c2c）：`stream_messages` 逐字推送；群聊自动降级为普通文本

### 个人微信（weixin / iLink）
- 微信官方 iLink 协议（`ilinkai.weixin.qq.com`），纯 fetch 长轮询，无额外依赖
- **扫码登录 + 配对码**：手机微信扫码后按提示输入配对码即完成绑定
- 仅单聊（一个个人微信号绑一个 bot）
- 入站图片 AES-128-ECB 解密、出站媒体上传；文本经流式 Markdown 过滤（微信不渲染 MD）

### 通用能力
- **斜杠命令**：`/help` `/model` `/status` `/new` `/reset` `/clear` `/stop`
- **多实例**：`channels` 是数组，同一类型可配多个
- **热更新**：设置页保存后立即重建通道，无需重启
- **状态广播**：设置页每个通道卡片显示在线 / 离线 / 错误状态点
- **模型切换**：`/model` 列出可用模型（emoji 编号），无会话时可设置全局默认模型

---

## 三、安装

需要已安装 DeepSeek Harness（dsh）。本插件是标准 dsh bundle，走官方插件安装通道。

### 3.1 从 npm 安装（推荐）

```bash
dsh plugin --profile web add @lijian-ui/dsh-im-gateway
```

npm 包自带**预构建的 `lib/`**，安装即用——**不需要** `allowBuilds` 构建授权。

### 3.2 从 tarball 安装

```bash
npm pack @lijian-ui/dsh-im-gateway
dsh plugin --profile web add ./dsh-im-gateway-0.1.0.tgz
```

### 3.3 从 GitHub 安装

```bash
dsh plugin --profile web add github:lijian-ui/dsh-im-gateway
```

> git 安装拉取的是**源码**，首次安装需要授权 `prepare` 构建脚本（pnpm ≥ 10 默认拒绝）。按提示把包键加进该 profile 的 `pnpm-workspace.yaml` → `allowBuilds` 即可。想跳过授权就用 npm / tarball 方式。

### 3.4 验证安装

```bash
dsh --profile web --dump-config    # 输出里应有 "# == @lijian-ui/dsh-im-gateway" 配置层
dsh --profile web                  # 启动后浏览器打开设置 → 「IM 通道」
```

---

## 四、快速上手

1. 启动 dsh，浏览器打开 Web UI → **设置 → IM 通道**。
2. 点 **添加通道**，选渠道类型：
   - **QQ**：点 **扫码登录** → 手机 QQ 扫码 → 凭据自动填入 → 保存。
   - **个人微信**：点 **扫码登录** → 手机微信扫码 → （如提示）输入配对码 → 凭据自动填入 → 保存。
   - **钉钉**：手动填 AppKey / AppSecret（或直接改配置文件）→ 保存。
3. 在 IM 客户端给你的机器人发消息——回复实时流式返回。

> 配置存于 `~/.dsh/settings.yaml` 的 `im-gateway.channels`。设置页保存后**热重载**，无需重启。

---

## 五、斜杠命令

在任意 IM 渠道给机器人发：

| 命令 | 说明 |
| --- | --- |
| `/help` | 列出可用命令 |
| `/model` | 列出模型（emoji 编号）；`/model 1` 或 `/model <名称>` 切换；无会话时设为下次会话的默认模型 |
| `/status` | 渠道 / 工作目录 / 当前模型 / agent 状态 |
| `/new` `/reset` `/clear` | 开启新会话 |
| `/stop` | 中止当前回复 |

---

## 六、配置

优先在设置页编辑；底层存于 `~/.dsh/settings.yaml`：

```yaml
im-gateway:
  channels:
    - id: dingtalk-main
      type: dingtalk
      name: 主机器人
      enabled: true
      config:
        clientId: "你的 AppKey"
        clientSecret: "你的 AppSecret"
```

| 字段 | 适用渠道 | 含义 |
| --- | --- | --- |
| `clientId` / `clientSecret` | dingtalk | 钉钉应用凭据（Stream 模式） |
| `appId` / `clientSecret` | qq | QQ 开放平台凭据（扫码绑定自动填） |
| `token` / `botId` / `baseUrl` / `cdnBaseUrl` | weixin | iLink 凭据（扫码绑定自动填） |
| `enabled` | 全部 | 该实例是否启用连接 |

---

## 七、架构

```
IM 客户端 ──► 渠道适配器（dingtalk / qq / weixin）
                    │  ImInboundMessage
                    ▼
              ctx.imGateway（核心）
                    │  ensureSession → agent.followup
                    ▼
             dsh harness agent（LLM 循环）
                    │  会话事件（turn/start、assistant/chunk、tool/call、turn/end）
                    ▼
         流式回复 → 适配器 beginStream/streamText/endStream
                    │  （AI 卡片 / stream_messages / 纯文本降级）
                    ▼
                 IM 客户端
```

- **Host 半（node）**：`src/index.ts`（apply）、`src/gateway/`（核心 + 斜杠命令）、`src/channels/`（三渠道 + 协议层）、`src/remote.ts`（Typert RPC，供设置页调用）、`src/sync.ts`（配置保存后重建通道）。
- **Client 半（浏览器）**：`src/client/`——设置页「IM 通道」（添加/编辑弹窗、扫码登录、状态点）。
- **多实例**：`channels` 是数组，同一 `type` 可出现多次。

### 扩展点

第三方无需 fork 即可注册自己的渠道：

```ts
import { ImChannelAdapter } from '@lijian-ui/dsh-im-gateway'   // peerDependency 引用核心

class MyChannelAdapter implements ImChannelAdapter { /* ... */ }
ctx.imGateway.registerChannel(myAdapter)
```

---

## 八、开发

```bash
git clone https://github.com/lijian-ui/dsh-im-gateway.git
cd dsh-im-gateway
npm install
npm run build          # tsdown → lib/
npm run watch          # 保存即重编译
npm run typecheck
```

本地 link 进 profile：

```bash
dsh plugin --profile web add ./   # 从本目录安装（link）
```

> **Windows 提醒**：dsh 子进程从 `package.json` 的 `main`（`lib/index.js`）加载，**不直接读 src**。改完 `src/` 必须 `npm run build`，然后**重启 dsh 进程**（require 缓存不会自动刷新）。

---

## 九、常见问题

- **看不到插件日志？** cordis 默认把 `ctx.logger.*` 存进内存 buffer 不打印。本插件 apply 时注册了 console exporter，日志会出现在 dsh 子进程 stderr（桌面壳通常带 `[dsh]` 前缀）。
- **QQ 客户端一直"连接中"？** 流式开得太早或没收尾。本插件在第一个 assistant 文本增量时才开流，`turn/end` 时必关流（0.1.x 已修复）。
- **能对话但回复不是流式？** 渠道降级为纯文本了（QQ 群聊不支持 `stream_messages`、微信本身无流式概念）——这是设计行为。

---

## 十、许可

MIT © lijian-ui

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 打造的独立插件，与 DeepSeek 官方无隶属或背书关系。
