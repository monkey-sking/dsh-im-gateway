/**
 * 企业微信「智能机器人」通道适配器 —— 官方 WebSocket 长连接。
 *
 * 为什么用长连接（而不是回调 URL）：官方提供 Webhook 与 WebSocket 两种模式，
 * 长连接无需公网 IP / 无需消息加解密、延迟更低，且**是唯一能做流式回复的形态**
 * —— Webhook 模式靠企业微信轮询我们的回调地址取刷新内容，长连接模式由我们
 * 主动推送刷新帧，因此本适配器实现了 beginStream / streamText / endStream。
 *
 * 与其它通道的关键差异（依据企业微信官方文档 path/101463、60904）：
 *   - 流式回复 `stream.content` 是**全量内容**，同一 stream.id 幂等原位替换；
 *     这与网关 StreamThrottle 的累积语义天然一致，直接把累积全文透传即可。
 *   - 回复链接：同一次回调的**所有**刷新帧必须透传回调帧的 `req_id`，故本
 *     适配器为每个会话缓存最近一次入站帧（流式与被动的锚点）。
 *   - 频控：官方限制为**每会话 30 条/分钟**（含流式刷新与主动推送）。网关默认
 *     `streamThrottleMs = 800` 对应 75 条/分钟，会直接触发限流 —— 因此适配器
 *     内部再叠一层 ≥2.1s 的最小推送间隔。丢帧是安全的：下一帧自带全文。
 *   - 首帧须在收到回调后 5 秒内发出，beginStream 会立即推一条「思考中」占位。
 *   - 群聊由平台侧保证「只有 @机器人 才推送」，内容形如 `@RobotA hello`，故
 *     无需 requireMention 门禁，但需剥离开头的 @机器人 占位符。
 *   - 图片 / 语音 / 文件 / 视频**仅单聊**支持（官方限制）。
 *
 * 连接：`WSClient({ botId, secret })` → `connect()`，认证成功后 SDK 自行
 * 心跳保活与指数退避重连。同一机器人官方只允许一条有效长连接，新连接会踢掉
 * 旧的 —— 配置重载时 syncChannels 会先 stopAll，不会自踢。
 */
import type { Context } from '@deepseek-ai/cordis'
import { splitText } from '../gateway/split'
import { sanitizeOutboundText } from '../gateway/sanitize'
import type {
  ChannelStatus,
  GroupConfig,
  GroupPolicy,
  ImChannelAdapter,
  ImImage,
  ImInboundMessage,
  SendTextOptions,
  ToolPolicy,
  WecomChannelConfig,
} from '../gateway/types'

/** 单条文本上限（码点）——与网关其它渠道保持一致，超出即分片。 */
const WECOM_MAX_CHARS = 4000
/** 流式消息 content 上限（字节）——官方限制 20480。 */
const WECOM_STREAM_MAX_BYTES = 20480
/**
 * 流式刷新最小间隔（ms）。官方频控 30 条/分钟/会话，等值间隔需 ≥2000ms，
 * 留 100ms 余量避免边界抖动。网关的 streamThrottleMs 不参与此判定 —— 它默认为
 * 800ms，比官方上限快得多，只靠它会触发限流。
 */
const WECOM_STREAM_MIN_INTERVAL_MS = 2_100
/** 「处理中」占位文案（首帧须在 5s 内发出，先占位再增量刷新）。 */
const THINKING_PLACEHOLDER = '⏳ 正在思考…'
/** 5-minute TTL —— 与其它渠道一致的去重窗口。 */
const DEDUP_TTL_MS = 5 * 60 * 1000
/** 入站媒体单文件大小上限（字节）。 */
const MAX_INBOUND_MEDIA_BYTES = 20 * 1024 * 1024

/** 群工具策略 → 提示词约束（软约束：注入消息前缀，由模型遵守）。 */
const TOOL_POLICY_HINTS: Record<ToolPolicy, string> = {
  full: '',
  restricted: '本群仅可使用只读类工具（读取/查询/搜索），禁止写文件、删除、执行命令等修改性操作。',
  none: '本群禁止调用任何工具，仅用纯文本回答。',
}

