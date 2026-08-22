import type { Context } from '@deepseek-ai/cordis'
import type { ImGatewayService } from './im-gateway'

// ─────────────────────────────────────────────────────────────────────────
// Channel contracts — ported from pi-desk-top/src/main/im/types.ts.
// ─────────────────────────────────────────────────────────────────────────

/** An attached image. `data` is raw base64 WITHOUT the `data:` prefix. */
export interface ImImage {
  mediaType: string
  data: string
}

/** A normalized inbound message coming from any channel. */
export interface ImInboundMessage {
  /** Channel id, e.g. 'dingtalk'. Must match the adapter's `id`. */
  channelId: string
  /** Channel-specific conversation / chat id. */
  conversationId: string
  /** End-user id inside the channel. */
  userId: string
  /** Text body (slash-command prefixes are still present here; the gateway strips them). */
  text: string
  /** Attached images, if any. */
  images?: ImImage[]
  /** Display name of the sender (group chats) — used to attribute who spoke. */
  senderNick?: string
  /** Whether the inbound arrived in a group conversation. */
  isGroup?: boolean
}

/** Runtime status of a channel connection, surfaced to the settings UI. */
export interface ChannelStatus {
  /** Connection state. */
  status: 'online' | 'offline' | 'error'
  /** Present when `status === 'error'`. */
  error?: string
  /** Epoch ms of the last state change. */
  lastChange: number
}

/**
 * A channel adapter. Each IM backend (DingTalk / QQ / Weixin) implements this
 * and registers itself via `ctx.imGateway.registerChannel(adapter)`.
 *
 * Lifecycle: the gateway calls `start()` once the core service is active and
 * `stop()` on teardown. The adapter pushes inbound messages back through
 * `ctx.imGateway.handleInbound(message)`.
 */
export interface ImChannelAdapter {
  /** Stable channel id (e.g. 'dingtalk'). Used as the registry key and in session mapping. */
  readonly id: string
  /** Human-readable label for logs / settings UI. */
  readonly label: string
  /** 单条消息最大字符数（超过则分片发送）。0 = 不分片。默认 4000。 */
  readonly maxMessageChars?: number
  /** Connect to the backend (open WS / start polling). */
  start(): Promise<void> | void
  /** Disconnect and release resources. */
  stop(): Promise<void> | void
  /** Push a text reply to a conversation. */
  sendText(conversationId: string, text: string): Promise<void>
  /** Push an image reply. Optional — channels without media support may omit. */
  sendImage?(conversationId: string, image: ImImage): Promise<void>
  /** Push a file/media reply. Optional — channels without file support may omit. */
  sendMedia?(conversationId: string, filePath: string, caption?: string): Promise<void>
  /** Whether the adapter is currently connected. */
  isActive(): boolean
  /**
   * Optional streaming hook. The gateway calls this with incremental text
   * (throttled by `streamThrottleMs`) so card-based channels (DingTalk) can
   * update an AI card instead of sending discrete messages. Channels without
   * this hook receive the full reply via `sendText` on `turn/end`.
   */
  updateCard?(conversationId: string, partialText: string): Promise<void>
  /**
   * Optional AI-card streaming lifecycle — the richer sibling of `updateCard`.
   * A channel that implements these three methods gets a full streaming card:
   *   beginStream (create + deliver the card, once per reply cycle)
   *   streamText  (incremental content updates, throttled by the gateway)
   *   endStream   (finalize FINISHED; must be called even with no text)
   * Channels without them fall back to a single `sendText` at `turn/end`.
   */
  beginStream?(conversationId: string): Promise<void>
  streamText?(conversationId: string, text: string, finished?: boolean): Promise<void>
  endStream?(conversationId: string, text: string): Promise<void>
  /**
   * Optional pre-filter. Called by the gateway for every inbound message
   * BEFORE it is forwarded to the agent. Return `true` to suppress forwarding
   * (e.g. the message was a slash command handled locally).
   */
  onInbound?(message: ImInboundMessage): boolean | Promise<boolean>
  /**
   * Optional channel-local authorization. Return `true` → authorized,
   * `false` → rejected, `undefined` → defer to the gateway global allowlist.
   * Used by channels with their own auth (e.g. Weixin QR-scan users).
   */
  authorizes?(userId: string): boolean | undefined
  /**
   * Optional status sink. The gateway assigns this on registration; the adapter
   * must call it whenever its connection state changes (connected / closed /
   * error) so the settings page can render online / offline / error badges.
   */
  statusListener?(status: ChannelStatus): void
}

