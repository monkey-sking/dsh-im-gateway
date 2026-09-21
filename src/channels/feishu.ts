/**
 * Feishu / Lark channel adapter — implements ImChannelAdapter over the
 * official `@larksuiteoapi/node-sdk` WebSocket long-connection transport.
 *
 * 与钉钉/QQ 通道的能力对齐点：
 *   - 私聊 + 群聊（群聊按 groupPolicy / requireMention / ignoreOtherMentions
 *     门禁，并可注入群名/行为提示/工具策略软约束）；
 *   - 入站：text / post(富文本) / image / file / audio / media / sticker，
 *     图片走 messageResource 下载后以 base64 交给 agent 看；
 *   - 出站：文本（post + `tag:'md'` 原生 Markdown 渲染）、图片、文件，
 *     以及「检测回复中的本地路径并自动上传发送」；
 *   - 引用回复：首片挂在用户消息下方（`im.message.reply`），失败自动退化为
 *     主动推送；长回复其余分片走主动推送；
 *   - 流式输出：飞书没有原生 typing / 逐字气泡，走官方 CardKit 卡片
 *     （`card.create` + `cardElement.content` 增量 diff 播放打字机动画，
 *     见 feishu-card.ts）。建卡失败时降级为内置 `Typing` emoji reaction，
 *     保证任何情况下都有「处理中」反馈；
 *   - 出站文本统一清洗（剥离 system-reminder / thinking 等脚手架内容）。
 *
 * 连接：`EventDispatcher` + `WSClient.start()` 订阅 `im.message.receive_v1`，
 * **不需要公网回调地址**（对照参考项目 openclaw-lark）。
 */
import { Context } from '@deepseek-ai/cordis'
import { createReadStream, statSync } from 'node:fs'
import { Readable } from 'node:stream'
import { basename, extname } from 'node:path'
// 仅类型导入 —— 运行时用动态 import 懒加载（见 start()），与 qq / dingtalk
// 通道一致：飞书 SDK 体量大，未配置飞书通道的进程不该在启动时加载它。
import type * as Lark from '@larksuiteoapi/node-sdk'
import { splitText } from '../gateway/split'
import { sanitizeOutboundText } from '../gateway/sanitize'
import {
  FEISHU_STREAMING_ELEMENT_ID,
  buildFinalCard,
  buildStreamingCard,
  cardMessageContent,
  createCardEntity,
  isCardRateLimited,
  isCardTableLimit,
  setCardStreamingMode,
  streamCardContent,
  updateCardKitCard,
} from './feishu-card'
import type {
  ChannelStatus,
  FeishuChannelConfig,
  GroupConfig,
  GroupPolicy,
  ImChannelAdapter,
  ImImage,
  ImInboundMessage,
  SendTextOptions,
  ToolPolicy,
} from '../gateway/types'

/** 单条文本上限（码点）——与网关其它渠道保持一致，超出即分片。 */
const FEISHU_MAX_CHARS = 4000
/** 入站媒体单文件大小上限（字节）。 */
const MAX_INBOUND_MEDIA_BYTES = 20 * 1024 * 1024
/** 「处理中」表情：飞书内置 `Typing`（铅笔/键盘动画）。 */
const TYPING_EMOJI = 'Typing'
/** 卡片占位 / 降级提示文案（建卡成功到正文首帧之间显示）。 */
const THINKING_PLACEHOLDER = '⏳ 正在思考…'

/** 群工具策略 → 提示词约束（软约束：注入消息前缀，由模型遵守）。 */
const TOOL_POLICY_HINTS: Record<ToolPolicy, string> = {
  full: '',
  restricted: '本群仅可使用只读类工具（读取/查询/搜索），禁止写文件、删除、执行命令等修改性操作。',
  none: '本群禁止调用任何工具，仅用纯文本回答。',
}

/** open.feishu.cn / open.larksuite.com —— 作为 SDK domain 参数（接受 URL 字符串）。 */
const DOMAIN_FEISHU = 'https://open.feishu.cn'
const DOMAIN_LARK = 'https://open.larksuite.com'

/** 飞书 v2 事件体（im.message.receive_v1；EventDispatcher 已解包 header）。 */
interface FeishuMessageEvent {
  app_id?: string
  message?: {
    message_id?: string
    chat_id?: string
    /** 'p2p' | 'group' */
    chat_type?: string
    message_type?: string
    content?: string
    mentions?: Array<{
      key?: string
      name?: string
      id?: { open_id?: string; union_id?: string; user_id?: string }
    }>
    root_id?: string
    parent_id?: string
    thread_id?: string
    create_time?: string
  }
  sender?: {
    sender_id?: { open_id?: string; union_id?: string; user_id?: string }
    /** 'user' | 'bot'（部分版本为 'app'） */
    sender_type?: string
  }
}

/** 解析后的会话目标。 */
interface FeishuTarget {
  scope: 'p2p' | 'group'
  chatId: string
}

/**
 * 一次回复回合的流式状态。
 *
 * 卡片优先：`cardId` 非空即 CardKit 流式形态；建卡失败时为 null，此时
 * `reaction` 承载降级的「处理中」表情，正文在 endStream 一次性发出。
 */