/**
 * 入站回调帧的 body（`aibot_msg_callback`）。
 * 各 msgtype 的子结构依据官方文档 path/101463。
 */
interface WecomInboundBody {
  msgid?: string
  aibotid?: string
  /** 会话 ID —— 仅群聊返回。 */
  chatid?: string
  chattype?: 'single' | 'group'
  from?: { userid?: string }
  msgtype?: string
  text?: { content?: string }
  /** 语音消息（官方已转文本，仅单聊）。 */
  voice?: { content?: string }
  /** 图文混排：msg_item[] 内每项形如 { msgtype, text|image }。 */
  mixed?: { msg_item?: Array<Record<string, any>> }
  /** 图片 / 文件 / 视频均带 url + aeskey（长连接模式特有，仅单聊）。 */
  image?: { url?: string; aeskey?: string }
  file?: { url?: string; aeskey?: string }
  video?: { url?: string; aeskey?: string }
}

/** 入站帧（SDK `message` 事件的载荷）。 */
interface WecomFrame {
  cmd?: string
  headers: { req_id: string; [key: string]: unknown }
  body?: WecomInboundBody
}

/** 客户端最小表面（SDK 实例，动态加载后由 shims.d.ts 声明约束）。 */
interface WecomClient {
  on(event: string, handler: (...args: any[]) => void): unknown
  connect(): unknown
  disconnect(): void
  replyStream(frame: unknown, streamId: string, content: string, finish?: boolean): Promise<unknown>
  sendMessage(chatid: string, body: Record<string, unknown>): Promise<unknown>
  uploadMedia(fileBuffer: Buffer, options: Record<string, unknown>): Promise<{ media_id?: string }>
  sendMediaMessage(chatid: string, mediaType: string, mediaId: string): Promise<unknown>
  downloadFile(url: string, aesKey: string): Promise<{ buffer: Buffer; filename?: string }>
}

/** SDK 模块表面。 */
interface WecomSdk {
  WSClient: new (options: Record<string, unknown>) => WecomClient
  generateReqId(prefix: string): string
}

/** 解析后的群配置（所有字段均已填充默认值）。 */
type ResolvedGroupConfig = Required<GroupConfig>

/**
 * 一次回复回合的流式状态。
 *
 * 企业微信的流式回复是「被动 + 主动推送」混合：靠入站帧的 req_id 建流，
 * 靠 streamId 原位刷新。两者都必须缓存，否则刷新帧发不出去。
 */
interface WecomStreamState {
  streamId: string
  /** 建流所用入站帧（透传 req_id）。 */
  frame: WecomFrame
  /** 出站兜底目标（单聊=userid，群聊=chatid）。 */
  targetId: string
  /** 上一次推送的全文（相同则跳过，省一次频控额度）。 */
  lastText: string
  /** 上一次推送时间（频控）。 */
  lastPushAt: number
}

/** 本地文件 → 企业微信 uploadMedia 的 media type。 */
function mediaTypeFor(path: string): 'image' | 'voice' | 'video' | 'file' {
  if (/\.(png|jpe?g|gif|bmp|webp)$/i.test(path)) return 'image'
  if (/\.(mp3|wav|amr|silk|ogg|opus)$/i.test(path)) return 'voice'
  if (/\.(mp4|mov|avi|mkv)$/i.test(path)) return 'video'
  return 'file'
}

/** 按文件头嗅探图片 MIME（企业微信图片只支持 JPG/PNG，其余按 JPEG 兜底）。 */
function sniffImageMime(buffer: Buffer): string {
  if (buffer.length >= 4) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png'
    if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif'
    if (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer.length >= 12 &&
      buffer[8] === 0x57
    ) {
      return 'image/webp'
    }
  }
  return 'image/jpeg'
}

/**
 * 按 UTF-8 字节上限切分字符串 —— 以码点为单位累加，不会把多字节字符劈成
 * 半个（`String.prototype.slice` 按 UTF-16 码元切会切坏 emoji / 生僻字）。
 */
