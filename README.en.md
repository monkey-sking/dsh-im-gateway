# @lijian-ui/dsh-im-gateway

English | [简体中文](./README.md)

> A multi-channel IM gateway plugin for **DeepSeek Harness (dsh)** — connect DingTalk, QQ and WeChat (iLink) bots to your harness agent, with QR-scan binding and streaming replies.

[![npm version](https://img.shields.io/npm/v/@lijian-ui/dsh-im-gateway)](https://www.npmjs.com/package/@lijian-ui/dsh-im-gateway)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

---

## Features

- **Unified gateway service** — one plugin, three channels. Every channel routes through a single `ctx.imGateway` core: session management, slash commands, streaming, status broadcast.
- **DingTalk** — outbound WebSocket stream connection, group + single chats, @-mention filtering, **AI card streaming** (real-time incremental replies), slash commands.
- **QQ** — WebSocket gateway (official `qqbot-nodejs` SDK), private (c2c) + group chats, **QR-scan bot binding** (no manual console setup), **streaming messages** (c2c).
- **WeChat (iLink)** — official iLink long-poll protocol, **QR-scan login + pairing code**, single-chat only, media (AES-128-ECB CDN) in/out.
- **Multi-bot instances** — the same channel type can appear many times (e.g. two DingTalk bots), each with its own credentials.
- **Built-in slash commands** — `/help`, `/model`, `/status`, `/new`, `/reset`, `/stop` … (see below).
- **Settings UI** — a full web settings page ("IM 通道") rendered inside the official dsh web UI; QR-scan binding happens right there.
- **Streaming replies** — DingTalk AI Card, QQ stream_messages; plain-text fallback when a channel doesn't support streaming.

---

## Installation

Requires DeepSeek Harness (dsh) — the plugin is a standard **dsh bundle** and installs through the official plugin channel.

### From npm (recommended)

```bash
dsh plugin --profile web add @lijian-ui/dsh-im-gateway
```

The npm package ships pre-built `lib/` — **no build authorization needed** (`allowBuilds` is not required).

### From tarball

```bash
npm pack @lijian-ui/dsh-im-gateway
dsh plugin --profile web add ./dsh-im-gateway-0.1.0.tgz
```

### From GitHub

```bash
dsh plugin --profile web add github:lijian-ui/dsh-im-gateway
```

> Git installs fetch **source**, so the first install requires approving the package's `prepare` build script (pnpm ≥ 10). Add the package key to the profile's `pnpm-workspace.yaml` → `allowBuilds` when prompted. Prefer npm/tarball to skip this.

### Verify installation

```bash
dsh --profile web --dump-config     # should show a "# == @lijian-ui/dsh-im-gateway" config layer
dsh --profile web                   # open Settings → "IM 通道" in the browser
```

---

## Quick Start

1. Open the dsh web UI → **Settings → IM 通道**.
2. Click **添加通道** (Add channel).
3. Pick a channel type:
   - **QQ**: click **扫码登录** → scan with mobile QQ → credentials auto-fill → save.
   - **个人微信** (WeChat): click **扫码登录** → scan with mobile WeChat → (enter the pairing code if asked) → credentials auto-fill → save.
   - **钉钉** (DingTalk): fill in AppKey / AppSecret manually (or edit the config file) → save.
4. Message your bot from the IM client — replies stream back in real time.

> Config is stored under `~/.dsh/settings.yaml` (`im-gateway.channels`). Saving from the UI **hot-reloads** the channels (no restart needed).

---

## Slash Commands

Sent to the bot in any IM channel:

| Command | Description |
| --- | --- |
| `/help` | List available commands |
| `/model` | List models with emoji numbers; `/model 1` or `/model <name>` to switch (no session yet → sets default for next conversation) |
| `/status` | Channel / cwd / current model / agent state |
| `/new` `/reset` `/clear` | Start a fresh conversation |
| `/stop` | Abort the current reply |

---

## Configuration

Everything is editable from the settings UI; the underlying schema lives in `~/.dsh/settings.yaml`:

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

| Field | Applies to | Meaning |
| --- | --- | --- |
| `clientId` / `clientSecret` | dingtalk | DingTalk app key / secret (Stream mode) |
| `appId` / `clientSecret` | qq | QQ Open Platform credentials (QR-bound) |
| `token` / `botId` / `baseUrl` / `cdnBaseUrl` | weixin | iLink credentials (QR-bound) |
| `enabled` | all | Whether this instance connects |

---

## Architecture

```
IM client ──► channel adapter (dingtalk / qq / weixin)
                    │  ImInboundMessage
                    ▼
              ctx.imGateway (core)
                    │  ensureSession → agent.followup
                    ▼
             dsh harness agent (LLM loop)
                    │  session events (turn/start, assistant/chunk, tool/call, turn/end)
                    ▼
         streaming reply → adapter.beginStream/streamText/endStream
                    │  (AI Card / stream_messages / plain text fallback)
                    ▼
                 IM client
```

- **Host half** (node): `src/index.ts` (apply), `src/gateway/` (core + slash commands), `src/channels/` (dingtalk / qq / weixin + protocol helpers), `src/remote.ts` (Typert RPC for the settings UI), `src/sync.ts` (channel reload on config save).
- **Client half** (browser): `src/client/` — settings page "IM 通道" (add/edit modal + QR-scan login + status dots).
- **Multi-bot**: `channels` is an array; the same `type` may appear multiple times.

### Extension points

Third parties can register their own channel without forking:

```ts
import { ImChannelAdapter } from '@lijian-ui/dsh-im-gateway'   // peerDependency on the core

class MyChannelAdapter implements ImChannelAdapter { /* ... */ }
ctx.imGateway.registerChannel(myAdapter)
```

---

## Development

```bash
git clone https://github.com/lijian-ui/dsh-im-gateway.git
cd dsh-im-gateway
npm install
npm run build          # tsdown → lib/
npm run watch          # rebuild on save
npm run typecheck
```

Local link into a dsh profile:

```bash
dsh plugin --profile web add ./   # install from this directory (link)
```

> **Windows note**: the dsh subprocess loads `lib/index.js` from `package.json` `main` — after editing `src/`, always `npm run build` then restart the dsh process (its require cache keeps the old module).

---

## Troubleshooting

- **No logs from the plugin** — cordis buffers `ctx.logger.*` in memory by default. The plugin registers a console exporter on apply, so logs appear in the dsh subprocess stderr (desktop shells prefix them with `[dsh]`).
- **QQ client shows "连接中" (connecting) forever** — streaming was opened too early or never closed. This plugin opens the stream on the first assistant text delta and always closes it on `turn/end` (fixed in 0.1.x).
- **Chat works but replies are not streaming** — the channel fell back to plain text (e.g. QQ group chats don't support `stream_messages`; WeChat has no streaming concept). This is by design.

---

## License

MIT © lijian-ui

Built for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) — independent plugin, not affiliated with or endorsed by DeepSeek.
