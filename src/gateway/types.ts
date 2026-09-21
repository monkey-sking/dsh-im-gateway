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

/**
 * An outbound voice/audio payload. Exactly one source should be set; adapters
 * pick the first available in the order `localPath` → `url` → `base64`.
 */
export interface ImVoice {
  /** Local audio file path (wav/mp3/silk…). */
  localPath?: string
  /** Remote audio URL. */
  url?: string
  /** Raw base64 audio bytes WITHOUT the `data:` prefix. */
  base64?: string
}

/**
 * Extra options for `sendText`.
 */
export interface SendTextOptions {
  /**
   * Channel-native id of the inbound message being answered. When set, channels
   * that support quoting (QQ) attach it so the reply references the user's
   * message instead of being a standalone push.
   */
  replyToId?: string
  /**
   * Skip outbound text sanitisation (scaffolding-tag stripping). Reserved for
   * callers that already produced clean text and must preserve it byte-exact.
   */
  raw?: boolean
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
  /**
   * Channel-native message id — populated by adapters so the gateway can
   * deduplicate concurrent adapter instances (dev HMR reloads, reconnect
   * races, etc.). When absent the gateway falls back to a heuristic key.
   */
  messageId?: string
}

/**
 * Structured approval request rendered by a channel that supports inline
 * keyboard buttons (e.g. QQ c2c/group). `actions[].id` MUST be a value the
 * gateway already recognizes as a verdict keyword (`allow` / `reject` / …),
 * because clicking a button routes back through `handleInbound` as that text
 * and is consumed by the pending approval broker.
 */