function takeByBytes(text: string, maxBytes: number): { head: string; rest: string } {
  const points = Array.from(text)
  let bytes = 0
  let i = 0
  for (; i < points.length; i++) {
    const size = Buffer.byteLength(points[i], 'utf8')
    if (bytes + size > maxBytes) break
    bytes += size
  }
  return { head: points.slice(0, i).join(''), rest: points.slice(i).join('') }
}

class WecomAdapter implements ImChannelAdapter {
  /** 单条消息字符上限（网关据此做非流式兜底分片）。 */
  readonly maxMessageChars = WECOM_MAX_CHARS

  private readonly botId: string
  private readonly secret: string
  private readonly groupPolicy: GroupPolicy
  private readonly groupAllowFrom: string[]
  private readonly groups: Record<string, GroupConfig>

  private sdk: WecomSdk | null = null
  private client: WecomClient | null = null
  private active = false
  private stopped = true
  /** 已处理 msgid → 时间戳（长连接重连重放去重）。 */
  private readonly seenMsgIds = new Map<string, number>()
  /** conversationId → 最近一次入站帧 + 出站目标（流式锚点 / 兜底推送）。 */
  private readonly lastFrames = new Map<string, { frame: WecomFrame; targetId: string }>()
  /** conversationId → 本回合流式状态。 */
  private readonly streams = new Map<string, WecomStreamState>()
  /** 运行状态回调，由网关在注册时注入。 */
  statusListener?: (status: ChannelStatus) => void

  constructor(
    private readonly ctx: Context,
    config: WecomChannelConfig,
    /** 实例 id（如 'wecom-main'）—— 注册表键。 */
    readonly id: string,
    /** 展示名（实例名或渠道类型名）。 */
    readonly label: string,
  ) {
    this.botId = config.botId ?? ''
    this.secret = config.secret ?? ''
    this.groupPolicy = config.groupPolicy ?? 'open'
    this.groupAllowFrom = (config.groupAllowFrom ?? [])
      .map((v) => String(v).trim().toLowerCase())
      .filter(Boolean)
    this.groups = config.groups ?? {}
  }

  isActive(): boolean {
    return this.active
  }

  private setStatus(s: 'online' | 'offline' | 'error', error?: string): void {
    this.statusListener?.({ status: s, error, lastChange: Date.now() })
  }

  /**
   * 把入站消息投递给网关。用 `ctx.get('imGateway')`（显式查找）而非属性访问，
   * 因为适配器的 ctx 不在 imGateway 的 inject 作用域内（详见 sync.ts 的说明）。
   */
  private deliver(msg: ImInboundMessage): Promise<void> {
    const gw = this.ctx.get('imGateway') as { handleInbound(m: ImInboundMessage): Promise<void> } | undefined
    return gw ? gw.handleInbound(msg) : Promise.resolve()
  }

