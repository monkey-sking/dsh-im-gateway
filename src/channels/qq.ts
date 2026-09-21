/**
 * QQ Bot channel adapter — ported from
 * pi-desk-top/src/main/im/qq/qq-adapter.ts, adapted to the cordis
 * ImChannelAdapter contract:
 *   - Private chats: every message maps to a c2c conversation keyed by the
 *     sender's openid.
 *   - Group chats: gated by per-group policy (groupPolicy open/allowlist/
 *     disabled, requireMention, ignoreOtherMentions); the group shares one
 *     conversation keyed by the group openid.
 *   - Media: inbound images are downloaded (attachments carry a plain URL,
 *     validated against SSRF first) and handed to the agent as base64;
 *     outbound local paths are uploaded via the SDK's sendImage / sendMedia.
 *   - Streaming (C2C only — QQ stream_messages API is c2c-scoped):
 *     beginStream/streamText/endStream with replace-mode fallback.
 *   - Structured approval: sendApprovalRequest renders an inline-keyboard
 *     approval prompt; clicking a button routes back through handleInbound as
 *     the verdict keyword ('allow' / 'reject') and consumes the pending
 *     human-in-the-loop.
 *   - Quote replies: outbound messages reference the user's inbound message
 *     (passive reply) when `quoteReply` is on (default).
 *   - Voice output: sendVoice() pushes an existing audio source; the optional
 *     synthesizeVoice() adds an OpenAI-compatible TTS so the gateway's
 *     `im_send_voice` tool works end-to-end.
 *   - Hardening: every outbound text is sanitised (scaffolding/reasoning tags
 *     stripped) and every fetched remote URL passes the SSRF guard.
 */
import { Context } from '@deepseek-ai/cordis'
import { statSync } from 'node:fs'
import { basename } from 'node:path'
import type {
  InlineKeyboard,
  QQBot,
  QQBotInboundMessage,
  ReplyTarget,
} from '@tencent-connect/qqbot-nodejs'
import {
  getNextMsgSeq,
  StreamContentType,
  StreamInputMode,
  StreamInputState,
} from '@tencent-connect/qqbot-nodejs/protocol'
import type { StreamMessageRequest } from '@tencent-connect/qqbot-nodejs/protocol'
import { splitText } from '../gateway/split'
import { sanitizeOutboundText } from '../gateway/sanitize'
import { validateRemoteUrl } from '../gateway/ssrf'
import type {
  ApprovalRequest,
  ChannelStatus,
  GroupConfig,
  GroupPolicy,
  ImChannelAdapter,
  ImImage,
  ImInboundMessage,
  ImVoice,
  QqChannelConfig,
  SendTextOptions,
  ToolPolicy,
} from '../gateway/types'

const BASE_BACKOFF_DELAY = 2_000
const MAX_BACKOFF_DELAY = 30_000

/** 入站媒体下载超时（ms）。 */
const INBOUND_FETCH_TIMEOUT_MS = 30_000
/** TTS 合成请求超时（ms）。 */
const TTS_TIMEOUT_MS = 60_000

/** 群工具策略 → 提示词约束（软约束：注入消息前缀，由模型遵守）。 */
const TOOL_POLICY_HINTS: Record<ToolPolicy, string> = {
  full: '',
  restricted: '本群仅可使用只读类工具（读取/查询/搜索），禁止写文件、删除、执行命令等修改性操作。',
  none: '本群禁止调用任何工具，仅用纯文本回答。',
}

/** True when a path points at a local file (drive letter, /, ~, file://). */
function isLocalPath(raw: string): boolean {
  return (
    raw.startsWith('file://') ||
    /^[A-Za-z]:[\\/]/.test(raw) ||
    raw.startsWith('/') ||
    raw.startsWith('~')
  )
}

/** True when the path exists AND is a regular file (directories are skipped
 *  so a `pwd`-style output never gets uploaded as media). */