interface FeishuStreamState {
  /** CardKit 卡片 id；null → 已降级为 emoji 形态。 */
  cardId: string | null
  /** 已发出的卡片消息 id（排查用；降级形态为空串）。 */
  cardMessageId: string
  /** CardKit 更新序列号，必须单调递增。 */
  sequence: number
  /** 上一次推给卡片的内容（相同则跳过，省一次 API 调用）。 */
  lastText: string
  /** 本轮入站消息 id —— 发卡片与挂表情共用的引用锚点。 */
  inboundMessageId: string
  /** 降级形态下挂在用户消息上的 Typing 表情。 */
  reaction: { messageId: string; reactionId: string } | null
}

/** 解析后的群配置（所有字段均已填充默认值）。 */
type ResolvedGroupConfig = Required<GroupConfig>

/** True when a path points at a local file (drive letter, /, ~, file://). */
function isLocalPath(raw: string): boolean {
  return (
    raw.startsWith('file://') ||
    /^[A-Za-z]:[\\/]/.test(raw) ||
    raw.startsWith('/') ||
    raw.startsWith('~')
  )
}

/** True when the path exists AND is a regular file. */
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

/** 本地文件 → 飞书上传所需的 file_type。 */
function fileTypeFor(path: string): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  switch (extname(path).toLowerCase()) {
    case '.opus':
    case '.ogg': return 'opus'
    case '.mp4': return 'mp4'
    case '.pdf': return 'pdf'
    case '.doc':
    case '.docx': return 'doc'
    case '.xls':
    case '.xlsx': return 'xls'
    case '.ppt':
    case '.pptx': return 'ppt'
    default: return 'stream'
  }
}

class FeishuAdapter implements ImChannelAdapter {
  /** 5-minute TTL —— 与其它渠道一致的去重窗口。 */
  private static readonly DEDUP_TTL_MS = 5 * 60 * 1000

  /** 单条消息字符上限（网关据此做非流式兜底分片）。 */
  readonly maxMessageChars = FEISHU_MAX_CHARS

  private readonly appId: string
  private readonly appSecret: string
  private readonly domain: string
  private readonly quoteReply: boolean
  private readonly groupPolicy: GroupPolicy
  private readonly groupAllowFrom: string[]
  private readonly defaultRequireMention: boolean
  private readonly groups: Record<string, GroupConfig>

  private client: Lark.Client | null = null
  private wsClient: Lark.WSClient | null = null
  /** 机器人自身 open_id —— 自环过滤与 @机器人 判定都依赖它。 */
  private botOpenId = ''
  private botName = ''
  private active = false
  private stopped = true
  /** peer(conversationId) → 最后一条入站 message_id（引用回复锚点）。 */
  private readonly lastMsgIds = new Map<string, string>()
  /** 已处理消息 id → 时间戳（WS 重连重放去重）。 */
  private readonly seenMsgIds = new Map<string, number>()
  /** conversationId → 本回合流式状态（CardKit 卡片，或降级的表情）。 */
  private readonly streams = new Map<string, FeishuStreamState>()
  /** 运行状态回调，由网关在注册时注入。 */
  statusListener?: (status: ChannelStatus) => void

  constructor(
    private readonly ctx: Context,
    config: FeishuChannelConfig,
    /** 实例 id（如 'feishu-main'）—— 注册表键。 */
    readonly id: string,
    /** 展示名（实例名或渠道类型名）。 */
    readonly label: string,
  ) {
    this.appId = config.appId ?? ''
    this.appSecret = config.clientSecret ?? ''
    this.domain = config.domain === 'lark' ? DOMAIN_LARK : DOMAIN_FEISHU
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
   * 把入站消息投递给网关。用 `ctx.get('imGateway')`（显式查找）而非属性访问，
   * 因为适配器的 ctx 不在 imGateway 的 inject 作用域内（详见 sync.ts 的说明）。
   */
  private deliver(msg: ImInboundMessage): Promise<void> {
    const gw = this.ctx.get('imGateway') as { handleInbound(m: ImInboundMessage): Promise<void> } | undefined
    return gw ? gw.handleInbound(msg) : Promise.resolve()
  }

  async start(): Promise<void> {
    if (!this.appId || !this.appSecret) {
      this.ctx.logger.warn(`[im-channel-feishu:${this.id}] credentials missing — bind via QR scan first`)
      this.setStatus('error', 'credentials missing — bind via QR scan first')
      return
    }
    this.stopped = false
    this.setStatus('offline')

    const lark = await import('@larksuiteoapi/node-sdk')
    const client = new lark.Client({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.domain,
    } as never)
    this.client = client

    // 先探明机器人身份：拿到 open_id 才能做自环过滤 / @机器人 判定。
    // 失败不阻断（长连接仍可建立，只是群里无法识别 @机器人）。
    await this.probeBot(client)

    const dispatcher = new lark.EventDispatcher({} as never)
    dispatcher.register({
      'im.message.receive_v1': (data: unknown) => this.handleEvent(data as FeishuMessageEvent),
    } as never)

    const ws = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      domain: this.domain,
    } as never)
    this.wsClient = ws