  async start(): Promise<void> {
    if (!this.botId || !this.secret) {
      this.ctx.logger.warn(`[im-channel-wecom:${this.id}] credentials missing — bind via QR scan first`)
      this.setStatus('error', 'credentials missing — bind via QR scan first')
      return
    }
    this.stopped = false
    this.setStatus('offline')

    let sdk: WecomSdk
    try {
      sdk = (await import('@wecom/aibot-node-sdk')) as unknown as WecomSdk
    } catch (err) {
      // SDK 是可选依赖：未安装时给出可操作的提示，而不是抛栈中断通道启动。
      const detail = err instanceof Error ? err.message : String(err)
      this.ctx.logger.error(
        `[im-channel-wecom:${this.id}] 无法加载 @wecom/aibot-node-sdk（请安装：npm i @wecom/aibot-node-sdk）: ${detail}`,
      )
      this.setStatus('error', `@wecom/aibot-node-sdk not installed: ${detail}`)
      return
    }
    this.sdk = sdk

    const ws = new sdk.WSClient({
      botId: this.botId,
      secret: this.secret,
      maxReconnectAttempts: 10,
      // 静默 SDK 自身日志（默认实现会直接写 stdout）；错误仍由下方事件转出。
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    })
    this.client = ws

    ws.on('connected', () => {
      this.ctx.logger.info(`[im-channel-wecom:${this.id}] WebSocket 已建立，等待认证`)
    })
    ws.on('authenticated', () => {
      if (this.stopped) return
      this.active = true
      this.setStatus('online')
      this.ctx.logger.info(`[im-channel-wecom:${this.id}] 长连接认证成功（botId=${this.botId}）`)
    })
    ws.on('reconnecting', (attempt: number) => {
      this.active = false
      this.setStatus('offline', `reconnecting #${attempt}`)
    })
    ws.on('disconnected', (reason: string) => {
      this.active = false
      if (!this.stopped && reason) {
        this.ctx.logger.warn(`[im-channel-wecom:${this.id}] 连接断开: ${reason}`)
      }
      this.setStatus('offline', reason ? String(reason) : undefined)
    })
    ws.on('error', (err: unknown) => {
      const detail = err instanceof Error ? err.message : String(err)
      this.ctx.logger.warn(`[im-channel-wecom:${this.id}] WebSocket 错误: ${detail}`)
      this.setStatus('error', detail)
    })
    ws.on('message', (frame: unknown) => {
      void this.handleFrame(frame).catch((err) =>
        this.ctx.logger.warn(`[im-channel-wecom:${this.id}] handleFrame failed: ${String(err)}`),
      )
    })

    ws.connect()
    this.ctx.logger.info(`[im-channel-wecom:${this.id}] 正在连接企业微信长连接…`)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.active = false
    this.streams.clear()
    this.lastFrames.clear()
    const ws = this.client
    this.client = null
    this.sdk = null
    if (ws) {
      try {
        ws.disconnect()
      } catch (err) {
        this.ctx.logger.warn(`[im-channel-wecom:${this.id}] disconnect failed: ${String(err)}`)
      }
    }
    this.setStatus('offline')
  }

  // ── Inbound ──

  /** 解析某群的生效配置。优先级：具体群 > `groups['*']` > 账号默认。 */
  private resolveGroupConfig(chatId: string): ResolvedGroupConfig {
    const wildcard = this.groups['*'] ?? {}
    const specific = this.groups[chatId] ?? {}
    const pick = <K extends keyof GroupConfig>(
      key: K,
      fallback: NonNullable<GroupConfig[K]>,
    ): NonNullable<GroupConfig[K]> =>
      (specific[key] ?? wildcard[key] ?? fallback) as NonNullable<GroupConfig[K]>
    return {
      requireMention: pick('requireMention', false),
      ignoreOtherMentions: pick('ignoreOtherMentions', false),
      toolPolicy: pick('toolPolicy', 'full'),
      name: pick('name', ''),
      prompt: pick('prompt', ''),
    }
  }

