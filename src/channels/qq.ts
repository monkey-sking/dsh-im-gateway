/**
 * QQ Bot channel adapter — ported from
 * pi-desk-top/src/main/im/qq/qq-adapter.ts, adapted to the cordis
 * ImChannelAdapter contract:
 *   - Private chats: every message maps to a c2c conversation keyed by the
 *     sender's openid.
 *   - Group chats: only messages that @ the bot are processed; the group
 *     shares one conversation keyed by the group openid.
 *   - Media: inbound images are downloaded (attachments carry a plain URL)
 *     and handed to the agent as base64; outbound local paths are uploaded
 *     via the SDK's sendImage / sendMedia.
 *   - Streaming (C2C only — QQ stream_messages API is c2c-scoped):
 *     beginStream/streamText/endStream with replace-mode fallback.
 */
import { Context } from '@deepseek-ai/cordis'
import { statSync } from 'node:fs'
import { basename } from 'node:path'
import type {
  MediaFileType,
  QQBot,
  QQBotInboundMessage,
  StreamSession,
} from '@tencent-connect/qqbot-nodejs'
import type { ChannelStatus, ImChannelAdapter, ImImage, ImInboundMessage, QqChannelConfig } from '../gateway/types'

const BASE_BACKOFF_DELAY = 2_000
const MAX_BACKOFF_DELAY = 30_000

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