export interface ApprovalRequest {
  /** Title line (e.g. "⚠️ 批准请求（120s 内回复「批准」或「拒绝」）"). */
  title: string
  /** Body lines (tool name + reason). Plain text, no markdown. */
  body: string
  /** Timeout in seconds (informational; the broker enforces the real limit). */
  timeoutSecs: number
  /** Action buttons. id = keyword the gateway matches; label = button text. */
  actions: Array<{ id: string; label: string; style?: number }>
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
 * A channel adapter. Each IM backend (DingTalk / QQ / Weixin / Feishu / WeCom)
 * implements this and registers itself via `ctx.imGateway.registerChannel(adapter)`.
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
  sendText(conversationId: string, text: string, options?: SendTextOptions): Promise<void>
  /** Push an image reply. Optional — channels without media support may omit. */
  sendImage?(conversationId: string, image: ImImage): Promise<void>
  /** Push a file/media reply. Optional — channels without file support may omit. */
  sendMedia?(conversationId: string, filePath: string, caption?: string): Promise<void>
  /**
   * Push a voice/audio reply from an existing audio source (local file / URL /
   * base64). Optional — channels without voice support may omit.
   */
  sendVoice?(conversationId: string, voice: ImVoice): Promise<void>
  /**
   * Synthesize speech for `text` and return a sendable voice payload (or null
   * when TTS is unavailable/failed). Channels that own a TTS engine implement
   * this so the gateway's `im_send_voice` tool works; otherwise the tool falls
   * back to plain text.
   */
  synthesizeVoice?(text: string): Promise<ImVoice | null>
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
   * Optional structured approval UI. When an `approval/request` is pending and
   * the channel implements this, the gateway renders inline-keyboard buttons
   * instead of a plain-text prompt. The channel must echo each button's `id`
   * back via `handleInbound` (as text) when clicked, so the gateway can
   * recognize it as the verdict keyword (`allow` / `reject`). Channels without
   * this method fall back to the plain-text prompt + keyword reply.
   */
  sendApprovalRequest?(conversationId: string, payload: ApprovalRequest): Promise<void>
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

/** 群消息策略：open=全响应 | allowlist=白名单 | disabled=不响应。 */
export type GroupPolicy = 'open' | 'allowlist' | 'disabled'

/** 工具策略：full=全部 | restricted=限制修改类工具 | none=禁止调用工具。 */
export type ToolPolicy = 'full' | 'restricted' | 'none'

/**
 * 单个群的策略配置。解析优先级：具体群 > `groups['*']` > 账号默认。
 */
export interface GroupConfig {
  /** 是否需要 @机器人才响应（默认取账号级 defaultRequireMention）。 */
  requireMention?: boolean
  /** 是否丢弃「@了别人但没 @机器人」的消息（默认 false）。 */
  ignoreOtherMentions?: boolean
  /** 群内可用工具范围（默认 full，保持向后兼容）。 */
  toolPolicy?: ToolPolicy
  /** 群名称 —— 注入到消息前缀，便于模型分辨群。 */
  name?: string
  /** 群行为提示（PE），注入到消息前缀。 */
  prompt?: string
}

/**
 * 出站语音（TTS）配置。OpenAI 兼容的 `POST {baseUrl}/audio/speech`。
 * 未配置（或 enabled=false）时渠道不支持语音输出，`im_send_voice` 降级为文本。
 */
export interface TtsConfig {
  enabled: boolean
  /** 服务地址，如 https://api.openai.com/v1（会自动拼接 /audio/speech）。 */
  baseUrl: string
  /** API Key（可选，留空则不带 Authorization）。 */
  apiKey?: string
  /** 模型名，如 tts-1 / gpt-4o-mini-tts。 */
  model?: string
  /** 音色名，如 alloy / zh-CN-XiaoxiaoNeural。 */
  voice?: string
  /** 返回格式：mp3 / wav / opus（QQ 语音支持 wav/mp3/silk）。 */
  format?: string
}

/** QQ channel credentials (per instance). */
export interface QqChannelConfig {
  appId: string
  clientSecret: string
  botAppId: string
  /**
   * 出站消息是否引用用户消息（被动回复）。默认 true —— 回复会挂在用户消息下方。
   * 长回复只有首片引用，其余片走主动推送以避开单条 inbound 的被动回复配额。
   */
  quoteReply?: boolean
  /** 群消息策略（默认 open）。 */
  groupPolicy?: GroupPolicy
  /** 群白名单（groupPolicy=allowlist 时生效；支持 '*' 通配）。 */
  groupAllowFrom?: string[]
  /** 群消息是否默认需要 @机器人（默认 true）。 */
  defaultRequireMention?: boolean
  /** 按群配置，key 为 groupOpenid，'*' 为通配。 */
  groups?: Record<string, GroupConfig>
  /** 出站语音（TTS）配置；未配置则不支持语音输出。 */
  tts?: TtsConfig
}

/**
 * 飞书 / Lark channel credentials (per instance).
 *
 * 连接方式为 WebSocket 长连接（`im.message.receive_v1` 事件订阅），不需要公网
 * 回调地址；`appId` / `clientSecret` 可手填，也可由扫码一键创建自动填入
 * （feishu-register.ts）。
 */
export interface FeishuChannelConfig {
  appId: string
  clientSecret: string
  /** 平台域名：feishu=中国版(feishu.cn) | lark=国际版(larksuite.com)。默认 feishu。 */
  domain?: 'feishu' | 'lark'
  /**
   * 出站消息是否引用用户消息（默认 true）——回复挂在用户消息下方。
   * 长回复只有首片引用，其余片走主动推送。
   */
  quoteReply?: boolean
  /** 群消息策略（默认 open）。 */
  groupPolicy?: GroupPolicy
  /** 群白名单（groupPolicy=allowlist 时生效；支持 '*' 通配）。 */
  groupAllowFrom?: string[]
  /** 群消息是否默认需要 @机器人（默认 true）。 */
  defaultRequireMention?: boolean
  /** 按群配置，key 为群 chat_id（oc_xxx），'*' 为通配。 */
  groups?: Record<string, GroupConfig>
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
 * 企业微信「智能机器人」channel credentials (per instance).
 *
 * 连接方式为官方 WebSocket 长连接（无需公网回调地址、无需消息加解密）；
 * `botId` / `secret` 可手填，也可由扫码一键创建自动填入（wecom-register.ts）。
 *
 * 注意 `secret` 是**长连接专用密钥**，与「设置接收消息回调地址」模式的
 * Token / EncodingAESKey 不是一回事。
 */
export interface WecomChannelConfig {
  /** 智能机器人 BotID。 */
  botId: string
  /** 长连接专用密钥。 */
  secret: string
  /**
   * 群消息策略（默认 open）。企业微信平台侧只投递「@机器人」的群消息，
   * 因此没有 `defaultRequireMention` —— 是否需要被 @ 不由本网关决定。
   */
  groupPolicy?: GroupPolicy
  /** 群白名单（groupPolicy=allowlist 时生效；支持 '*' 通配）。 */
  groupAllowFrom?: string[]
  /** 按群配置，key 为群 chatid，'*' 为通配。 */
  groups?: Record<string, GroupConfig>
}

/**
 * One IM robot instance. The same channel TYPE may appear many times — e.g.
 * two DingTalk bots with different credentials — each with its own unique
 * `id` (e.g. `dingtalk-main`, `qq-7f3a`). `id` MUST NOT contain ':' because
 * the gateway builds `convKey = channelId:conversationId`.
 */
export type ChannelType = 'dingtalk' | 'qq' | 'weixin' | 'feishu' | 'wecom'

export interface ImChannelInstance {
  /** Unique instance id, `<type>-<slug>` — used as the adapter registry key. */
  id: string
  /** Channel type (drives which adapter class + which credential fields). */
  type: ChannelType
  /** Human-readable display name (e.g. '主机器人'). */
  name: string
  enabled: boolean
  /** Credential fields for this instance (shape depends on `type`). */
  config: DingtalkChannelConfig & Partial<QqChannelConfig> & Partial<WeixinChannelConfig> & Partial<FeishuChannelConfig> & Partial<WecomChannelConfig>
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