  /** 群是否被允许（groupPolicy 门禁）。 */
  private isGroupAllowed(chatId: string): boolean {
    if (this.groupPolicy === 'disabled') return false
    if (this.groupPolicy === 'allowlist') {
      if (this.groupAllowFrom.length === 0) return false
      const key = chatId.toLowerCase()
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

  private async handleFrame(raw: unknown): Promise<void> {
    const frame = raw as WecomFrame | undefined
    const body = frame?.body
    if (!frame?.headers?.req_id || !body) return

    const sender = body.from?.userid ?? ''
    const isGroup = body.chattype === 'group'
    // 群聊取 chatid，单聊取 userid —— 企业微信单聊回调不返回 chatid。
    const targetId = isGroup ? (body.chatid ?? '') : sender
    if (!sender || !targetId) return

    // ── 去重（重连会重放回调）──
    const msgId = body.msgid ?? frame.headers.req_id
    const now = Date.now()
    for (const [k, ts] of this.seenMsgIds) {
      if (now - ts > DEDUP_TTL_MS) this.seenMsgIds.delete(k)
    }
    if (this.seenMsgIds.has(msgId)) return
    this.seenMsgIds.set(msgId, now)

    const conversationId = `${isGroup ? 'group' : 'single'}:${targetId}`

    // ── 群策略门禁 ──
    let hint = ''
    if (isGroup) {
      if (!this.isGroupAllowed(targetId)) {
        this.ctx.logger.debug(
          `[im-channel-wecom:${this.id}] group ${targetId} blocked (groupPolicy=${this.groupPolicy})`,
        )
        return
      }
      hint = this.buildGroupHint(this.resolveGroupConfig(targetId))
    }

    const { text: body0, images } = await this.parseInbound(body)
    // 群聊内容形如 "@RobotA hello" —— 平台侧只投递 @机器人 的消息，开头这个
    // @占位符不是用户想表达的正文，剥掉（仅群聊、仅开头一次）。
    const bodyText = isGroup ? body0.replace(/^@\S+\s+/, '').trim() : body0
    if (!bodyText && images.length === 0) return
    const text = hint ? (bodyText ? `${hint}\n${bodyText}` : hint) : bodyText

    // 缓存入站帧：既是流式的建流锚点，也是出站兜底目标。
    this.lastFrames.set(conversationId, { frame, targetId })

    const message: ImInboundMessage = {
      channelId: this.id,
      conversationId,
      userId: sender,
      text,
      images: images.length ? images : undefined,
      isGroup,
      messageId: msgId,
    }
    void this.deliver(message).catch((err) =>
      this.ctx.logger.error(`[im-channel-wecom:${this.id}] handleInbound failed`, err),
    )
  }

  /** 按 msgtype 解析入站内容 → { 文本, 图片 }。 */
  private async parseInbound(body: WecomInboundBody): Promise<{ text: string; images: ImImage[] }> {
    const images: ImImage[] = []
    let text = ''
    switch (body.msgtype) {
      case 'text':
        text = body.text?.content ?? ''
        break
      case 'voice':
        // 官方已把语音转成文本再回调（仅单聊）。
        text = body.voice?.content ?? ''
        break
      case 'mixed': {
        const items = body.mixed?.msg_item ?? []
        const lines: string[] = []
        for (const item of items) {
          const type = String(item?.msgtype ?? '')
          if (type === 'text') {
            lines.push(String(item?.text?.content ?? ''))
          } else if (type === 'image') {
            const img = await this.downloadImage(item?.image)
            if (img) images.push(img)
            else lines.push('[图片]')
          }
        }
        text = lines.join('\n').trim()
        break
      }
      case 'image': {
        const img = await this.downloadImage(body.image)
        if (img) images.push(img)
        else text = '[图片]'
        break
      }
      case 'file':
        text = '[文件]'
        break
      case 'video':
        text = '[视频]'
        break
      default:
        text = `[${body.msgtype || '未知'}消息]`
        break
    }
    return { text: text.trim(), images }
  }

  /**
   * 下载入站图片 → base64（agent 视觉输入）。
   * 长连接模式下图片带 `url` + `aeskey`，SDK 的 downloadFile 内部做 AES-256-CBC
   * 解密；URL 官方仅 5 分钟有效，故必须即时下载。
   */
  private async downloadImage(image: { url?: string; aeskey?: string } | undefined): Promise<ImImage | null> {
    const client = this.client
    const url = image?.url
    const aeskey = image?.aeskey
    if (!client || !url || !aeskey) return null
    try {
      const res = await client.downloadFile(url, aeskey)
      const buf = res?.buffer
      if (!buf || buf.length === 0) return null
      if (buf.length > MAX_INBOUND_MEDIA_BYTES) {
        this.ctx.logger.warn(
          `[im-channel-wecom:${this.id}] inbound image too large (${buf.length} bytes) — skipped`,
        )
        return null
      }
      return { mediaType: sniffImageMime(buf), data: buf.toString('base64') }
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-wecom:${this.id}] image download failed: ${String(err)}`)
      return null
    }
  }

  // ── Outbound ──

  /** conversationId → 出站目标 id（单聊=userid，群聊=chatid）。 */
  private targetIdOf(conversationId: string): string {
    const cached = this.lastFrames.get(conversationId)?.targetId
    if (cached) return cached
    const i = conversationId.indexOf(':')
    if (i < 0) return ''
    const scope = conversationId.slice(0, i)
    if (scope !== 'single' && scope !== 'group') return ''
    return conversationId.slice(i + 1)
  }

  /** 主动推送一条 Markdown（免回调帧）。 */
  private async sendMarkdown(targetId: string, content: string): Promise<void> {
    const client = this.client
    if (!client) return
    await client.sendMessage(targetId, { msgtype: 'markdown', markdown: { content } })
  }

  async sendText(conversationId: string, text: string, options?: SendTextOptions): Promise<void> {
    const targetId = this.targetIdOf(conversationId)
    if (!this.client || !targetId) {
      this.ctx.logger.warn(`[im-channel-wecom:${this.id}] invalid send target: ${conversationId}`)
      return
    }
    // 出站清洗：剥离 system-reminder / thinking 等脚手架内容。
    const clean = options?.raw ? text : sanitizeOutboundText(text)
    const chunks = splitText(clean, WECOM_MAX_CHARS, 'zh')
    for (const chunk of chunks) {
      try {
        await this.sendMarkdown(targetId, chunk)
      } catch (err) {
        this.ctx.logger.warn(`[im-channel-wecom:${this.id}] sendText failed: ${String(err)}`)
        return
      }
    }
  }

  async sendImage(conversationId: string, image: ImImage): Promise<void> {
    await this.sendLocalMedia(conversationId, Buffer.from(image.data, 'base64'), 'image')
  }

  async sendMedia(conversationId: string, filePath: string, caption?: string): Promise<void> {
    if (caption) await this.sendText(conversationId, caption)
    const fs = await import('node:fs/promises')
    let buffer: Buffer
    try {
      buffer = await fs.readFile(filePath)
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-wecom:${this.id}] sendMedia read failed (${filePath}): ${String(err)}`)
      return
    }
    await this.sendLocalMedia(conversationId, buffer, mediaTypeFor(filePath))
  }