class QQAdapter implements ImChannelAdapter {
  private appId: string
  private appSecret: string
  private bot: QQBot | null = null
  private stopped = true
  private active = false
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  /** Per-peer (target string) last inbound msgId — anchors stream replies. */
  private lastMsgIds = new Map<string, string>()
  /** Active StreamSession per peer (C2C only). */
  private streamSessions = new Map<string, { session: StreamSession | null; enabled: boolean }>()

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
    this.appId = config.appId ?? ''
    this.appSecret = config.clientSecret ?? ''
  }

  isActive(): boolean {
    return this.active
  }

  private setStatus(s: 'online' | 'offline' | 'error', error?: string): void {
    this.statusListener?.({ status: s, error, lastChange: Date.now() })
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
      // Button clicks (approval messages). button_data carries the button id.
      const btnId =
        event.data?.resolved?.button_data ?? event.data?.resolved?.button_id
      if (!btnId) return
      void bot.acknowledgeInteraction(event.id).catch(() => undefined)
      const userId = event.data?.resolved?.user_id
      if (userId) {
        // Surface a synthetic inbound so the agent sees the approval text.
        const msg: ImInboundMessage = {
          channelId: this.id,
          conversationId: `c2c:${userId}`,
          userId,
          text: `[按钮点击] ${btnId}`,
        }
        void this.ctx.imGateway.handleInbound(msg).catch(() => undefined)
      }
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

  private async handleMessage(msg: QQBotInboundMessage): Promise<void> {
    const kind = msg.kind
    // Guild / dm channels are out of scope (QQ Open Platform c2c + group).
    if (kind !== 'c2c' && kind !== 'group') return
    if (msg.senderIsBot) return

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
        const res = await fetch(att.url)
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
    const base = {
      channelId: this.id,
      text,
      images: images.length ? images : undefined,
    }
    if (kind === 'c2c') {
      this.lastMsgIds.set(`c2c:${msg.senderId}`, msg.messageId)
      const message: ImInboundMessage = {
        ...base,
        conversationId: `c2c:${msg.senderId}`,
        userId: msg.senderId,
        senderNick: msg.senderName,
        isGroup: false,
      }
      void this.ctx.imGateway.handleInbound(message).catch((err) =>
        this.ctx.logger.error(`[im-channel-qq:${this.id}] handleInbound failed`, err),
      )
      return
    }

    // Group chat: only process messages that @ this bot.
    const groupOpenid = msg.groupOpenid ?? msg.channelId ?? ''
    if (!groupOpenid) return
    const mentions = msg.mentions ?? []
    const atBot = mentions.some((m) => m?.is_you === true)
    if (!atBot) return
    const message: ImInboundMessage = {
      ...base,
      conversationId: `group:${groupOpenid}`,
      userId: msg.senderId,
      senderNick: msg.senderName,
      isGroup: true,
    }
    void this.ctx.imGateway.handleInbound(message).catch((err) =>
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

  async sendText(conversationId: string, text: string): Promise<void> {
    const bot = this.bot
    if (!bot) throw new Error('QQ bot not connected')
    const rt = this.parseTarget(conversationId)
    if (!rt) {
      this.ctx.logger.warn(`[im-channel-qq:${this.id}] invalid send target: ${conversationId}`)
      return
    }
    const enriched = await this.sendMediaForText(rt, text)
    await bot.sendText(rt, enriched)
  }

  async sendImage(conversationId: string, image: ImImage): Promise<void> {
    const bot = this.bot
    const rt = this.parseTarget(conversationId)
    if (!bot || !rt) return
    try {
      await bot.sendImage(rt, { base64: image.data, type: 'image/jpeg' } as never)
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-qq:${this.id}] sendImage failed: ${String(err)}`)
    }
  }

  /**
   * Detect local image/file paths in a reply, upload each and send it as a
   * standalone media message (sendImage / sendMedia). Returns the text with
   * the references replaced by short notes.
   */
  private async sendMediaForText(
    rt: { scope: 'c2c' | 'group'; targetId: string },
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
      await this.sendLocalMedia(rt, filePath)
      result = result.replace(full, alt ? `[${alt}]` : '[图片]')
    }
    // 2. bare absolute paths that exist on disk.
    const bareFile =
      /(?:file:\/\/)?[A-Za-z]:[\\/][^\s"'()<>]+|(?:\/(?:Users|home|tmp|var|private|root)\/[^\s"'()<>]+)/g
    for (const m of result.matchAll(bareFile)) {
      const filePath = toLocalPath(m[0])
      if (!isRegularFile(filePath)) continue
      const ok = await this.sendLocalMedia(rt, filePath)
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
  ): Promise<boolean> {
    const bot = this.bot
    if (!bot) return false
    try {
      const isImage = /\.(png|jpe?g|gif|bmp|webp)$/i.test(filePath)
      if (isImage) {
        await bot.sendImage(rt, { localPath: filePath })
      } else {
        const { MediaFileType: MFT } = await import('@tencent-connect/qqbot-nodejs')
        await bot.sendMedia({
          target: rt,
          fileType: MFT.FILE,
          localPath: filePath,
          fileName: basename(filePath),
        })
      }
      return true
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-qq:${this.id}] media send failed (${filePath}): ${String(err)}`)
      return false
    }
  }

  // ── Streaming (C2C only — QQ stream_messages API is c2c-scoped) ──

  async beginStream(conversationId: string): Promise<void> {
    const rt = this.parseTarget(conversationId)
    const bot = this.bot
    if (!rt || !bot) return
    // Group chats don't support stream_messages — mark disabled so
    // streamText is a no-op and endStream falls back to a plain sendText.
    if (rt.scope !== 'c2c') {
      this.streamSessions.set(conversationId, { session: null, enabled: false })
      return
    }
    const msgId = this.lastMsgIds.get(conversationId)
    if (!msgId) {
      this.ctx.logger.warn(`[im-channel-qq:${this.id}] beginStream: no inbound msgId for ${conversationId}`)
      this.streamSessions.set(conversationId, { session: null, enabled: false })
      return
    }
    try {
      const { StreamSession: StreamSessionCtor } = await import(
        '@tencent-connect/qqbot-nodejs'
      )
      const session = new StreamSessionCtor(bot.messageApi, {
        openid: rt.targetId,
        msgId,
        creds: { appId: this.appId, clientSecret: this.appSecret },
      })
      this.streamSessions.set(conversationId, { session, enabled: true })
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-qq:${this.id}] beginStream failed: ${String(err)}`)
      this.streamSessions.set(conversationId, { session: null, enabled: false })
    }
  }

  async streamText(conversationId: string, text: string, _finished = false): Promise<void> {
    const s = this.streamSessions.get(conversationId)
    if (!s?.enabled || !s.session) return
    try {
      await s.session.update(text)
    } catch (err) {
      // QQ stream_messages is REPLACE-mode: it rejects frames whose prefix
      // changed (e.g. the model rewrote earlier content after a tool call).
      // Disable the stream — endStream will fall back to a plain sendText.
      this.ctx.logger.warn(`[im-channel-qq:${this.id}] streamText failed — disabling stream: ${String(err)}`)
      s.enabled = false
    }
  }

  async endStream(conversationId: string, text: string): Promise<void> {
    const s = this.streamSessions.get(conversationId)
    this.streamSessions.delete(conversationId)
    if (!s) {
      // No stream was started (e.g. group chat) — plain sendText fallback.
      await this.sendText(conversationId, text)
      return
    }
    // CRITICAL: a StreamSession registered on the QQ side MUST always be
    // closed (complete → DONE frame / cancel), even when streaming failed
    // earlier (enabled=false). Otherwise the QQ client keeps waiting for
    // stream frames and shows "连接中" forever.
    if (s.session) {
      if (s.enabled) {
        try {
          await s.session.update(text)
          await s.session.complete()
          return
        } catch (err) {
          this.ctx.logger.warn(`[im-channel-qq:${this.id}] endStream failed, falling back to sendText: ${String(err)}`)
          // Fall through: cancel below, then send plain text.
          try {
            s.session.cancel()
          } catch { /* ignore */ }
        }
      } else {
        // Streaming was disabled mid-turn (replace-mode rejection etc.) —
        // still close the server-side session so the client un-sticks.
        try {
          s.session.cancel()
        } catch (err) {
          this.ctx.logger.warn(`[im-channel-qq:${this.id}] endStream cancel failed: ${String(err)}`)
        }
      }
    }
    await this.sendText(conversationId, text)
  }
}

/** Export the adapter class for the single-entry bundle to instantiate. */
export { QQAdapter }