    // WSClient.start() 会一直 pending 直到连接关闭，故不能 await（会阻塞
    // applyConfig/启动流程）。SDK 内部自带断线重连，这里只上报一次在线状态。
    void Promise.resolve(ws.start({ eventDispatcher: dispatcher } as never))
      .then(() => {
        if (!this.stopped) this.setStatus('offline')
      })
      .catch((err) => {
        this.active = false
        const detail = err instanceof Error ? err.message : String(err)
        this.ctx.logger.warn(`[im-channel-feishu:${this.id}] WS start failed: ${detail}`)
        this.setStatus('error', `WS start failed: ${detail}`)
      })

    this.active = true
    this.setStatus('online')
    this.ctx.logger.info(
      `[im-channel-feishu:${this.id}] long-connection started (bot=${this.botName || this.botOpenId || 'unknown'})`,
    )
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.active = false
    this.streams.clear()
    const ws = this.wsClient
    this.wsClient = null
    this.client = null
    if (ws) {
      try {
        ws.close({ force: true })
      } catch (err) {
        this.ctx.logger.warn(`[im-channel-feishu:${this.id}] ws close failed: ${String(err)}`)
      }
    }
    this.setStatus('offline')
  }

  // ── Bot identity ──

  /** 通过标准端点 `/open-apis/bot/v3/info` 取机器人 open_id / 名称。 */
  private async probeBot(client: Lark.Client): Promise<void> {
    try {
      const res = (await client.request({
        method: 'POST',
        url: '/open-apis/bot/v3/info',
        data: {},
      })) as {
        bot?: { open_id?: string; app_name?: string }
        data?: { bot?: { open_id?: string; app_name?: string } }
        code?: number
        msg?: string
      }
      if (res?.code && res.code !== 0) {
        this.ctx.logger.warn(
          `[im-channel-feishu:${this.id}] bot info probe failed: ${res.code} ${res.msg ?? ''}`,
        )
        return
      }
      const bot = res?.bot ?? res?.data?.bot
      if (typeof bot?.open_id === 'string') this.botOpenId = bot.open_id
      if (typeof bot?.app_name === 'string') this.botName = bot.app_name
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-feishu:${this.id}] bot info probe error: ${String(err)}`)
    }
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
      requireMention: pick('requireMention', this.defaultRequireMention),
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

  private async handleEvent(data: FeishuMessageEvent): Promise<void> {
    try {
      const msg = data?.message
      const sender = data?.sender
      if (!msg?.message_id || !msg.chat_id) return
      // 事件归属校验：长连接可能同时挂着多个应用的订阅。
      if (data.app_id && this.appId && data.app_id !== this.appId) return

      const senderOpenId = sender?.sender_id?.open_id ?? ''
      // 自环 / 其它机器人消息一律丢弃，避免 bot 互刷。
      if (sender?.sender_type === 'bot' || sender?.sender_type === 'app') return
      if (this.botOpenId && senderOpenId === this.botOpenId) return

      // ── 去重（WS 重连会重放事件）──
      const now = Date.now()
      for (const [k, ts] of this.seenMsgIds) {
        if (now - ts > FeishuAdapter.DEDUP_TTL_MS) this.seenMsgIds.delete(k)
      }
      if (this.seenMsgIds.has(msg.message_id)) return
      this.seenMsgIds.set(msg.message_id, now)

      const isGroup = msg.chat_type === 'group'
      const chatId = msg.chat_id
      const conversationId = `${isGroup ? 'group' : 'p2p'}:${chatId}`
      const mentions = msg.mentions ?? []
      const atBot =
        Boolean(this.botOpenId) && mentions.some((m) => (m.id?.open_id ?? '') === this.botOpenId)

      // ── 群策略门禁 ──
      let hint = ''
      if (isGroup) {
        if (!this.isGroupAllowed(chatId)) {
          this.ctx.logger.debug(
            `[im-channel-feishu:${this.id}] group ${chatId} blocked (groupPolicy=${this.groupPolicy})`,
          )
          return
        }
        const gcfg = this.resolveGroupConfig(chatId)
        const otherMentions = mentions.filter(
          (m) => (m.id?.open_id ?? '') !== this.botOpenId && m.key !== '@_all',
        )
        if (!atBot && otherMentions.length > 0 && gcfg.ignoreOtherMentions) return
        if (gcfg.requireMention && !atBot) return
        hint = this.buildGroupHint(gcfg)
      }

      const { text: body, images } = await this.parseContent(msg.message_id, msg, mentions)
      if (!body && images.length === 0) return
      const text = hint ? (body ? `${hint}\n${body}` : hint) : body
      if (!text && images.length === 0) return

      this.lastMsgIds.set(conversationId, msg.message_id)
      const message: ImInboundMessage = {
        channelId: this.id,
        conversationId,
        userId: senderOpenId || chatId,
        text,
        images: images.length ? images : undefined,
        isGroup,
        messageId: msg.message_id,
      }
      void this.deliver(message).catch((err) =>
        this.ctx.logger.error(`[im-channel-feishu:${this.id}] handleInbound failed`, err),
      )
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-feishu:${this.id}] handleEvent failed: ${String(err)}`)
    }
  }

  /** 解析 JSON 内容（飞书 content 是 JSON 字符串）。 */
  private safeParse(raw: string | undefined): Record<string, unknown> | null {
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }

  /** 把 @占位符（`@_user_N`）还原成可读文本；@机器人 自身则直接移除。 */
  private resolveMentions(
    text: string,
    mentions: NonNullable<FeishuMessageEvent['message']>['mentions'],
  ): string {
    let out = text
    for (const m of mentions ?? []) {
      const key = m.key ?? ''
      if (!key) continue
      const isBot = Boolean(this.botOpenId) && (m.id?.open_id ?? '') === this.botOpenId
      out = out.split(key).join(isBot ? '' : `@${m.name ?? ''}`)
    }
    return out.replace(/@_all\s*/g, '@所有人 ').trim()
  }

  /** 按类型解析入站内容 → { 文本, 图片 }。 */
  private async parseContent(
    messageId: string,
    msg: NonNullable<FeishuMessageEvent['message']>,
    mentions: NonNullable<FeishuMessageEvent['message']>['mentions'],
  ): Promise<{ text: string; images: ImImage[] }> {
    const type = msg.message_type ?? ''
    const content = this.safeParse(msg.content)
    const images: ImImage[] = []
    let text = ''

    switch (type) {
      case 'text':
        text = this.resolveMentions(String(content?.text ?? ''), mentions)
        break
      case 'post': {
        text = this.convertPost(content, mentions)
        for (const key of this.postImageKeys(content)) {
          const img = await this.downloadImage(messageId, key)
          if (img) images.push(img)
        }
        if (!text && images.length === 0) text = '[富文本消息]'
        break
      }
      case 'image': {
        const key = String(content?.image_key ?? '')
        const img = key ? await this.downloadImage(messageId, key) : null
        if (img) images.push(img)
        else text = '[图片]'
        break
      }
      case 'file':
        text = `[文件: ${String(content?.file_name ?? '文件')}]`
        break
      case 'audio':
        text = '[语音消息]'
        break
      case 'media':
        text = '[视频]'
        break
      case 'sticker':
        text = '[表情]'
        break
      case 'interactive':
        text = '[卡片消息]'
        break
      default:
        text = `[${type || '未知'}消息]`
        break
    }
    return { text: text.trim(), images }
  }

  /** post（富文本）→ Markdown 文本。兼容 flat 与 locale 包装两种形态。 */
  private convertPost(
    content: Record<string, unknown> | null,
    mentions: NonNullable<FeishuMessageEvent['message']>['mentions'],
  ): string {
    const body = this.unwrapPostLocale(content)
    if (!body) return ''
    const lines: string[] = []
    if (typeof body.title === 'string' && body.title) lines.push(`**${body.title}**`)

    const v2 = Array.isArray(body.content_v2) ? (body.content_v2 as unknown[]) : null
    const blocks = v2 && v2.length > 0 ? v2 : (Array.isArray(body.content) ? (body.content as unknown[]) : [])

    for (const para of blocks) {
      if (!Array.isArray(para)) continue
      let line = ''
      for (const el of para as Array<Record<string, unknown>>) {
        switch (String(el?.tag ?? '')) {
          case 'text':
            line += String(el.text ?? '')
            break
          case 'a':
            line += el.href ? `[${String(el.text ?? el.href)}](${String(el.href)})` : String(el.text ?? '')
            break
          case 'at': {
            const uid = String(el.user_id ?? '')
            if (uid === 'all') line += '@所有人 '
            else {
              const hit = (mentions ?? []).find((m) => (m.id?.open_id ?? '') === uid)
              line += `@${hit?.name ?? String(el.user_name ?? uid)}`
            }
            break
          }
          case 'img':
            line += el.image_key ? `![image](${String(el.image_key)})` : '[图片]'
            break
          case 'media':
            line += '[媒体]'
            break
          case 'code_block':
            line += `\n\`\`\`${String(el.language ?? '')}\n${String(el.text ?? '')}\n\`\`\`\n`
            break
          case 'hr':
            line += '\n---\n'
            break
          case 'md':
            line += String(el.text ?? '')
            break
          default:
            line += String(el.text ?? '')
            break
        }
      }
      lines.push(line)
    }
    return this.resolveMentions(lines.join('\n').trim(), mentions)
  }

  /** 展开 post 的 locale 包装（`{ zh_cn: { title, content } }`）。 */
  private unwrapPostLocale(
    content: Record<string, unknown> | null,
  ): { title?: unknown; content?: unknown; content_v2?: unknown } | null {
    if (!content) return null
    if ('title' in content || 'content' in content || 'content_v2' in content) {
      return content as { title?: unknown; content?: unknown; content_v2?: unknown }
    }
    for (const locale of ['zh_cn', 'en_us', 'ja_jp']) {
      const inner = content[locale]
      if (inner && typeof inner === 'object') {
        return inner as { title?: unknown; content?: unknown; content_v2?: unknown }
      }
    }
    const first = Object.values(content)[0]
    if (first && typeof first === 'object') {
      return first as { title?: unknown; content?: unknown; content_v2?: unknown }
    }
    return null
  }

  /** 收集 post 里的所有图片 image_key。 */
  private postImageKeys(content: Record<string, unknown> | null): string[] {
    const body = this.unwrapPostLocale(content)
    if (!body) return []
    const v2 = Array.isArray(body.content_v2) ? (body.content_v2 as unknown[]) : null
    const blocks = v2 && v2.length > 0 ? v2 : (Array.isArray(body.content) ? (body.content as unknown[]) : [])
    const keys: string[] = []
    for (const para of blocks) {
      if (!Array.isArray(para)) continue
      for (const el of para as Array<Record<string, unknown>>) {
        if (String(el?.tag ?? '') === 'img' && el.image_key) keys.push(String(el.image_key))
      }
    }
    return keys
  }

  /** 下载入站图片 → base64（agent 视觉输入）。 */
  private async downloadImage(messageId: string, fileKey: string): Promise<ImImage | null> {
    const client = this.client
    if (!client) return null
    try {
      const res = await client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: 'image' },
      })
      const buf = await this.bufferFromResponse(res)
      if (!buf || buf.length === 0) return null
      if (buf.length > MAX_INBOUND_MEDIA_BYTES) {
        this.ctx.logger.warn(
          `[im-channel-feishu:${this.id}] inbound image too large (${buf.length} bytes) — skipped`,
        )
        return null
      }
      const mime = this.contentTypeFrom(res) ?? 'image/jpeg'
      return { mediaType: mime, data: buf.toString('base64') }
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-feishu:${this.id}] image download failed: ${String(err)}`)
      return null
    }
  }

  /** 从 SDK 响应里提取 Buffer（兼容 Buffer / ArrayBuffer / stream / writeFile 形态）。 */
  private async bufferFromResponse(res: unknown): Promise<Buffer | null> {
    if (res == null) return null
    if (Buffer.isBuffer(res)) return res
    if (res instanceof ArrayBuffer) return Buffer.from(res)
    const resp = res as Record<string, unknown>
    const data = resp.data
    if (Buffer.isBuffer(data)) return data
    if (data instanceof ArrayBuffer) return Buffer.from(data)
    if (data && typeof (data as { pipe?: unknown }).pipe === 'function') {
      return this.streamToBuffer(data as Readable)
    }
    if (typeof resp.getReadableStream === 'function') {
      const stream = await (resp.getReadableStream as () => Promise<Readable>)()
      return this.streamToBuffer(stream)
    }
    if (typeof data === 'string') return Buffer.from(data, 'binary')
    return null
  }

  /** 响应头里的 content-type。 */
  private contentTypeFrom(res: unknown): string | null {
    const resp = res as Record<string, unknown> | null
    const headers = resp?.headers as Record<string, unknown> | undefined
    const ct = headers?.['content-type'] ?? headers?.['Content-Type'] ?? resp?.contentType
    if (typeof ct !== 'string') return null
    const base = ct.split(';')[0].trim().toLowerCase()
    return base.startsWith('image/') ? base : null
  }

  /** Readable → Buffer。 */
  private async streamToBuffer(stream: Readable): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as ArrayBufferLike))
    }
    return Buffer.concat(chunks)
  }

  // ── Outbound ──

  private parseTarget(conversationId: string): FeishuTarget | null {
    const i = conversationId.indexOf(':')
    if (i < 0) return null
    const scope = conversationId.slice(0, i)
    const chatId = conversationId.slice(i + 1)
    if ((scope !== 'p2p' && scope !== 'group') || !chatId) return null
    return { scope, chatId }
  }

  /** 发一条 post 消息（`tag:'md'` → 原生 Markdown 渲染）。 */
  private async sendPost(
    client: Lark.Client,
    target: FeishuTarget,
    text: string,
    replyToMessageId?: string,
  ): Promise<void> {
    const content = JSON.stringify({ zh_cn: { content: [[{ tag: 'md', text }]] } })
    if (replyToMessageId) {
      try {
        await client.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content, msg_type: 'post' },
        })
        return
      } catch (err) {
        // 引用失败（被动回复窗口过期 / message_id 失效）→ 退化为主动推送。
        this.ctx.logger.warn(
          `[im-channel-feishu:${this.id}] quote reply failed, retrying as push: ${String(err)}`,
        )
      }
    }
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: target.chatId, msg_type: 'post', content },
    })
  }

  /** 发一条媒体消息（image / file）。 */
  private async sendMediaMessage(
    client: Lark.Client,
    target: FeishuTarget,
    msgType: 'image' | 'file',
    content: string,
    replyToMessageId?: string,
  ): Promise<void> {
    if (replyToMessageId) {
      try {
        await client.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content, msg_type: msgType },
        })
        return
      } catch (err) {
        this.ctx.logger.warn(
          `[im-channel-feishu:${this.id}] media quote reply failed, retrying as push: ${String(err)}`,
        )
      }
    }
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: target.chatId, msg_type: msgType, content },
    })
  }

  async sendText(conversationId: string, text: string, options?: SendTextOptions): Promise<void> {
    const client = this.client
    const target = this.parseTarget(conversationId)
    if (!client || !target) {
      this.ctx.logger.warn(`[im-channel-feishu:${this.id}] invalid send target: ${conversationId}`)
      return
    }
    // 出站清洗：剥离 system-reminder / thinking 等脚手架内容。
    const clean = options?.raw ? text : sanitizeOutboundText(text)
    const enriched = await this.sendMediaForText(target, conversationId, clean)
    const chunks = splitText(enriched, this.maxMessageChars ?? FEISHU_MAX_CHARS, 'zh')
    const anchor =
      options?.replyToId ?? (this.quoteReply ? this.lastMsgIds.get(conversationId) : undefined)
    for (let i = 0; i < chunks.length; i++) {
      // 只让首片引用用户消息，其余分片主动推送（避免一条 inbound 触发多条引用回复）。
      await this.sendPost(client, target, chunks[i], i === 0 ? anchor : undefined)
    }
  }

  async sendImage(conversationId: string, image: ImImage): Promise<void> {
    const client = this.client
    const target = this.parseTarget(conversationId)
    if (!client || !target) return
    try {
      const key = await this.uploadImage(client, Buffer.from(image.data, 'base64'))
      if (!key) return
      await this.sendMediaMessage(
        client,
        target,
        'image',
        JSON.stringify({ image_key: key }),
        this.quoteReply ? this.lastMsgIds.get(conversationId) : undefined,
      )
    } catch (err) {
      this.ctx.logger.warn(`[im-channel-feishu:${this.id}] sendImage failed: ${String(err)}`)
    }
  }

  async sendMedia(conversationId: string, filePath: string, caption?: string): Promise<void> {
    const client = this.client
    const target = this.parseTarget(conversationId)
    if (!client || !target) return
    if (!isRegularFile(filePath)) {
      this.ctx.logger.warn(`[im-channel-feishu:${this.id}] sendMedia: not a regular file: ${filePath}`)
      return
    }
    if (caption) await this.sendText(conversationId, caption)
    await this.sendLocalMedia(client, target, filePath, conversationId)
  }

  /** 上传本地文件并发出（图片走 image 通道，其余走 file）。 */
  private async sendLocalMedia(
    client: Lark.Client,
    target: FeishuTarget,
    filePath: string,
    conversationId?: string,
  ): Promise<boolean> {
    try {
      const isImage = /\.(png|jpe?g|gif|bmp|webp)$/i.test(filePath)
      const anchor =
        conversationId && this.quoteReply ? this.lastMsgIds.get(conversationId) : undefined
      if (isImage) {
        const key = await this.uploadImage(client, filePath)
        if (!key) return false
        await this.sendMediaMessage(client, target, 'image', JSON.stringify({ image_key: key }), anchor)
        return true
      }
      const key = await this.uploadFile(client, filePath)
      if (!key) return false
      await this.sendMediaMessage(client, target, 'file', JSON.stringify({ file_key: key }), anchor)
      return true
    } catch (err) {
      this.ctx.logger.warn(
        `[im-channel-feishu:${this.id}] media send failed (${filePath}): ${String(err)}`,
      )
      return false
    }
  }

  /** 上传图片 → image_key。`source` 可以是 Buffer 或本地路径。 */
  private async uploadImage(client: Lark.Client, source: Buffer | string): Promise<string | null> {
    const stream = Buffer.isBuffer(source) ? Readable.from(source) : createReadStream(source)
    const res = (await client.im.image.create({
      data: { image_type: 'message', image: stream as never },
    })) as { data?: { image_key?: string }; image_key?: string }
    const key = res?.data?.image_key ?? res?.image_key
    if (!key) {
      this.ctx.logger.warn(`[im-channel-feishu:${this.id}] image upload returned no image_key`)
      return null
    }
    return key
  }

  /** 上传文件 → file_key。 */
  private async uploadFile(client: Lark.Client, filePath: string): Promise<string | null> {
    const res = (await client.im.file.create({
      data: {
        file_type: fileTypeFor(filePath),
        file_name: basename(filePath),
        file: createReadStream(filePath) as never,
      },
    } as never)) as { data?: { file_key?: string }; file_key?: string }
    const key = res?.data?.file_key ?? res?.file_key
    if (!key) {
      this.ctx.logger.warn(`[im-channel-feishu:${this.id}] file upload returned no file_key`)
      return null
    }
    return key
  }

  /**
   * 检测回复文本里的本地图片/文件路径，逐个上传发送，并把引用替换为简短说明。
   */
  private async sendMediaForText(
    target: FeishuTarget,
    conversationId: string,
    text: string,
  ): Promise<string> {
    const client = this.client
    if (!client) return text
    let result = text
    // 1. markdown 图片语法：![alt](<local path>)
    for (const m of text.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)) {
      const [full, alt, p] = m
      if (!isLocalPath(p)) continue
      const filePath = toLocalPath(p)
      if (!isRegularFile(filePath)) continue
      await this.sendLocalMedia(client, target, filePath, conversationId)
      result = result.replace(full, alt ? `[${alt}]` : '[图片]')
    }
    // 2. 裸露的绝对路径（且确实存在于磁盘）。
    const bareFile =
      /(?:file:\/\/)?[A-Za-z]:[\\/][^\s"'()<>]+|(?:\/(?:Users|home|tmp|var|private|root)\/[^\s"'()<>]+)/g
    for (const m of result.matchAll(bareFile)) {
      const filePath = toLocalPath(m[0])
      if (!isRegularFile(filePath)) continue
      const ok = await this.sendLocalMedia(client, target, filePath, conversationId)
      if (ok) {
        const isImg = /\.(png|jpe?g|gif|bmp|webp)$/i.test(filePath)
        result = result.replace(m[0], isImg ? '[图片]' : `[文件已发送：${basename(filePath)}]`)
      }
    }
    return result
  }

  // ── 流式生命周期（beginStream / streamText / endStream）───────────────
  // 飞书没有原生 typing / 逐字气泡，唯一能做出「打字机」效果的是官方
  // CardKit 卡片：建卡实体 → 发引用卡片消息 → `cardElement.content` 反复
  // 更新同一元素，飞书自行 diff 并播放增量动画。
  //
  // 降级链（任何一环失败都不许丢正文）：
  //   建卡失败（最常见：应用未开通 `cardkit:card:write`）→ emoji reaction 占位
  //   → endStream 走 sendText 一次性发送。
  //   卡片更新撞表格上限（230099/11310）→ 放弃卡片并给它一个干净终态，
  //   正文改走 sendText。

  /** 发一条卡片消息（优先引用用户消息，失败退化为主动推送）。返回 message_id。 */
  private async sendCardMessage(
    client: Lark.Client,
    target: FeishuTarget,
    cardId: string,
    replyToMessageId?: string,
  ): Promise<string> {
    const content = cardMessageContent(cardId)
    if (replyToMessageId) {
      try {
        const res = (await client.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content, msg_type: 'interactive' },
        })) as { data?: { message_id?: string } }
        return res?.data?.message_id ?? ''
      } catch (err) {
        // 引用失败（被动回复窗口过期 / message_id 失效）→ 退化为主动推送。
        this.ctx.logger.warn(
          `[im-channel-feishu:${this.id}] card quote reply failed, retrying as push: ${String(err)}`,
        )
      }
    }
    const res = (await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: target.chatId, msg_type: 'interactive', content },
    })) as { data?: { message_id?: string } }
    return res?.data?.message_id ?? ''
  }

  /** 降级路径：给用户消息挂一个内置 `Typing` 表情（尽力而为）。 */
  private async addTypingReaction(client: Lark.Client, state: FeishuStreamState): Promise<void> {
    if (!state.inboundMessageId) return
    try {
      const res = (await client.im.messageReaction.create({
        path: { message_id: state.inboundMessageId },
        data: { reaction_type: { emoji_type: TYPING_EMOJI } },
      })) as { data?: { reaction_id?: string } }
      const reactionId = res?.data?.reaction_id
      if (reactionId) state.reaction = { messageId: state.inboundMessageId, reactionId }
    } catch (err) {
      // 表情只是尽力而为的视觉提示，失败不能影响回合。
      this.ctx.logger.debug(
        `[im-channel-feishu:${this.id}] add typing reaction failed: ${String(err)}`,
      )
    }
  }

  /** 撤掉降级表情（无论成败都清空状态，避免重复删除）。 */
  private async removeTypingReaction(client: Lark.Client, state: FeishuStreamState): Promise<void> {
    const reaction = state.reaction
    state.reaction = null
    if (!reaction) return
    try {
      await client.im.messageReaction.delete({
        path: { message_id: reaction.messageId, reaction_id: reaction.reactionId },
      })
    } catch (err) {
      this.ctx.logger.debug(
        `[im-channel-feishu:${this.id}] remove typing reaction failed: ${String(err)}`,
      )
    }
  }

  /**
   * 放弃卡片（撞上飞书表格上限等不可恢复错误）：关掉流式模式并把卡片钉在
   * 一行提示上，避免留下一个永远「生成中」的气泡；正文由调用方改走文本。
   */
  private async abandonCard(client: Lark.Client, state: FeishuStreamState, notice: string): Promise<void> {
    const cardId = state.cardId
    state.cardId = null
    if (!cardId) return
    try {
      state.sequence += 1
      await setCardStreamingMode(client, cardId, false, state.sequence)
      state.sequence += 1
      await updateCardKitCard(client, cardId, buildFinalCard(notice), state.sequence)
    } catch (err) {
      this.ctx.logger.debug(
        `[im-channel-feishu:${this.id}] abandonCard cleanup failed: ${String(err)}`,
      )
    }
  }

  async beginStream(conversationId: string): Promise<void> {
    const client = this.client
    const target = this.parseTarget(conversationId)
    if (!client || !target) return
    // 新回合：清掉上一轮残留（正常情况下网关每个回复周期只调一次）。
    this.streams.delete(conversationId)

    const inboundMessageId = this.lastMsgIds.get(conversationId) ?? ''
    const state: FeishuStreamState = {
      cardId: null,
      cardMessageId: '',
      sequence: 0,
      lastText: '',
      inboundMessageId,
      reaction: null,
    }
    this.streams.set(conversationId, state)

    try {
      const cardId = await createCardEntity(client, buildStreamingCard(THINKING_PLACEHOLDER))
      if (cardId) {
        const messageId = await this.sendCardMessage(
          client,
          target,
          cardId,
          this.quoteReply ? inboundMessageId || undefined : undefined,
        )
        if (messageId) {
          // 消息真正发出去之后才认领卡片 —— 否则会更新一张没人看得到的卡。
          state.cardId = cardId
          state.cardMessageId = messageId
          state.lastText = THINKING_PLACEHOLDER
          this.ctx.logger.info(
            `[im-channel-feishu:${this.id}] beginStream: card ${cardId} delivered for ${conversationId}`,
          )
          return
        }
      }
    } catch (err) {
      this.ctx.logger.warn(
        `[im-channel-feishu:${this.id}] beginStream: CardKit unavailable for ${conversationId} (${String(err)}); falling back to typing reaction — 请确认应用已开通 cardkit:card:write 权限`,
      )
    }
    // 降级：卡片不可用（最常见原因是缺 cardkit:card:write 权限）。
    await this.addTypingReaction(client, state)
  }

  /**
   * 增量刷新卡片正文。`text` 是**累积全文**（网关 StreamThrottle 语义），
   * 直接交给 CardKit 做 diff；本方法只负责编号递增与失败分类。
   */
  async streamText(conversationId: string, text: string): Promise<void> {
    const state = this.streams.get(conversationId)
    const client = this.client
    if (!state?.cardId || !client) return
    // 与 sendText 保持同一条出站清洗规则（剥离脚手架内容）。
    const clean = sanitizeOutboundText(text) || THINKING_PLACEHOLDER
    // 超长回复：流式期间只渲染首段（与 endStream 的终态口径一致），溢出部分
    // 由 endStream 分片补发。否则每一帧都要推一份超长内容，极易触发卡片更新失败。
    const content = clean.length > FEISHU_MAX_CHARS ? clean.slice(0, FEISHU_MAX_CHARS) : clean
    if (content === state.lastText) return
    const cardId = state.cardId
    state.sequence += 1
    try {
      await streamCardContent(client, cardId, FEISHU_STREAMING_ELEMENT_ID, content, state.sequence)
      state.lastText = content
    } catch (err) {
      // 表格数量超卡片上限：后续每帧都会失败，直接放弃卡片改走文本。
      if (isCardTableLimit(err)) {
        this.ctx.logger.warn(
          `[im-channel-feishu:${this.id}] card table limit hit (${String(err)}); disabling CardKit streaming for ${conversationId}`,
        )
        await this.abandonCard(client, state, '⚠️ 内容含过多表格，无法在卡片中渲染，完整内容见下方消息。')
        return
      }
      // 更新过快：丢掉这一帧即可，下一帧自带累积全文。
      if (isCardRateLimited(err)) return
      this.ctx.logger.warn(
        `[im-channel-feishu:${this.id}] streamText failed: ${String(err)}`,
      )
    }
  }

  async endStream(conversationId: string, text: string): Promise<void> {
    const state = this.streams.get(conversationId)
    this.streams.delete(conversationId)
    const client = this.client
    const target = this.parseTarget(conversationId)

    // 没有可用卡片（未 begin / 建卡失败 / 中途放弃）→ 删表情 + 原有文本路径。
    if (!state?.cardId || !client || !target) {
      if (state && client) await this.removeTypingReaction(client, state)
      await this.sendText(conversationId, text)
      return
    }

    const cardId = state.cardId
    // 与 sendText 同规则：本地文件路径真发出去，正文里留占位符。
    const clean = await this.sendMediaForText(target, conversationId, sanitizeOutboundText(text))
    // 卡片装不下超长回复：卡片收首段，其余按网关分片规则主动推送。
    const overflow = clean.length > FEISHU_MAX_CHARS
    const head = overflow
      ? `${clean.slice(0, FEISHU_MAX_CHARS)}\n\n…（内容过长，其余部分见下方消息）`
      : clean
    const rest = overflow ? clean.slice(FEISHU_MAX_CHARS) : ''

    try {
      state.sequence += 1
      await setCardStreamingMode(client, cardId, false, state.sequence)
      state.sequence += 1
      await updateCardKitCard(
        client,
        cardId,
        buildFinalCard(head || THINKING_PLACEHOLDER),
        state.sequence,
      )
      this.ctx.logger.info(
        `[im-channel-feishu:${this.id}] endStream: card ${cardId} finalized for ${conversationId} (${head.length} chars)`,
      )
    } catch (err) {
      // 收尾失败 —— 正文绝不能丢，按已清洗好的文本分片补发。
      this.ctx.logger.warn(
        `[im-channel-feishu:${this.id}] endStream finalize failed: ${String(err)}; falling back to text`,
      )
      const anchor = this.quoteReply ? state.inboundMessageId || undefined : undefined
      const chunks = splitText(clean, FEISHU_MAX_CHARS, 'zh')
      for (let i = 0; i < chunks.length; i++) {
        await this.sendPost(client, target, chunks[i], i === 0 ? anchor : undefined).catch(
          () => undefined,
        )
      }
      return
    }

    if (rest) {
      for (const chunk of splitText(rest, FEISHU_MAX_CHARS, 'zh')) {
        await this.sendPost(client, target, chunk).catch(() => undefined)
      }
    }
  }
}

/** Export the adapter class for the single-entry bundle to instantiate. */
export { FeishuAdapter }