  /** 上传素材 → 主动发送媒体消息（企业微信不支持被动回复发文件，只能推送）。 */
  private async sendLocalMedia(
    conversationId: string,
    buffer: Buffer,
    mediaType: 'image' | 'voice' | 'video' | 'file',
  ): Promise<void> {
    const client = this.client
    const targetId = this.targetIdOf(conversationId)
    if (!client || !targetId) return
    try {
      const uploaded = await client.uploadMedia(buffer, { type: mediaType })
      const mediaId = uploaded?.media_id
      if (!mediaId) {
        this.ctx.logger.warn(`[im-channel-wecom:${this.id}] uploadMedia returned no media_id`)
        return
      }
      await client.sendMediaMessage(targetId, mediaType, mediaId)
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-wecom:${this.id}] sendMedia failed: ${String(err)}`)
    }
  }

  // ── 流式生命周期（beginStream / streamText / endStream）───────────────
  // 企业微信智能机器人原生支持流式气泡：首次用某个 stream.id 推送即建流，
  // 之后同 id 推送会**原位替换**整条消息（content 为全量，非增量），
  // finish=true 收尾。因此这里只需把网关传来的累积全文透传，并在最后一帧
  // 置 finish。约束：同一次回调的所有帧必须透传同一个 req_id（缓存的入站帧）；
  // 频控 30 条/分钟/会话（见 WECOM_STREAM_MIN_INTERVAL_MS）。
  //
  // 降级：无入站帧（例如网关主动调用）或建流失败 → 退回 sendText 一次性发送。

  async beginStream(conversationId: string): Promise<void> {
    const client = this.client
    const sdk = this.sdk
    const cached = this.lastFrames.get(conversationId)
    if (!client || !sdk || !cached) {
      this.streams.delete(conversationId)
      return
    }
    // 新回合：清掉上一轮残留（正常情况下网关每个回复周期只调一次）。
    this.streams.delete(conversationId)

    const streamId = sdk.generateReqId('stream')
    const state: WecomStreamState = {
      streamId,
      frame: cached.frame,
      targetId: cached.targetId,
      lastText: THINKING_PLACEHOLDER,
      lastPushAt: 0,
    }
    this.streams.set(conversationId, state)

    try {
      // 首帧必须尽快发出（官方要求 5 秒内回复回调），先占位再增量刷新。
      await client.replyStream(cached.frame, streamId, THINKING_PLACEHOLDER, false)
      state.lastPushAt = Date.now()
      this.ctx.logger.info(
        `[im-channel-wecom:${this.id}] beginStream: stream ${streamId} opened for ${conversationId}`,
      )
    } catch (err) {
      this.ctx.logger.warn(
        `[im-channel-wecom:${this.id}] beginStream failed for ${conversationId} (${String(err)}); falling back to text`,
      )
      this.streams.delete(conversationId)
    }
  }

  /**
   * 增量刷新流式气泡。`text` 是**累积全文**（网关 StreamThrottle 语义），
   * 与官方 stream.content 的全量语义一致，直接透传。
   */
  async streamText(conversationId: string, text: string): Promise<void> {
    const state = this.streams.get(conversationId)
    const client = this.client
    if (!state || !client) return
    // 频控：距上次推送过近则丢帧 —— 安全，因为下一帧自带累积全文。
    const now = Date.now()
    if (now - state.lastPushAt < WECOM_STREAM_MIN_INTERVAL_MS) return
    // 与 sendText 保持同一条出站清洗规则（剥离脚手架内容）。
    const clean = sanitizeOutboundText(text) || THINKING_PLACEHOLDER
    // 超长回复：流式期间只渲染能装下的部分，溢出由 endStream 分片补发。
    const { head } = takeByBytes(clean, WECOM_STREAM_MAX_BYTES)
    if (head === state.lastText) return
    try {
      await client.replyStream(state.frame, state.streamId, head, false)
      state.lastText = head
      state.lastPushAt = Date.now()
    } catch (err) {
      // 单帧失败不致命：后续帧自带全文；持续失败由 endStream 兜底。
      this.ctx.logger.warn(`[im-channel-wecom:${this.id}] streamText failed: ${String(err)}`)
    }
  }

  async endStream(conversationId: string, text: string): Promise<void> {
    const state = this.streams.get(conversationId)
    this.streams.delete(conversationId)
    const client = this.client

    // 没有可用流（未 begin / 建流失败）→ 走普通文本路径。
    if (!state || !client) {
      await this.sendText(conversationId, text)
      return
    }

    // 与 sendText 同规则清洗；空正文也要落一个终态，避免气泡永远停在「思考中」。
    const clean = sanitizeOutboundText(text) || THINKING_PLACEHOLDER
    const { head, rest } = takeByBytes(clean, WECOM_STREAM_MAX_BYTES)

    try {
      await client.replyStream(state.frame, state.streamId, head, true)
      this.ctx.logger.info(
        `[im-channel-wecom:${this.id}] endStream: stream ${state.streamId} finished for ${conversationId} (${head.length} chars)`,
      )
    } catch (err) {
      // 收尾失败 —— 正文绝不能丢，分片补发。
      this.ctx.logger.warn(
        `[im-channel-wecom:${this.id}] endStream finalize failed: ${String(err)}; falling back to text`,
      )
      await this.sendText(conversationId, text)
      return
    }

    // 气泡装不下的溢出部分：按网关分片规则主动推送。
    if (rest) {
      for (const chunk of splitText(rest, WECOM_MAX_CHARS, 'zh')) {
        await this.sendMarkdown(state.targetId, chunk).catch(() => undefined)
      }
    }
  }
}

/** Export the adapter class for the single-entry bundle to instantiate. */
export { WecomAdapter }