function isRegularFile(p: string): boolean {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** Strip file:// / URL-encoding to get the on-disk absolute path. */
function toLocalPath(raw: string): string {
  let p = raw.startsWith('file://') ? raw.slice('file://'.length) : raw
  try {
    p = decodeURIComponent(p)
  } catch {
    /* keep as-is */
  }
  return p
}

/** Guess a MIME type from a download URL (QQ attachments expose content_type). */
function mimeFromContentType(ct: string | undefined): string {
  if (!ct) return 'image/jpeg'
  const base = ct.split(';')[0].trim().toLowerCase()
  if (base.startsWith('image/')) return base
  return 'image/jpeg'
}

/** 解析后的群配置（所有字段均已填充默认值）。 */
type ResolvedGroupConfig = Required<GroupConfig>

/**
 * Minimal state for one raw stream_messages session (C2C only).
 *
 * Deliberately NOT the SDK's StreamSession: its update() no-ops on identical
 * text (streaming.ts `pendingText === lastSentText`), which makes it
 * impossible to re-send an EMPTY content frame as the "three dots" keepalive.
 * Driving `messageApi.sendC2CStreamMessage` directly keeps every frame under
 * our control.
 */
interface RawStream {
  /** Peer openid (c2c target). */
  openid: string
  /** Inbound message id anchoring the stream (event_id + msg_id). */
  msgId: string
  /** Constant msg_seq shared by every frame of this stream. */
  msgSeq: number
  /** Monotonic frame index. */
  index: number
  /** Server-returned stream message id (captured on the first success). */
  streamMsgId?: string
  /** A frame failed — stop GENERATING pushes; endStream falls back to sendText. */
  failed: boolean
  /**
   * Invisible prefix (zero-width spaces) that grows on every heartbeat. QQ's
   * stream_messages is APPEND-only: each frame's content must extend the
   * previous frame's content. The prefix keeps the GENERATING "three dots"
   * bubble alive during thinking AND stays a legal prefix of the real text,
   * so the first text frame (prefix + text) is always accepted — this is what
   * the earlier `\u200b`-only / empty-first-frame attempts got wrong and
   * produced a blank bubble + a separate message.
   */
  prefix: string
  /** True once a non-empty text frame has been sent — heartbeats then stop. */
  hasText: boolean
  /**
   * The exact substring of the full reply currently rendered in the bubble.
   * QQ's stream is APPEND-only and a single frame can hold at most
   * STREAM_MAX_CHARS (minus the prefix), so once the cumulative reply exceeds
   * that we stop growing the bubble and flush the remainder as plain messages
   * at endStream (see streamText).
   */
  shownText: string
}

class QQAdapter implements ImChannelAdapter {
  /** 5-minute TTL — matches pi-desktop feishu/dingtalk connection dedup. */
  private static readonly DEDUP_TTL_MS = 5 * 60 * 1000
  /** Per-frame content cap (incl. invisible prefix). Mirrors gateway's
   *  `maxMessageChars ?? 4000` so the streaming bubble never exceeds QQ's
   *  single-message limit — exceeding it would make a frame fail and the
   *  overflow is flushed as separate messages instead of crashing the turn. */
  private static readonly STREAM_MAX_CHARS = 4000
  /** Heartbeat cadence (ms). Well under QQ's GENERATING-server-timeout so the
   *  bot-avatar + three-dots bubble never expires mid-turn (thinking/tool calls). */
  private static readonly STREAM_BEAT_MS = 20_000

  /** Single-message char cap — gateway uses this for the non-stream fallback. */
  readonly maxMessageChars = 4000

  private appId: string
  private appSecret: string
  /** Full instance config — kept for the group/TTS/quote capabilities. */
  private readonly cfg: QqChannelConfig
  private readonly quoteReply: boolean
  private readonly groupPolicy: GroupPolicy
  /** 群白名单（小写归一，支持 '*'）。 */
  private readonly groupAllowFrom: string[]
  private readonly defaultRequireMention: boolean
  private readonly groups: Record<string, GroupConfig>
  private bot: QQBot | null = null
  private stopped = true
  private active = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** Per-peer (target string) last inbound msgId — anchors stream replies. */
  private lastMsgIds = new Map<string, string>()
  /** Active raw stream per peer (C2C only). Absent = streaming unavailable. */
  private readonly streams = new Map<string, RawStream>()
  /** Seen message ids → timestamp — deduplicates SDK replay on reconnect. */
  private readonly seenMsgIds = new Map<string, number>()
  /** Heartbeat timers per conversation — keep the GENERATING bubble alive. */
  private readonly streamBeatTimers = new Map<string, ReturnType<typeof setInterval>>()
  /** Runtime-status sink, assigned by the gateway on registration. */
  statusListener?: (status: ChannelStatus) => void

  constructor(
    private readonly ctx: Context,
    config: QqChannelConfig,
    /** Instance id (e.g. 'qq-main') — unique per bot, registry key. */
    readonly id: string,
    /** Display label (instance name or the channel type name). */
    readonly label: string,
  ) {
    this.cfg = config
    this.appId = config.appId ?? ''
    this.appSecret = config.clientSecret ?? ''
    this.quoteReply = config.quoteReply !== false
    this.groupPolicy = config.groupPolicy ?? 'open'
    this.groupAllowFrom = (config.groupAllowFrom ?? [])
      .map((v) => String(v).trim().toLowerCase())
      .filter(Boolean)
    this.defaultRequireMention = config.defaultRequireMention !== false
    this.groups = config.groups ?? {}
  }

  isActive(): boolean {
    return this.active
  }

  private setStatus(s: 'online' | 'offline' | 'error', error?: string): void {
    this.statusListener?.({ status: s, error, lastChange: Date.now() })
  }

  /**
   * Forward an inbound message to the gateway service. Resolved via
   * `ctx.get('imGateway')` — NOT property access — because the adapter's ctx
   * is NOT within imGateway's inject scope. Property access throws
   * `cannot get property "imGateway" without inject` once the message handler
   * runs outside the boot fiber (see the sync.ts design note). Matches the
   * pattern already used in remote.ts:saveConfig.
   */
  private deliver(msg: ImInboundMessage): Promise<void> {
    const gw = this.ctx.get('imGateway') as { handleInbound(m: ImInboundMessage): Promise<void> } | undefined
    return gw ? gw.handleInbound(msg) : Promise.resolve()
  }

  async start(): Promise<void> {
    if (!this.appId || !this.appSecret) {
      this.ctx.logger.warn(`[im-channel-qq:${this.id}] credentials missing — bind via QR scan first`)
      this.setStatus('error', 'credentials missing — bind via QR scan first')
      return
    }
    this.stopped = false
    this.setStatus('offline')

    const { QQBot } = await import('@tencent-connect/qqbot-nodejs')
    const bot = new QQBot({
      appId: this.appId,
      appSecret: this.appSecret,
      accountId: this.id,
      markdownSupport: true,
      // Fire-and-forget: don't block startup on the token round-trip — a
      // brand-new QR-scanned bot may not yet be approved by QQ and the
      // token endpoint will fail; the SDK's background refresher handles
      // retries without freezing our start().
      tokenPrefetch: 'async',
    })
    this.bot = bot

    bot.on('ready', () => {
      this.reconnectAttempts = 0
      this.active = true
      this.setStatus('online')
    })
    bot.on('resumed', () => {
      this.active = true
      this.setStatus('online')
    })
    bot.on('error', (err: Error) => {
      this.ctx.logger.warn(`[im-channel-qq:${this.id}] gateway error: ${err.message}`)
      if (!this.stopped && this.active) {
        this.setStatus('offline')
        this.scheduleReconnect()
      }
    })
    bot.on('message', (_ctx, msg: QQBotInboundMessage) => {
      try {
        void this.handleMessage(msg)
      } catch (err) {
        this.ctx.logger.warn(`[im-channel-qq:${this.id}] handleMessage failed: ${String(err)}`)
      }
    })
    bot.on('interaction', (_ctx, event) => {
      // Button clicks (approval / structured replies). `button_data` carries the
      // action id (e.g. 'allow' / 'reject'), which the gateway's handleInbound
      // recognizes as a verdict keyword — so clicking an approval button
      // resolves the pending human-in-the-loop instead of forwarding raw text
      // to the agent. `messageId` is set to the unique interaction id so the
      // gateway-level dedup never drops a second click within the TTL.
      const btnId =
        event.data?.resolved?.button_data ?? event.data?.resolved?.button_id
      if (!btnId) return
      void bot.acknowledgeInteraction(event.id).catch(() => undefined)
      const groupOpenid = event.data?.group_openid
      const userId = event.data?.resolved?.user_id ?? event.data?.user_openid ?? ''
      if (!userId && !groupOpenid) return
      const conversationId = groupOpenid ? `group:${groupOpenid}` : `c2c:${userId}`
      const uid = groupOpenid ? (event.data?.group_member_openid ?? userId) : userId
      const msg: ImInboundMessage = {
        channelId: this.id,
        conversationId,
        userId: uid,
        text: btnId,
        messageId: `btn:${event.id}`,
      }
      void this.deliver(msg).catch(() => undefined)
    })

    // Don't await bot.start() indefinitely: the SDK's websocket transport
    // may stay in a reconnect loop forever (e.g. new bot not yet approved)
    // and never resolve start(). Bound it so applyConfig returns in time
    // and the UI shows "connecting" instead of hanging on save.
    let startResolved = false
    await Promise.race([
      bot
        .start()
        .then(() => {
          startResolved = true
        })
        .catch((err) => {
          this.ctx.logger.warn(`[im-channel-qq:${this.id}] bot.start rejected: ${String(err?.message)}`)
          this.setStatus('error', `bot.start rejected: ${String(err?.message)}`)
        }),
      new Promise<void>((resolve) =>
        setTimeout(() => {
          if (!startResolved) {
            this.ctx.logger.warn(`[im-channel-qq:${this.id}] bot.start did not resolve within 5s — continuing in background`)
          }
          resolve()
        }, 5_000),
      ),
    ])
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    for (const t of this.streamBeatTimers.values()) clearInterval(t)
    this.streamBeatTimers.clear()
    this.streams.clear()
    const bot = this.bot
    this.bot = null
    if (bot) {
      try {
        bot.stop()
      } catch (err) {
        this.ctx.logger.warn(`[im-channel-qq:${this.id}] stop failed: ${String(err)}`)
      }
    }
    this.active = false
    this.setStatus('offline')
  }

  // ── Reconnect ──

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const attempt = this.reconnectAttempts
    this.reconnectAttempts += 1
    const backoff = Math.min(
      MAX_BACKOFF_DELAY,
      BASE_BACKOFF_DELAY * 2 ** Math.min(attempt, 5),
    )
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopped) return
      this.setStatus('offline')
      void this.start().catch((err) => {
        this.ctx.logger.warn(`[im-channel-qq:${this.id}] reconnect failed (${attempt}): ${String(err?.message)}`)
        this.scheduleReconnect()
      })
    }, backoff)
  }

  // ── Inbound ──

  /**
   * 解析某群的生效配置。优先级：具体群 > `groups['*']` > 账号默认
   * （requireMention 取 defaultRequireMention，其余取内置默认值）。
   */
  private resolveGroupConfig(groupOpenid: string): ResolvedGroupConfig {
    const wildcard = this.groups['*'] ?? {}
    const specific = this.groups[groupOpenid] ?? {}
    const pick = <K extends keyof GroupConfig>(
      key: K,
      fallback: NonNullable<GroupConfig[K]>,
    ): NonNullable<GroupConfig[K]> =>
      (specific[key] ?? wildcard[key] ?? fallback) as NonNullable<GroupConfig[K]>
    return {
      requireMention: pick('requireMention', this.defaultRequireMention),
      ignoreOtherMentions: pick('ignoreOtherMentions', false),
      // 默认 full —— 保持与历史行为一致（参考项目默认 restricted）。
      toolPolicy: pick('toolPolicy', 'full'),
      name: pick('name', ''),
      prompt: pick('prompt', ''),
    }
  }

  /** 群是否被允许（groupPolicy 门禁）。 */
  private isGroupAllowed(groupOpenid: string): boolean {
    if (this.groupPolicy === 'disabled') return false
    if (this.groupPolicy === 'allowlist') {
      if (this.groupAllowFrom.length === 0) return false
      const key = groupOpenid.toLowerCase()
      return this.groupAllowFrom.some((v) => v === '*' || v === key)
    }
    return true
  }

  /** 构造注入到群消息前缀的策略提示（名称 / 行为 PE / 工具策略）。 */
  private buildGroupHint(cfg: ResolvedGroupConfig): string {
    const parts: string[] = []
    if (cfg.name) parts.push(`当前群: ${cfg.name}`)
    if (cfg.prompt) parts.push(cfg.prompt)
    const toolHint = TOOL_POLICY_HINTS[cfg.toolPolicy]
    if (toolHint) parts.push(toolHint)
    return parts.length ? `[群聊策略]\n${parts.join('\n')}` : ''
  }

  private async handleMessage(msg: QQBotInboundMessage): Promise<void> {
    const kind = msg.kind
    // Guild / dm channels are out of scope (QQ Open Platform c2c + group).
    if (kind !== 'c2c' && kind !== 'group') return
    if (msg.senderIsBot) return

    // ── Dedup guard: QQ SDK may replay events on websocket reconnect ──
    const msgKey = `${kind}:${msg.messageId}`
    const now = Date.now()
    for (const [k, ts] of this.seenMsgIds) {
      if (now - ts > QQAdapter.DEDUP_TTL_MS) this.seenMsgIds.delete(k)
    }
    if (this.seenMsgIds.has(msgKey)) {
      this.ctx.logger.debug(`[im-channel-qq:${this.id}] duplicate message ${msgKey} — skipped`)
      return
    }
    this.seenMsgIds.set(msgKey, now)

    let text = (msg.content ?? '').trim()
    // Quote resolution: when the user replies to a specific message, QQ
    // pushes the quoted content as msg_elements[0] (refMsgIdx is set).
    if (msg.refMsgIdx && Array.isArray(msg.msgElements) && msg.msgElements.length > 0) {
      const quoted = msg.msgElements[0].content?.trim()
      if (quoted) {
        text = `[用户正在回复以下消息: ${quoted}]\n${text}`
      }
    }
    // Voice messages: QQ provides server-side ASR text.
    const voiceText = (msg.attachments ?? [])
      .map((a) => a.asr_refer_text)
      .find((t): t is string => Boolean(t))
    if (voiceText) text = text ? `${text}\n[语音转文字: ${voiceText}]` : `[语音转文字: ${voiceText}]`

    // Download inbound images (attachments carry a plain URL) → base64.
    const images: ImImage[] = []
    for (const att of msg.attachments ?? []) {
      if (!att.url) continue
      if (!att.content_type?.startsWith('image/')) continue
      try {
        // SSRF 防护：附件 URL 由外部事件驱动，拒绝内网/元数据端点。
        await validateRemoteUrl(att.url)
        const res = await fetch(att.url, { signal: AbortSignal.timeout(INBOUND_FETCH_TIMEOUT_MS) })
        if (!res.ok) continue
        const buf = Buffer.from(await res.arrayBuffer())
        images.push({
          mediaType: mimeFromContentType(att.content_type),
          data: buf.toString('base64'),
        })
      } catch (err) {
        this.ctx.logger.warn(`[im-channel-qq:${this.id}] image download failed: ${String(err)}`)
      }
    }

    if (!text && images.length === 0) return
    if (kind === 'c2c') {
      this.lastMsgIds.set(`c2c:${msg.senderId}`, msg.messageId)
      const message: ImInboundMessage = {
        channelId: this.id,
        conversationId: `c2c:${msg.senderId}`,
        userId: msg.senderId,
        text,
        images: images.length ? images : undefined,
        senderNick: msg.senderName,
        isGroup: false,
        messageId: String(msg.messageId),
      }
      void this.deliver(message).catch((err) =>
        this.ctx.logger.error(`[im-channel-qq:${this.id}] handleInbound failed`, err),
      )
      return
    }

    // Group chat ── 按群策略门禁 + @规则 + 行为提示注入。
    const groupOpenid = msg.groupOpenid ?? msg.channelId ?? ''
    if (!groupOpenid) return
    if (!this.isGroupAllowed(groupOpenid)) {
      this.ctx.logger.debug(`[im-channel-qq:${this.id}] group ${groupOpenid} blocked (groupPolicy=${this.groupPolicy})`)
      return
    }
    const gcfg = this.resolveGroupConfig(groupOpenid)
    const mentions = msg.mentions ?? []
    const atBot = mentions.some((m) => m?.is_you === true)
    // 配置为忽略「@了其他人但没 @机器人」的消息 → 直接丢弃。
    if (!atBot && mentions.length > 0 && gcfg.ignoreOtherMentions) return
    if (gcfg.requireMention && !atBot) return
    const hint = this.buildGroupHint(gcfg)
    this.lastMsgIds.set(`group:${groupOpenid}`, msg.messageId)
    const message: ImInboundMessage = {
      channelId: this.id,
      conversationId: `group:${groupOpenid}`,
      userId: msg.senderId,
      text: hint ? (text ? `${hint}\n${text}` : hint) : text,
      images: images.length ? images : undefined,
      senderNick: msg.senderName,
      isGroup: true,
      messageId: String(msg.messageId),
    }
    void this.deliver(message).catch((err) =>
      this.ctx.logger.error(`[im-channel-qq:${this.id}] handleInbound failed`, err),
    )
  }

  // ── Outbound ──

  private parseTarget(target: string): { scope: 'c2c' | 'group'; targetId: string } | null {
    const sep = target.indexOf(':')
    const scope = target.slice(0, sep) as 'c2c' | 'group'
    const targetId = target.slice(sep + 1)
    if ((scope !== 'c2c' && scope !== 'group') || !targetId) return null
    return { scope, targetId }
  }

  /**
   * Build a ReplyTarget. When `replyMsgId` is given it is used; otherwise the
   * conversation's last inbound msgId is used **iff** quoteReply is on. A
   * target carrying msgId is a passive reply (QQ renders it as a quote of the
   * user's message); without msgId it is a proactive push.
   */
  private targetFor(
    rt: { scope: 'c2c' | 'group'; targetId: string },
    conversationId: string,
    replyMsgId?: string | null,
  ): ReplyTarget {
    const msgId =
      replyMsgId ?? (this.quoteReply ? this.lastMsgIds.get(conversationId) : undefined)
    return msgId
      ? { scope: rt.scope, targetId: rt.targetId, msgId }
      : { scope: rt.scope, targetId: rt.targetId }
  }

  /** The same target minus the quote — used as the retry path. */
  private bareTarget(rt: { scope: 'c2c' | 'group'; targetId: string }): ReplyTarget {
    return { scope: rt.scope, targetId: rt.targetId }
  }

  /**
   * Run a send against a (possibly quoting) target; if the quoted send fails
   * (passive-reply quota exhausted / window closed) retry as a proactive push
   * so the user always gets the message.
   */
  private async sendQuoted<T>(
    target: ReplyTarget,
    bare: ReplyTarget,
    send: (t: ReplyTarget) => Promise<T>,
  ): Promise<T> {
    try {
      return await send(target)
    } catch (err) {
      if (!target.msgId) throw err
      this.ctx.logger.warn(`[im-channel-qq:${this.id}] quote reply failed, retrying as push: ${String(err)}`)
      return await send(bare)
    }
  }

  async sendText(conversationId: string, text: string, options?: SendTextOptions): Promise<void> {
    const bot = this.bot
    if (!bot) throw new Error('QQ bot not connected')
    const rt = this.parseTarget(conversationId)
    if (!rt) {
      this.ctx.logger.warn(`[im-channel-qq:${this.id}] invalid send target: ${conversationId}`)
      return
    }
    // 出站清洗：剥离 system-reminder / thinking 等脚手架内容。
    const clean = options?.raw ? text : sanitizeOutboundText(text)
    const enriched = await this.sendMediaForText(rt, conversationId, clean)
    // Chunk at maxMessageChars so a single reply never exceeds QQ's per-message
    // limit (covers the stream-overflow fallback and every other text path).
    const max = this.maxMessageChars ?? 4000
    const chunks = splitText(enriched, max, 'zh')
    const bare = this.bareTarget(rt)
    const replyMsgId = options?.replyToId ?? undefined
    for (let i = 0; i < chunks.length; i++) {
      // 只让首片引用用户消息：被动回复有单条 inbound 的配额上限，长消息
      // 若每片都引用会耗尽配额，其余片走主动推送。
      const target = i === 0 ? this.targetFor(rt, conversationId, replyMsgId) : bare
      await this.sendQuoted(target, bare, (t) => bot.sendText(t, chunks[i]))
    }
  }

  async sendImage(conversationId: string, image: ImImage): Promise<void> {
    const bot = this.bot
    const rt = this.parseTarget(conversationId)
    if (!bot || !rt) return
    try {
      await this.sendQuoted(
        this.targetFor(rt, conversationId),
        this.bareTarget(rt),
        (t) => bot.sendImage(t, { base64: image.data, type: 'image/jpeg' } as never),
      )
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-qq:${this.id}] sendImage failed: ${String(err)}`)
    }
  }

  async sendMedia(conversationId: string, filePath: string, caption?: string): Promise<void> {
    const rt = this.parseTarget(conversationId)
    if (!rt) {
      this.ctx.logger.warn(`[im-channel-qq:${this.id}] invalid sendMedia target: ${conversationId}`)
      return
    }
    if (!isRegularFile(filePath)) {
      this.ctx.logger.warn(`[im-channel-qq:${this.id}] sendMedia: path not a regular file: ${filePath}`)
      return
    }
    if (caption) {
      await this.sendText(conversationId, caption)
    }
    await this.sendLocalMedia(rt, filePath, conversationId)
  }

  // ── Voice (outbound) ──

  /**
   * Push a voice message from an existing audio source (local file / URL /
   * base64). Local paths must be regular files; URLs pass the SSRF guard. If
   * the voice send fails we fall back to sending the audio as a file so the
   * content is never lost.
   */
  async sendVoice(conversationId: string, voice: ImVoice): Promise<void> {
    const bot = this.bot
    const rt = this.parseTarget(conversationId)
    if (!bot || !rt) return
    if (voice.localPath && !isRegularFile(voice.localPath)) {
      this.ctx.logger.warn(`[im-channel-qq:${this.id}] sendVoice: not a regular file: ${voice.localPath}`)
      return
    }
    if (voice.url) {
      try {
        await validateRemoteUrl(voice.url)
      } catch (err) {
        this.ctx.logger.warn(`[im-channel-qq:${this.id}] sendVoice URL blocked: ${String(err)}`)
        return
      }
    }
    const source = voice.localPath
      ? { localPath: voice.localPath }
      : voice.url
        ? { url: voice.url }
        : voice.base64
          ? { buffer: Buffer.from(voice.base64, 'base64') }
          : null
    if (!source) {
      this.ctx.logger.warn(`[im-channel-qq:${this.id}] sendVoice: no audio source provided`)
      return
    }
    const target = this.targetFor(rt, conversationId)
    try {
      await this.sendQuoted(target, this.bareTarget(rt), (t) => bot.sendVoice(t, source))
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-qq:${this.id}] sendVoice failed, falling back to file: ${String(err)}`)
      try {
        const { MediaFileType } = await import('@tencent-connect/qqbot-nodejs')
        await bot.sendMedia({
          target: this.bareTarget(rt),
          fileType: MediaFileType.FILE,
          ...source,
          fileName: voice.localPath ? basename(voice.localPath) : 'voice.mp3',
        })
      } catch (fallbackErr) {
        this.ctx.logger.warn(`[im-channel-qq:${this.id}] sendVoice file fallback failed: ${String(fallbackErr)}`)
      }
    }
  }

  /**
   * Synthesize speech via an OpenAI-compatible `/audio/speech` endpoint.
   * Returns null when TTS is not configured or the request fails — callers
   * then degrade to plain text.
   */
  async synthesizeVoice(text: string): Promise<ImVoice | null> {
    const tts = this.cfg.tts
    if (!tts?.enabled || !tts.baseUrl || !text.trim()) return null
    const url = `${tts.baseUrl.replace(/\/+$/, '')}/audio/speech`
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (tts.apiKey) headers.authorization = `Bearer ${tts.apiKey}`
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: tts.model || 'tts-1',
          input: text,
          voice: tts.voice || 'alloy',
          response_format: tts.format || 'mp3',
        }),
        signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
      })
      if (!res.ok) {
        this.ctx.logger.warn(`[im-channel-qq:${this.id}] TTS HTTP ${res.status}: ${res.statusText}`)
        return null
      }
      const buf = Buffer.from(await res.arrayBuffer())
      if (!buf.length) return null
      return { base64: buf.toString('base64') }
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-qq:${this.id}] TTS request failed: ${String(err)}`)
      return null
    }
  }

  /**
   * Detect local image/file paths in a reply, upload each and send it as a
   * standalone media message (sendImage / sendMedia). Returns the text with
   * the references replaced by short notes.
   */
  private async sendMediaForText(
    rt: { scope: 'c2c' | 'group'; targetId: string },
    conversationId: string,
    text: string,
  ): Promise<string> {
    const bot = this.bot
    if (!bot) return text
    let result = text
    // 1. markdown image syntax: ![alt](<local path>)
    for (const m of text.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
      const [full, alt, p] = m
      if (!isLocalPath(p)) continue
      const filePath = toLocalPath(p)
      if (!isRegularFile(filePath)) continue
      await this.sendLocalMedia(rt, filePath, conversationId)
      result = result.replace(full, alt ? `[${alt}]` : '[图片]')
    }
    // 2. bare absolute paths that exist on disk.
    const bareFile =
      /(?:file:\/\/)?[A-Za-z]:[\\/][^\s"'()<>]+|(?:\/(?:Users|home|tmp|var|private|root)\/[^\s"'()<>]+)/g
    for (const m of result.matchAll(bareFile)) {
      const filePath = toLocalPath(m[0])
      if (!isRegularFile(filePath)) continue
      const ok = await this.sendLocalMedia(rt, filePath, conversationId)
      if (ok) {
        const isImg = /\.(png|jpe?g|gif|bmp|webp)$/i.test(filePath)
        result = result.replace(m[0], isImg ? '[图片]' : `[文件已发送：${basename(filePath)}]`)
      }
    }
    return result
  }

  /** Upload one local file and send it as an IMAGE / FILE media message. */
  private async sendLocalMedia(
    rt: { scope: 'c2c' | 'group'; targetId: string },
    filePath: string,
    conversationId?: string,
  ): Promise<boolean> {
    const bot = this.bot
    if (!bot) return false
    const target = conversationId ? this.targetFor(rt, conversationId) : this.bareTarget(rt)
    const bare = this.bareTarget(rt)
    try {
      const isImage = /\.(png|jpe?g|gif|bmp|webp)$/i.test(filePath)
      if (isImage) {
        await this.sendQuoted(target, bare, (t) => bot.sendImage(t, { localPath: filePath }))
      } else {
        const { MediaFileType } = await import('@tencent-connect/qqbot-nodejs')
        await this.sendQuoted(target, bare, (t) =>
          bot.sendMedia({
            target: t,
            fileType: MediaFileType.FILE,
            localPath: filePath,
            fileName: basename(filePath),
          }),
        )
      }
      return true
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-qq:${this.id}] media send failed (${filePath}): ${String(err)}`)
      return false
    }
  }

  // ── Structured approval (inline keyboard) ──

  /**
   * Render a structured approval prompt with inline-keyboard buttons. Clicking
   * a button fires an `interaction` event whose `button_data` equals the
   * action `id` ('allow' / 'reject'); the gateway's `handleInbound` matches
   * that as a verdict keyword and consumes the pending approval — wiring QQ's
   * approve-button flow into human-in-the-loop. If the keyboard API fails
   * (e.g. unsupported in some group scopes) we fall back to a plain (chunked)
   * text prompt so the user always sees the request.
   */
  async sendApprovalRequest(conversationId: string, payload: ApprovalRequest): Promise<void> {
    const bot = this.bot
    const rt = this.parseTarget(conversationId)
    if (!bot || !rt) return
    const keyboard: InlineKeyboard = {
      content: {
        rows: payload.actions.map((a) => ({
          buttons: [
            {
              id: a.id,
              render_data: {
                label: a.label,
                visited_label: a.label,
                style: a.style ?? 1,
              },
              action: {
                type: 1, // 回调型：点击 → INTERACTION_CREATE，button_data = data
                data: a.id,
                permission: { type: 2 }, // 所有人可点击
                click_limit: 1,
              },
              group_id: 'approval', // 点一个后同组按钮变灰
            },
          ],
        })),
      },
    }
    const content = [payload.title, payload.body].filter(Boolean).join('\n')
    const target = this.targetFor(rt, conversationId)
    try {
      await this.sendQuoted(target, this.bareTarget(rt), (t) =>
        bot.sendTextWithKeyboard(t, content, keyboard),
      )
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-qq:${this.id}] sendApprovalRequest keyboard failed, falling back to sendText: ${String(err)}`)
      await this.sendText(conversationId, content)
    }
  }

  // ── Streaming (C2C only — QQ stream_messages API is c2c-scoped) ──

  /**
   * Send one raw stream frame. QQ's stream is APPEND-only: each frame's
   * `content_raw` must *extend* the previous frame's content. We keep an
   * invisible zero-width-space `prefix` on the stream and prepend it to every
   * real text frame, so the first text frame (`prefix + text`) is always a
   * legal extension of the latest heartbeat frame (`prefix`) and is accepted.
   */
  private async sendStreamFrame(
    st: RawStream,
    state: StreamInputState,
    content: string,
  ): Promise<void> {
    const bot = this.bot
    if (!bot) throw new Error('QQ bot not connected')
    const req: StreamMessageRequest = {
      input_mode: StreamInputMode.REPLACE,
      input_state: state,
      content_type: StreamContentType.MARKDOWN,
      content_raw: content,
      event_id: st.msgId,
      msg_id: st.msgId,
      msg_seq: st.msgSeq,
      index: st.index++,
    }
    if (st.streamMsgId) req.stream_msg_id = st.streamMsgId
    const resp = await bot.messageApi.sendC2CStreamMessage(
      { appId: this.appId, clientSecret: this.appSecret },
      st.openid,
      req,
    )
    if (resp?.id && !st.streamMsgId) st.streamMsgId = resp.id
  }

  async beginStream(conversationId: string): Promise<void> {
    const rt = this.parseTarget(conversationId)
    const bot = this.bot
    if (!rt || !bot) return
    // Clear any stale heartbeat timer / stream state from a previous turn.
    this.clearBeat(conversationId)
    this.streams.delete(conversationId)
    // Group chats don't support stream_messages — leave NO stream entry so
    // streamText no-ops and endStream falls back to a plain sendText.
    if (rt.scope !== 'c2c') return
    const msgId = this.lastMsgIds.get(conversationId)
    if (!msgId) {
      this.ctx.logger.warn(`[im-channel-qq:${this.id}] beginStream: no inbound msgId for ${conversationId}`)
      return
    }
    const st: RawStream = {
      openid: rt.targetId,
      msgId,
      msgSeq: getNextMsgSeq(msgId),
      index: 0,
      failed: false,
      // One zero-width space → renders as the "bot avatar + three dots" bubble
      // (invisible content), and is a valid prefix of the later text frame.
      prefix: '\u200b',
      hasText: false,
      shownText: '',
    }
    this.streams.set(conversationId, st)
    // First frame: GENERATING with just the prefix → QQ shows the dots
    // placeholder immediately. (v2 proved a \u200b first frame is accepted and
    // opens the stream.)
    void this.sendStreamFrame(st, StreamInputState.GENERATING, st.prefix).catch((err) => {
      this.ctx.logger.warn(`[im-channel-qq:${this.id}] beginStream initial frame failed: ${String(err)}`)
    })
    // Keepalive: QQ expires the GENERATING bubble when no (new) frame arrives
    // for a while — that was why the dots vanished mid-tool-call. Grow the
    // prefix by one zero-width space and re-send it every STREAM_BEAT_MS.
    // Each heartbeat is a strict extension of the previous frame → always
    // accepted, and resets the expiry. Direct API calls, so identical/!=
    // content both work (no SDK same-text no-op).
    const timer = setInterval(() => {
      const s = this.streams.get(conversationId)
      if (!s || s.failed || s.hasText) return
      s.prefix += '\u200b'
      void this.sendStreamFrame(s, StreamInputState.GENERATING, s.prefix).catch((err) => {
        this.ctx.logger.debug(`[im-channel-qq:${this.id}] stream beat failed: ${String(err)}`)
      })
    }, QQAdapter.STREAM_BEAT_MS)
    this.streamBeatTimers.set(conversationId, timer)
  }

  async streamText(conversationId: string, text: string, _finished = false): Promise<void> {
    const st = this.streams.get(conversationId)
    if (!st || st.failed) return
    // 清洗后再入流，避免脚手架标签出现在气泡里（幂等）。
    const clean = sanitizeOutboundText(text)
    // Real text is flowing — stop heartbeats (the bubble now shows real text).
    st.hasText = true
    // QQ's stream is APPEND-only and a single frame can hold at most
    // STREAM_MAX_CHARS (minus the invisible prefix). While the cumulative reply
    // fits we extend the bubble frame; once it exceeds the cap we can no longer
    // grow the bubble, so we fill it to the cap exactly once and let endStream
    // flush the remainder as separate messages.
    const cap = QQAdapter.STREAM_MAX_CHARS - st.prefix.length
    if (clean.length <= cap) {
      st.shownText = clean
      try {
        await this.sendStreamFrame(st, StreamInputState.GENERATING, st.prefix + clean)
      } catch (err) {
        this.ctx.logger.warn(`[im-channel-qq:${this.id}] streamText failed — disabling stream: ${String(err)}`)
        st.failed = true
        this.clearBeat(conversationId)
      }
      return
    }
    if (st.shownText.length < cap) {
      const capped = clean.slice(0, cap)
      st.shownText = capped
      try {
        await this.sendStreamFrame(st, StreamInputState.GENERATING, st.prefix + capped)
      } catch (err) {
        this.ctx.logger.warn(`[im-channel-qq:${this.id}] streamText (cap) failed — disabling stream: ${String(err)}`)
        st.failed = true
        this.clearBeat(conversationId)
      }
    }
  }

  async endStream(conversationId: string, text: string): Promise<void> {
    this.clearBeat(conversationId)
    const st = this.streams.get(conversationId)
    this.streams.delete(conversationId)
    // 与 streamText 用同一清洗函数，保证 shownText 与这里的前缀切片一致。
    const clean = sanitizeOutboundText(text)
    if (!st) {
      // No stream (group chat / no msgId / beginStream failed) — plain text.
      await this.sendText(conversationId, clean)
      return
    }
    if (st.failed) {
      // A frame was rejected mid-turn → the stream is dead. Emit the whole
      // reply as plain (chunked) messages so nothing is lost and the frozen
      // bubble is simply superseded by a real message.
      await this.sendText(conversationId, clean)
      return
    }
    // Close the bubble with a DONE frame carrying the shown text. The leading
    // zero-width prefix is invisible, so the user sees clean text. Its content
    // matches the last GENERATING frame (verified working in v4) — QQ accepts it.
    try {
      await this.sendStreamFrame(st, StreamInputState.DONE, st.prefix + st.shownText)
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-qq:${this.id}] endStream DONE failed, falling back to sendText: ${String(err)}`)
      await this.sendText(conversationId, clean)
      return
    }
    // Anything beyond the bubble cap goes out as separate (chunked) messages.
    const overflow = clean.slice(st.shownText.length)
    if (overflow) {
      await this.sendText(conversationId, overflow)
    }
  }

  /** Stop the per-conversation heartbeat. */
  private clearBeat(conversationId: string): void {
    const t = this.streamBeatTimers.get(conversationId)
    if (t) clearInterval(t)
    this.streamBeatTimers.delete(conversationId)
  }
}

/** Export the adapter class for the single-entry bundle to instantiate. */
export { QQAdapter }