// ─────────────────────────────────────────────────────────────────────────
// Gateway config.
// ─────────────────────────────────────────────────────────────────────────

/** DingTalk channel credentials (per instance). */
export interface DingtalkChannelConfig {
  clientId: string
  clientSecret: string
  callbackBaseUrl: string
}

/** QQ channel credentials (per instance). */
export interface QqChannelConfig {
  appId: string
  clientSecret: string
  botAppId: string
}

/** 微信(iLink) channel credentials (per instance). */
export interface WeixinChannelConfig {
  /** iLink bot token — obtained via QR scan login (weixin-login.ts). */
  token: string
  /** iLink bot id — obtained via QR scan login (weixin-login.ts). */
  botId: string
  /** API base URL (defaults to https://ilinkai.weixin.qq.com). */
  baseUrl: string
  /** CDN base URL for media download/upload (defaults to https://cdn.ilinkai.weixin.qq.com). */
  cdnBaseUrl: string
  pollIntervalMs: number
}

/**
 * One IM robot instance. The same channel TYPE may appear many times — e.g.
 * two DingTalk bots with different credentials — each with its own unique
 * `id` (e.g. `dingtalk-main`, `qq-7f3a`). `id` MUST NOT contain ':' because
 * the gateway builds `convKey = channelId:conversationId`.
 */
export type ChannelType = 'dingtalk' | 'qq' | 'weixin'

export interface ImChannelInstance {
  /** Unique instance id, `<type>-<slug>` — used as the adapter registry key. */
  id: string
  /** Channel type (drives which adapter class + which credential fields). */
  type: ChannelType
  /** Human-readable display name (e.g. '主机器人'). */
  name: string
  enabled: boolean
  /** Credential fields for this instance (shape depends on `type`). */
  config: DingtalkChannelConfig & Partial<QqChannelConfig> & Partial<WeixinChannelConfig>
}

export interface ImGatewayConfig {
  /** Working directory passed to host sessions created for IM conversations. */
  cwd: string
  /** Throttle (ms) for incremental `updateCard` pushes. Ignored when a channel has no `updateCard`. */
  streamThrottleMs: number
  /** Enable built-in slash commands (/help, /reset, /clear). */
  slashCommands: boolean
  /**
   * 审批超时（秒）。当 agent 调用需要审批的工具时，IM 侧需在此时间内
   * 回复「批准」或「拒绝」，超时则委托回 dsh 原生审批体系。
   */
  approvalTimeoutSecs: number
  /**
   * 提问超时（秒）。当 agent 调用 ask_user_question 工具时，IM 侧需在此时间内
   * 回复，超时则转回 Web 端继续等待。
   */
  questionTimeoutSecs: number
  /** 全局放行所有用户（仅开发用）。 */
  allowAllUsers: boolean
  /** 白名单：{ channelId: string[] } 或用 '*' 作 key 匹配任意渠道。 */
  allowedUserIds: Record<string, string[]>
  /** 多段输入合并窗口（秒）。用户连续发多条消息时合并为一条。 */
  mergeTimeoutSecs: number

  /** All channel instances. Only `enabled` ones connect out. Empty by default. */
  channels: ImChannelInstance[]
}

/** Public surface of the gateway service, exposed as `ctx.imGateway`. */
export interface ImGateway {
  registerChannel(adapter: ImChannelAdapter): void
  getChannel(id: string): ImChannelAdapter | undefined
  listChannels(): string[]
  /** Entry point channel adapters call for every inbound user message. */
  handleInbound(message: ImInboundMessage): Promise<void>
  /** Snapshot of every channel's runtime status (for the settings UI). */
  getChannelStatuses(): Record<string, ChannelStatus>
  /** 添加 UI 批准的白名单用户（重启后需重新灌入）。 */
  addAuthorizedUser(channelId: string, userId: string): void
}

// ─────────────────────────────────────────────────────────────────────────
// Module augmentation so `ctx.imGateway` is typed for every plugin in this
// bundle. The host-provided `ctx.sessions` (SessionStore) and `ctx.agents`
// (AgentRegistry) are augmented by their own packages; we only add imGateway.
// ─────────────────────────────────────────────────────────────────────────

declare module '@deepseek-ai/cordis' {
  interface Context {
    imGateway: ImGatewayService
  }
}

export type { Context }
