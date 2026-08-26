import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentHandle, AgentSetup, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {
  ChannelStatus,
  ImChannelAdapter,
  ImGateway,
  ImGatewayConfig,
  ImInboundMessage,
} from './types'
import { ApprovalBroker } from './approval'
import { QuestionBroker, formatQuestionPrompt, formatAnswerSummary } from './questions'

import { SessionMerger } from './merge'
import { StreamThrottle } from './stream'
import { CommandHandler } from './commands'
import type { GatewayHandle } from './commands'
import { EventDispatcher } from './events'
import { createTranslator, type Translator, breakChars } from './i18n'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionAnswer, AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
// 引入 dsh-user-approval / dsh-user-questions 的模块增强（让 ctx.on('approval/request') 和 ctx.userQuestions 类型可用）
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// cordis reads `export const Config` as this plugin's config schema.
// Single-entry bundle: the gateway core + every channel instance live in ONE
// namespace (`im-gateway`), with `channels` as an ARRAY of instances — the
// same channel type may appear many times (multi-bot support, mirroring
// pi-desk-top's channel-instance model).
export const Config = Schema.object({
  cwd: Schema.string().default(process.cwd()),
  streamThrottleMs: Schema.number().default(800),
  slashCommands: Schema.boolean().default(true),
  approvalTimeoutSecs: Schema.number().default(120),
  questionTimeoutSecs: Schema.number().default(600),
  allowAllUsers: Schema.boolean().default(false),
  allowedUserIds: Schema.dict(Schema.array(Schema.string())).default({}),
  mergeTimeoutSecs: Schema.number().default(3),

  channels: Schema.array(
    Schema.object({
      id: Schema.string().required(),
      type: Schema.union(['dingtalk', 'qq', 'weixin']),
      name: Schema.string().default(''),
      enabled: Schema.boolean().default(false),
      // Loose merged credential schema: all channel types' fields are
      // optional at the schema level; the runtime adapter reads only the
      // keys its own type needs (see createAdapter in src/index.ts).
      config: Schema.object({
        // dingtalk
        clientId: Schema.string().default(''),
        clientSecret: Schema.string().role('secret').default(''),
        callbackBaseUrl: Schema.string().default(''),
        // qq
        appId: Schema.string().default(''),
        botAppId: Schema.string().default(''),
        // weixin (iLink weixin)
        baseUrl: Schema.string().default(''),
        token: Schema.string().role('secret').default(''),
        botId: Schema.string().default(''),
        cdnBaseUrl: Schema.string().default(''),
        pollIntervalMs: Schema.number().default(3000),
      }).default({}),
    }),
  ).default([]),
})

/**
 * Core IM gateway service.
 *
 * Responsibilities (ported from pi-desk-top/src/main/im/im-gateway.ts):
 *  - channel registry (`registerChannel`)
 *  - conversation → host session mapping
 *  - per-conversation serial queue (one agent turn at a time)
 *  - slash-command handling (/help, /reset, /clear)
 *  - agent-event → channel reply routing (streaming, tool notifications, flush)
 *
 * ─────────────────────────────────────────────────────────────────────────
 * HOST API CONTRACT (verified against deepseek-harness source):
 *  - Sessions:  `ctx.sessions` is the `SessionStore` (from @deepseek-ai/dsh-session).
 *               `create(id, { meta: { cwd } })` builds an event-sourced Session.
 *               The Session object has NO `.prompt()` / `.on()` — it is a log.
 *  - Agents:    `ctx.agents` is the `AgentRegistry` (from @deepseek-ai/dsh-agent).
 *               `get(sessionId)` → Agent | undefined; `createAgent(ownerCtx, opts)`
 *               starts the agent loop on a session. Drive a turn with
 *               `agent.followup(userMessage)` (see host/apiproxy/src/api-proxy.ts:2461).
 *  - Events:    subscribe at the CONTEXT level: `ctx.on('session/event', (session, event) => …)`.
 *               Typed events (packages/core/session/src/types.ts):
 *                 'turn/start'        { turn }
 *                 'assistant/chunk'   { turn, step, chunk: StreamChunk }  // chunk.type==='text-delta' → text
 *                 'assistant/message' { turn, step, message: AssistantMessage }
 *                 'tool/call'         { turn, step, callId, name, arguments }
 *                 'turn/end'          { turn, reason }
 * ─────────────────────────────────────────────────────────────────────────
 */
export class ImGatewayService extends Service implements ImGateway {
  static inject = ['agents', 'agentPresets']

  private readonly channels = new Map<string, ImChannelAdapter>()
  private readonly convToSession = new Map<string, SessionId>() // convKey → sessionId
  private readonly sessionToConv = new Map<string, string>() // sessionId → convKey
  /** Deduplicate concurrent ensureSession calls for the same conversation. */
  private readonly sessionCreations = new Map<string, Promise<SessionId>>()
  private readonly serialQueues = new Map<string, Promise<void>>()


  private readonly agentHandles = new Map<string, AgentHandle>()
  /** Per-session model-selection ref (so /model can switch without re-injecting). */
  private readonly modelRefs = new Map<string, ModelSelectionRef>()
  /** Per-session model override captured from /model (absent → fall back to globalModelOverride). */
  private readonly modelOverrides = new Map<string, { provider: string; model: string; reasoningEffort?: string }>()
  /**
   * Default model when there is no session override AND no /cwd-provided default.
   * Set by /model <name> issued BEFORE the first message of a conversation
   * (i.e. session not yet created). Survives across conversations until cleared.
   */
  private globalModelOverride?: { provider: string; model: string; reasoningEffort?: string }

  /** 设置全局默认模型覆盖（CommandHandler 通过 GatewayHandle 调用）。 */
  setGlobalModelOverride(v: { provider: string; model: string; reasoningEffort?: string } | undefined): void {
    this.globalModelOverride = v
  }

  /** 每会话工作区偏好（convKey → workspace path），由 /workspace 命令设置。 */
  private readonly workspaces = new Map<string, string>()

  /** 每会话 generation 计数器（/new 递增，使 sessionId 变化以避免 resume 旧会话）。 */
  private readonly sessionGenerations = new Map<string, number>()

  /** /new 时用 Date.now() 作为 generation，确保 sessionId 唯一，避免 resume 旧会话。 */
  bumpSessionGeneration(convKey: string): void {
    this.sessionGenerations.set(convKey, Date.now())
  }

  /** 当前会话的工作区偏好（无则返回 undefined，调用方回退到 config.cwd）。 */
  workspaceOf(convKey: string): string | undefined {
    return this.workspaces.get(convKey)
  }

  /** 设置会话工作区偏好，持久化到 workspaces.json。 */
  setWorkspace(convKey: string, path: string): void {
    this.workspaces.set(convKey, path)
    this.persistWorkspaces()
  }

  /** 工作区偏好持久化文件路径。 */
  private workspaceStorePath(): string {
    const stateDir = join(homedir(), '.dsh', 'im-gateway')
    return join(stateDir, 'workspaces.json')
  }

  /** 加载持久化的工作区偏好（启动时调用）。 */
  private loadWorkspaces(): void {
    try {
      const raw = readFileSync(this.workspaceStorePath(), 'utf8')
      const entries = JSON.parse(raw) as Array<[string, string]>
      if (Array.isArray(entries)) {
        for (const [key, path] of entries) {
          if (typeof key === 'string' && typeof path === 'string') {
            this.workspaces.set(key, path)
          }
        }
      }
    } catch { /* file not found or invalid — start fresh */ }
  }

  /** 持久化工作区偏好到 workspaces.json。 */
  private persistWorkspaces(): void {
    try {
      const stateDir = join(homedir(), '.dsh', 'im-gateway')
      mkdirSync(stateDir, { recursive: true })
      const entries = [...this.workspaces.entries()]
      writeFileSync(this.workspaceStorePath(), JSON.stringify(entries, null, 2))
    } catch (err) {
      this.ctx.logger.warn(`[im-gateway] 工作区偏好持久化失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  /** Live channel runtime status, surfaced to the settings UI via getChannelStatuses. */
  private readonly channelStatuses = new Map<string, ChannelStatus>()
  /** 审批桥：挂起 approval/request，等待 IM 侧「批准/拒绝」答复。 */
  private readonly approvalBroker = new ApprovalBroker()
  /** 提问桥：挂起 ask_user_question，等待 IM 侧回复选项编号/文字。 */
  private readonly questionBroker = new QuestionBroker()
  /** UI 批准的渠道白名单用户（重启后需重新灌入）。 */
  private readonly extraAllowlist = new Map<string, Set<string>>()
  /** 多段输入合并器：用户连续发多条消息时合并为一条。 */
  private merger?: SessionMerger
  /** 工具卸载句柄（im_send_file 等）。 */
  private readonly disposeTools: Array<() => void> = []
  /** 流式节流器：攒批 text-delta 后按间隔推送渠道。 */
  private streamThrottle?: StreamThrottle
  /** Slash 命令处理器。 */
  private commandHandler?: CommandHandler
  /** 事件分发器：把 dsh SessionEvent 翻译为 IM 渠道操作。 */
  private eventDispatcher?: EventDispatcher
  /** 翻译器（中/英文）。 */
  private t: Translator = createTranslator('zh')
  /** 恢复 ctx.userQuestions.ask 原始实现（卸载时调用）。 */
  private restoreUserQuestionsAsk?: () => void
  private unsubSessionEvent?: () => void
  private unsubLocaleChange?: () => void
  private unsubApproval?: () => void
  private active = false

  constructor(ctx: Context, private readonly config: ImGatewayConfig) {
    super(ctx, 'imGateway')
  }

  // ── public API (for channel plugins) ───────────────────────────────────

  registerChannel(adapter: ImChannelAdapter): void {
    if (this.channels.has(adapter.id)) {
      this.ctx.logger.warn(`[im-gateway] channel "${adapter.id}" re-registered; replacing.`)
    }
    this.channels.set(adapter.id, adapter)
    // Hook the adapter's status sink so we can surface online/offline/error
    // in the settings UI (ChannelStatus broadcast).
    adapter.statusListener = (status) => this.setChannelStatus(adapter.id, status)
    if (this.active) {
      void Promise.resolve(adapter.start()).catch((err) =>
        this.ctx.logger.error(`[im-gateway] channel "${adapter.id}" start failed`, err),
      )
    }
  }

  getChannel(id: string): ImChannelAdapter | undefined {
    return this.channels.get(id)
  }

  listChannels(): string[] {
    return [...this.channels.keys()]
  }

  /**
   * Stop every channel and clear the registry. Used by config reload
   * (mirrors the reference project's applyConfig → stopAll): after a save
   * the caller re-creates adapters from the new settings and re-registers.
   */
  async stopAll(): Promise<void> {
    const adapters = [...this.channels.values()]
    this.channels.clear()
    this.channelStatuses.clear()
    for (const adapter of adapters) {
      try {
        await adapter.stop()
      } catch (err) {
        this.ctx.logger.error(`[im-gateway] stop channel "${adapter.id}" failed`, err)
      }
    }
  }

  /** Snapshot of every channel's runtime status for the settings UI. */
  getChannelStatuses(): Record<string, ChannelStatus> {
    const out: Record<string, ChannelStatus> = {}
    for (const [id, status] of this.channelStatuses) out[id] = status
    return out
  }

  /** Record a channel's runtime status and log meaningful transitions. */
  private setChannelStatus(id: string, status: ChannelStatus): void {
    const prev = this.channelStatuses.get(id)?.status
    this.channelStatuses.set(id, { ...status, lastChange: Date.now() })
    if (prev !== status.status) {
      if (status.status === 'error') {
        this.ctx.logger.warn(`[im-gateway] channel "${id}" → error: ${status.error ?? 'unknown'}`)
      } else {
        this.ctx.logger.info(`[im-gateway] channel "${id}" → ${status.status}`)
      }
    }
  }

  // ── lifecycle ──────────────────────────────────────────────────────────
  //
  // cordis runs a Service plugin's `[Service.init]` (symbol method) after
  // construction — a plain `start()` is NEVER called. The generator shape
  // (yield a cleanup fn, then the init body) mirrors the official pattern
  // (dsh-settings: `async *[Service.init]()`).

  async *[Service.init](): AsyncGenerator<void, void, void> {
    // Cleanup runs when the service/plugin unloads (the old stop() body).
    yield async () => {
      this.active = false
      this.unsubSessionEvent?.()
      this.unsubSessionEvent = undefined
      this.unsubLocaleChange?.()
      this.unsubLocaleChange = undefined
      this.unsubApproval?.()
      this.unsubApproval = undefined
      this.approvalBroker.dispose()
      this.restoreUserQuestionsAsk?.()
      this.restoreUserQuestionsAsk = undefined
      this.questionBroker.dispose()
      this.merger?.dispose()
      this.merger = undefined
      for (const dispose of this.disposeTools) dispose()
      this.disposeTools.length = 0
      this.streamThrottle?.dispose()
      this.streamThrottle = undefined
      this.eventDispatcher = undefined
      for (const adapter of this.channels.values()) {
        try {
          await adapter.stop()
        } catch (err) {
          this.ctx.logger.error(`[im-gateway] stop channel "${adapter.id}" failed`, err)
        }
      }
      // Tear down the agent + session we own for each IM conversation.
      for (const [, handle] of this.agentHandles) {
        await handle.dispose().catch((err) => this.ctx.logger.warn('[im-gateway] agent dispose failed', err))
      }
      this.agentHandles.clear()
      this.convToSession.clear()
      this.sessionToConv.clear()
    }

    this.active = true
    this.loadWorkspaces()
    this.streamThrottle = new StreamThrottle(this.config.streamThrottleMs)
    this.t = createTranslator(this.resolveLang())
    this.questionBroker.t = this.t
    const self = this
    this.eventDispatcher = new EventDispatcher({
      ctx: this.ctx,
      get t() { return self.t },
      sessionToConv: this.sessionToConv,
      streamThrottle: this.streamThrottle,
      channelForConv: (convKey: string) => this.channelForConv(convKey),
    })
    this.commandHandler = new CommandHandler(this as GatewayHandle)
    // 监听全局语言切换（dsh 设置 → 通用设置 → 语言）
    this.unsubLocaleChange = this.ctx.root.on('settings/updated', (ns, next) => {
      if (ns !== settingsNamespace('locale')) return
      const lang = (next as { preference?: 'zh' | 'en' })?.preference ?? 'zh'
      this.t = createTranslator(lang)
      this.questionBroker.t = this.t
    })
    // Subscribe on the ROOT context: cordis dispatches events only on the
    // ctx that emitted them (no parent/child propagation), and session events
    // are emitted on the root context by the session service. A subscription
    // on this plugin's child ctx would silently receive NOTHING.
    this.unsubSessionEvent = this.ctx.root.on('session/event', (session, event) =>
      this.eventDispatcher!.dispatch(session, event),
    )
    // 审批桥：approval/request waterfall → 推送到会话所在 chat → 回复「批准/拒绝」→ 返回 verdict
    this.unsubApproval = this.ctx.root.on('approval/request', async (req, next) =>
      this.handleApprovalRequest(req, next),
    )
    // 提问桥：包装 ctx.userQuestions.ask，让 IM 侧也能回答 ask_user_question
    this.installQuestionBridge()
    // 多段输入合并器：超时回调里注入合并后的文本
    this.merger = new SessionMerger({
      mergeTimeoutMs: this.config.mergeTimeoutSecs * 1000,
      onFlush: (convKey, text) => this.onMergeFlush(convKey, text),
    })
    // 注册 im_send_file 工具：agent 可把工作区文件发给当前 IM 聊天
    this.registerSendFileTool()
    for (const adapter of this.channels.values()) {
      try {
        await adapter.start()
      } catch (err) {
        this.ctx.logger.error(`[im-gateway] start channel "${adapter.id}" failed`, err)
      }
    }
    this.ctx.logger.info(`[im-gateway] active; channels: ${this.listChannels().join(', ') || '(none)'}`)
  }

  // ── inbound → agent ────────────────────────────────────────────────────

  async handleInbound(message: ImInboundMessage): Promise<void> {
    const channel = this.channels.get(message.channelId)
    if (!channel) {
      this.ctx.logger.warn(`[im-gateway] inbound from unknown channel "${message.channelId}"`)
      return
    }
    if (channel.onInbound) {
      const handled = await channel.onInbound(message)
      if (handled) return
    }
    if (this.config.slashCommands && message.text.trimStart().startsWith('/')) {
      try {
        const handled = await this.commandHandler!.handle(channel, message)
        if (handled) return
      } catch (err) {
        // NEVER swallow slash-command failures: a broken command must reply
        // with a visible error instead of silently dying (that silent path
        // cost us hours on the /model `.catch()` bug). Send back to the same
        // conversation so the user at least sees something.
        const convKey = `${message.channelId}:${message.conversationId}`
        const convId = convOf(convKey)
        const detail = err instanceof Error ? err.message : String(err)
        this.ctx.logger.error(`[im-gateway] slash command failed: ${detail}`, err)
        await channel.sendText(convId, this.t.t('gw.cmd.failed', detail)).catch(() => undefined)
        return
      }
    }

    // 审批答复检测：用户回复「批准/拒绝」时消费 pending 审批，不转发给 agent
    const verdictText = message.text.trim().toLowerCase()
    const approveKw = this.t.t('gw.auth.approve').toLowerCase()
    const agreeKw = this.t.t('gw.auth.agree').toLowerCase()
    const rejectKw = this.t.t('gw.auth.reject').toLowerCase()
    if (verdictText === approveKw || verdictText === agreeKw || verdictText === 'yes' || verdictText === 'y' || verdictText === 'allow') {
      const handled = await this.answerApproval(channel, message, true)
      if (handled) return
    }
    if (verdictText === rejectKw || verdictText === 'no' || verdictText === 'n' || verdictText === 'reject' || verdictText === 'deny') {
      const handled = await this.answerApproval(channel, message, false)
      if (handled) return
    }

    // 提问答复检测：有 pending 提问时尝试解析为答案，不转发给 agent
    if (await this.answerQuestion(channel, message)) return


    const convKey = `${message.channelId}:${message.conversationId}`

    // 多段输入合并：用户连续发多条消息时合并为一条再提交给 agent
    const mergeResult = this.merger?.ingest(convKey, message.text)
    if (mergeResult && mergeResult.kind === 'flushed' && mergeResult.text) {
      const sessionId = await this.ensureSession(convKey)
      const parts = toContentBlocks({ ...message, text: mergeResult.text })
      // Serialize turns per conversation so a fast second message waits for the first.
      const prev = this.serialQueues.get(convKey) ?? Promise.resolve()
      const next = prev.then(() => this.runTurn(sessionId, convKey, channel, parts))
      this.serialQueues.set(convKey, next.catch(() => undefined))
    }
    // buffered / ignored: 等待后续消息或超时
  }

  /** 合并窗口超时回调：把合并后的文本注入 agent。 */
  private async onMergeFlush(convKey: string, text: string): Promise<void> {
    const channel = this.channelForConv(convKey)
    if (!channel) return
    try {
      const sessionId = await this.ensureSession(convKey)
      const parts: ContentBlock[] = [{ type: 'text', text }]
      const prev = this.serialQueues.get(convKey) ?? Promise.resolve()
      const next = prev.then(() => this.runTurn(sessionId, convKey, channel, parts))
      this.serialQueues.set(convKey, next.catch(() => undefined))
    } catch (err) {
      this.ctx.logger.error(`[im-gateway] merge flush failed for ${convKey}`, err)
    }
  }

  private async ensureSession(convKey: string): Promise<SessionId> {
    const existing = this.convToSession.get(convKey)
    if (existing) return existing

    // Deduplicate concurrent inbounds for the same conversation (two messages
    // can arrive before the first session finishes materializing). Mirrors
    // dsh-host-apiproxy's `sessionCreations` map.
    let creation = this.sessionCreations.get(convKey)
    if (creation === undefined) {
      creation = this.ensureSessionInner(convKey)
      this.sessionCreations.set(convKey, creation)
      void creation
        .finally(() => this.sessionCreations.delete(convKey))
        .catch(() => undefined)
    }
    return creation
  }

  /**
   * Resolve an IM conversation to a live agent session, following the OFFICIAL
   * dsh pattern (dsh-host-apiproxy/src/api-proxy.ts `ensureSession`):
   *
   *   1. A live agent with this id already exists → reuse it.
   *   2. A persisted log exists on disk (from a previous run) → `agents.resume`
   *      the SAME id. This is the crux: IM conversations are long-lived (the
   *      DingTalk conversationId is stable across restarts), so the session id
   *      MUST be stable too. `agents.create` on a stored id would reject with
   *      "id collision" because the fresh seed does not reproduce the stored
   *      log; `agents.resume` replays the stored log AS the seed and keeps the
   *      conversation history. A random per-boot suffix would dodge the
   *      collision but silently throw history away — do NOT do that.
   *   3. Neither → genuinely new conversation: `agents.create`.
   */
  private async ensureSessionInner(convKey: string): Promise<SessionId> {
    const generation = this.sessionGenerations.get(convKey) ?? 0
    const sessionId = SessionId(generation === 0 ? `im:${convKey}` : `im:${convKey}:${generation}`)
    const wsPref = this.workspaceOf(convKey)
    console.log(`[im-gateway] ensureSession: convKey=${convKey} gen=${generation} sessionId=${sessionId} wsPref=${wsPref ?? '(none)'}`)

    // 1) Live agent already exists (defensive; same-process reuse).
    const live = this.ctx.agents.get(sessionId)
    if (live) {
      console.log(`[im-gateway] ensureSession: branch 1 (live reuse)`)
      this.convToSession.set(convKey, sessionId)
      this.sessionToConv.set(sessionId, convKey)
      return sessionId
    }

    // 2) Stored log exists → resume (keeps history, avoids id collision).
    const persistence = this.ctx.get('sessionPersistence') as
      | { list(): Promise<Array<{ id: SessionId }>> }
      | undefined
    if (persistence) {
      const stored = (await persistence.list()).find((header) => header.id === sessionId)
      if (stored) {
        console.log(`[im-gateway] ensureSession: branch 2 (resume from persistence)`)
        const handle = await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: this.currentModelFor(sessionId),
          setup: this.presetSetup(sessionId),
        })
        this.agentHandles.set(sessionId, handle)
        this.convToSession.set(convKey, sessionId)
        this.sessionToConv.set(sessionId, convKey)
        this.ctx.logger.info(`[im-gateway] resumed session ${sessionId} (history kept)`)
        await this.attachToWorkspace(sessionId, wsPref ?? this.config.cwd)
        return sessionId
      }
    }


    // 3) Genuinely new conversation → create. ctx.agents.create() mints BOTH
    // the session and the agent loop under this shared identity
    // (CreateAgentOptions contract) — do NOT pre-create the session via
    // ctx.sessions.create, or it throws "session already exists".
    //
    // Defensive fallback: if a persisted log for this id exists but the
    // `list()` check above missed it (backend not yet loaded, timing, or a
    // stale process), create() rejects with an id collision. In that case
    // fall back to resume() so a stable IM conversation is never lost and the
    // user never sees a bare "id collision".
    console.log(`[im-gateway] ensureSession: branch 3 (create new)`)
    let handle: AgentHandle
    const effectiveCwd = wsPref ?? this.config.cwd
    console.log(`[im-gateway] ensureSession: effectiveCwd="${effectiveCwd}"`)
    try {
      handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: effectiveCwd },
        agentOptions: this.currentModelFor(sessionId),
        setup: this.presetSetup(sessionId),
      })
    } catch (err) {
      if (isIdCollision(err)) {
        console.log(`[im-gateway] ensureSession: id collision, falling back to resume`)
        handle = await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: this.currentModelFor(sessionId),
          setup: this.presetSetup(sessionId),
        })
      } else {
        throw err
      }
    }

    this.agentHandles.set(sessionId, handle)

    this.convToSession.set(convKey, sessionId)
    this.sessionToConv.set(sessionId, convKey)
    console.log(`[im-gateway] ensureSession: session created, calling attachToWorkspace`)
    await this.attachToWorkspace(sessionId, effectiveCwd)
    console.log(`[im-gateway] ensureSession: done for ${sessionId}`)
    return sessionId
  }

  /**
   * Associate an IM session with the workspace whose canonical path matches its
   * cwd, so the session shows up under the correct project group in the web
   * sidebar instead of the "Ungrouped" bucket.
   *
   * dsh groups the sidebar by Host Workspace: sessions created through the UI
   * attach to a workspace via `session.create(workspaceId)`. Our bare
   * `agents.create({ meta: { cwd } })` only stamps the header cwd — it does NOT
   * enter any workspace's `sessionIds` account, so the session is "stray" and
   * lands in the Ungrouped group (workspace auto-bootstrap only runs once on
   * first init, before our IM sessions exist). Explicitly resolving the cwd's
   * workspace (creating it if the user never opened it) and attaching is the
   * official path (workspaceRegistry.attachSession).
   *
   * Best-effort: workspace grouping must never block or fail an IM turn.
   */
  private async attachToWorkspace(sessionId: SessionId, cwd?: string): Promise<void> {
    try {
      const workspaceRegistry = this.ctx.get('workspaceRegistry') as
        | {
            create(path: string): Promise<{ attachSession(id: SessionId): Promise<void> }>
            list(): Array<{ path: string; sessionIds: string[] }>
          }
        | undefined
      if (!workspaceRegistry) {
        console.warn(`[im-gateway] workspaceRegistry unavailable; session ${sessionId} will be ungrouped`)
        return
      }
      const effectiveCwd = cwd ?? this.config.cwd
      console.log(`[im-gateway] attachToWorkspace: sessionId=${sessionId} cwd="${effectiveCwd}"`)

      // 备份 workspace.json 的 sessionIds（attachSession 中 mutate 会过滤掉 sessionPath 不匹配的旧会话）
      const beforeIds = this.readWorkspaceSessionIds(effectiveCwd)

      const workspace = await workspaceRegistry.create(effectiveCwd)
      await workspace.attachSession(sessionId)
      console.log(`[im-gateway] attachToWorkspace: attachSession succeeded`)

      // 恢复被 mutate 移除的旧会话（直接写 workspace.json，绕过 mutate 的过滤）
      const afterIds = this.readWorkspaceSessionIds(effectiveCwd)
      const removed = beforeIds.filter((id) => !afterIds.includes(id) && id !== String(sessionId))
      if (removed.length > 0) {
        console.log(`[im-gateway] attachToWorkspace: restoring ${removed.length} sessions removed by mutate: ${JSON.stringify(removed)}`)
        this.restoreWorkspaceSessionIds(effectiveCwd, removed)
      }
    } catch (err) {
      console.warn(`[im-gateway] workspace attach failed for ${sessionId}:`, err instanceof Error ? err.message : String(err))
    }
  }

  /** 读取 workspace.json 中指定 path 的 sessionIds。 */
  private readWorkspaceSessionIds(cwd: string): string[] {
    try {
      const file = join(homedir(), '.dsh', 'storages', 'workspace.json')
      const raw = readFileSync(file, 'utf8')
      const data = JSON.parse(raw) as { tables?: { workspaces?: Record<string, { path?: string; sessionIds?: string[] }> } }
      for (const w of Object.values(data.tables?.workspaces ?? {})) {
        if (w.path === cwd) return w.sessionIds ?? []
      }
    } catch { /* ignore */ }
    return []
  }

  /** 把被移除的 sessionIds 写回 workspace.json（直接写文件，不经过 mutate）。 */
  private restoreWorkspaceSessionIds(cwd: string, ids: string[]): void {
    try {
      const file = join(homedir(), '.dsh', 'storages', 'workspace.json')
      const raw = readFileSync(file, 'utf8')
      const data = JSON.parse(raw) as { tables?: { workspaces?: Record<string, { path?: string; sessionIds?: string[]; createdAt?: string; updatedAt?: string }> } }
      for (const w of Object.values(data.tables?.workspaces ?? {})) {
        if (w.path === cwd && w.sessionIds) {
          for (const id of ids) {
            if (!w.sessionIds.includes(id)) w.sessionIds.push(id)
          }
        }
      }
      const tmp = `${file}.tmp`
      writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
      renameSync(tmp, file)
    } catch (err) {
      console.warn(`[im-gateway] restoreWorkspaceSessionIds failed:`, err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * 诊断：全面记录 workspace 状态。
   * - workspace.json 原始 sessionIds（session-cleaner 用这个判断 active）
   * - workspaceRegistry.list() 投影后 sessionIds（桌面端 UI 用这个显示）
   * - ctx.sessions.list() live sessions（dispose 后会消失）
   * - sessionPersistence.list() 持久化会话（dispose 后仍存在）
   * 如果原始 ≠ 投影，说明 sessionPath 不匹配（会话从 UI 消失但 session-cleaner 仍认为 active）。
   */
  logWorkspaceState(label: string): void {
    try {
      const file = join(homedir(), '.dsh', 'storages', 'workspace.json')
      const raw = readFileSync(file, 'utf8')
      const data = JSON.parse(raw) as { tables?: { workspaces?: Record<string, { path?: string; sessionIds?: string[] }> } }
      const workspaces = data.tables?.workspaces ?? {}
      console.log(`[im-gateway] ${label} ── workspace.json raw sessionIds:`)
      for (const [id, w] of Object.entries(workspaces)) {
        console.log(`[im-gateway]   "${w.path}" → ${JSON.stringify(w.sessionIds)}`)
      }
    } catch { /* ignore */ }

    try {
      const workspaceRegistry = this.ctx.get('workspaceRegistry') as
        | { list(): Array<{ path: string; sessionIds: string[] }> }
        | undefined
      if (workspaceRegistry) {
        const list = workspaceRegistry.list()
        console.log(`[im-gateway] ${label} ── workspaceRegistry.list() projected sessionIds:`)
        for (const ws of list) {
          console.log(`[im-gateway]   "${ws.path}" → ${JSON.stringify(ws.sessionIds)}`)
        }
      }
    } catch { /* ignore */ }

    try {
      const sessions = this.ctx.get('sessions') as
        | { list(): Array<{ id: SessionId; header?: { cwd?: string } }> }
        | undefined
      if (sessions) {
        const live = sessions.list()
        console.log(`[im-gateway] ${label} ── live sessions (${live.length}):`)
        for (const s of live) {
          console.log(`[im-gateway]   ${s.id} cwd="${s.header?.cwd ?? '?'}"`)
        }
      }
    } catch { /* ignore */ }
  }

  /** Compute the initial model selection for a session (override → global → deployment default). */
  currentModelFor(sessionId: SessionId): { provider?: string; model?: string; reasoningEffort?: string } | undefined {
    const override = this.modelOverrides.get(sessionId) ?? this.globalModelOverride
    if (override) return override
    const defaults = this.ctx.get('agentDefaultModel') as
      | { currentSelection(): { provider?: string; model?: string; reasoningEffort?: string } | undefined }
      | undefined
    return defaults?.currentSelection()
  }

  /**
   * Agent setup callback: mount the 'standard' preset (tools, prompt sections,
   * skills) and install model selection into the agent's prompt assembly.
   * Called by agents.create/agents.resume BEFORE the agent is published, so
   * the first prompt assembly has all tools and {{provider}}/{{model}} variables.
   */
  presetSetup(sessionId: SessionId): AgentSetup {
    const gateway = this
    return async (agentCtx: Context) => {
      const presets = gateway.ctx.get('agentPresets') as
        | { mount(agentCtx: Context, id?: string): Promise<unknown> }
        | undefined
      if (presets) {
        await presets.mount(agentCtx, 'standard')
      } else {
        console.warn('[im-gateway] agentPresets not available, agent will have no tools')
      }
      gateway.installModelSelection(agentCtx, sessionId)
    }
  }

  /**
   * Wire the agent-default-model selection into one agent's prompt assembly
   * (mirrors dsh-host-apiproxy selectionFor). Listeners live on the agent's
   * scoped ctx and are torn down with it.
   *
   * The `current` getter returns this session's /model override when set,
   * otherwise the deployment default (`agentDefaultModel`). The setter records
   * an override — that is exactly how the official `session.selectModel`
   * switches the model for one conversation. We keep the ref alive in
   * `modelRefs` so `/model` can mutate `current` on the same object the prompt
   * assembly reads.
   */
  private installModelSelection(agentCtx: Context, sessionId: SessionId): void {
    const gateway = this
    const defaults = this.ctx.get('agentDefaultModel') as
      | { currentSelection(): { provider?: string; model?: string; reasoningEffort?: string } | undefined }
      | undefined
    const ref: ModelSelectionRef = {
      get current(): ModelSelection | undefined {
        const override = gateway.modelOverrides.get(sessionId) ?? gateway.globalModelOverride
        const base = defaults?.currentSelection() as ModelSelection | undefined
        return override ?? base ?? undefined
      },
      set current(next) {
        if (next) {
          gateway.modelOverrides.set(sessionId, {
            provider: next.provider,
            model: next.model,
            ...next.reasoningEffort === undefined ? {} : { reasoningEffort: String(next.reasoningEffort) },
          })
        } else {
          gateway.modelOverrides.delete(sessionId)
        }
      },
      assembled: undefined,
    }
    installModelSelection(agentCtx, ref)
    this.modelRefs.set(sessionId, ref)
  }

  private async runTurn(
    sessionId: SessionId,
    convKey: string,
    channel: ImChannelAdapter,
    parts: ContentBlock[],
  ): Promise<void> {
    const convId = convOf(convKey)
    const agent = this.ctx.agents.get(sessionId)
    if (!agent) {
      this.ctx.logger.warn(`[im-gateway] no agent for session ${sessionId}`)
      await channel.sendText(convId, this.t.t('gw.session.notReady'))
      return
    }
    const userMessage: UserMessage = createUserMessage({ content: parts, source: { kind: 'user' } })
    try {
      // `followup` enqueues a user turn; the agent loop produces session events
      // that we receive via ctx.on('session/event').
      agent.followup(userMessage)
    } catch (err) {
      this.ctx.logger.error(`[im-gateway] followup failed for ${convKey}`, err)
      await channel.sendText(convId, this.t.t('gw.followup.failed'))
    }
  }

  /** 清理指定会话的事件状态（CommandHandler /reset 调用）。 */
  clearConversationState(convId: string): void {
    this.eventDispatcher?.disposeConversation(convId)
  }

  /**
   * 从 dsh 全局设置读取界面语言（locale.preference）。
   * 与「设置 → 通用设置 → 语言」联动；settings 不可用时回退中文。
   */
  private resolveLang(): 'zh' | 'en' {
    try {
      const settings = this.ctx.get('settings') as
        | { get(ns: unknown): { preference?: string } | undefined }
        | undefined
      if (!settings) return 'zh'
      const section = settings.get(settingsNamespace('locale'))
      const pref = section?.preference
      return pref === 'en' ? 'en' : 'zh'
    } catch {
      return 'zh'
    }
  }

  // ── im_send_file 工具 ────────────────────────────────────────────────

  /** 注册 im_send_file 工具：agent 把工作区文件发给当前 IM 会话的用户。 */
  private registerSendFileTool(): void {
    const tools = this.ctx.get('tools') as
      | {
          register(def: {
            name: string
            description: string
            parameters: Record<string, unknown>
            output: {
              schema: Record<string, unknown>
              render: (args: unknown, value: unknown) => unknown[]
            }
            execute: (args: unknown, exec: { agent?: { id: SessionId } }) => Promise<unknown>
          }): () => void
        }
      | undefined
    if (!tools?.register) return
    try {
      const disposer = tools.register({
        name: 'im_send_file',
        description:
          this.t.t('gw.sendFile.desc1') +
          this.t.t('gw.sendFile.desc2'),
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: this.t.t('gw.sendFile.pathDesc') },
            caption: { type: 'string', description: this.t.t('gw.sendFile.captionDesc') },
          },
          required: ['path'],
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              detail: { type: 'string' },
            },
            required: ['ok', 'detail'],
          },
          render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        execute: async (args, exec) => {
          const { path, caption } = args as { path: string; caption?: string }
          const sessionId = exec.agent?.id
          return this.sendFileToChat(path, caption, sessionId ? String(sessionId) : undefined)
        },
      })
      this.disposeTools.push(disposer)
    } catch (err) {
      this.ctx.logger.warn(`[im-gateway] im_send_file 工具注册失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** 把文件发送到会话关联的渠道（im_send_file 工具的执行体）。 */
  async sendFileToChat(
    filePath: string,
    caption?: string,
    sessionId?: string,
  ): Promise<{ ok: boolean; detail: string }> {
    if (!sessionId) {
      return { ok: false, detail: this.t.t('gw.sendFile.noSession') }
    }
    const convKey = this.sessionToConv.get(sessionId)
    if (!convKey) {
      return { ok: false, detail: this.t.t('gw.sendFile.noChat') }
    }
    const channel = this.channelForConv(convKey)
    if (!channel) {
      return { ok: false, detail: this.t.t('gw.sendFile.noChannel') }
    }
    const convId = convOf(convKey)
    try {
      if (caption) await channel.sendText(convId, caption).catch(() => undefined)
      if (channel.sendMedia) {
        await channel.sendMedia(convId, filePath, caption)
        return { ok: true, detail: this.t.t('gw.sendFile.sent', filePath) }
      }
      // 渠道不支持发送文件 → 降级为文本说明
      await channel.sendText(convId, this.t.t('gw.sendFile.fallbackText', filePath))
      return { ok: true, detail: this.t.t('gw.sendFile.fallbackDetail', filePath) }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      return { ok: false, detail: this.t.t('gw.sendFile.failed', detail) }
    }
  }

  // ── 审批桥 ────────────────────────────────────────────────────────────

  /**
   * 处理 approval/request 事件：把审批请求推送到绑定该会话的 IM chat，
   * 等待用户回复「批准/拒绝」。超时或无绑定 chat 时委托回下游（next()）。
   */
  private async handleApprovalRequest(
    req: { agent: { session: { id: string } }; toolName: string; reason?: string; signal?: AbortSignal },
    next: () => Promise<ApprovalOutcome>,
  ): Promise<ApprovalOutcome> {
    const sessionId = String(req.agent.session.id)
    const convKey = this.sessionToConv.get(sessionId)
    if (!convKey) return next() // 非 IM 会话 → 委托下游
    const channel = this.channelForConv(convKey)
    if (!channel) return next()
    const convId = convOf(convKey)
    const timeoutMs = this.config.approvalTimeoutSecs * 1000
    const text = [
      this.t.t('gw.approval.title', this.config.approvalTimeoutSecs),
      this.t.t('gw.approval.tool', req.toolName),
      req.reason ? this.t.t('gw.approval.reason', req.reason) : '',
      this.t.t('gw.approval.hint'),
    ].filter(Boolean).join('\n')

    await channel.sendText(convId, text).catch(() => undefined)
    const verdict = await this.approvalBroker.wait(sessionId, timeoutMs, req.signal)
    if (verdict === 'allow') return 'allowed-once'
    if (verdict === 'reject') return 'rejected'
    return next()
  }

  /** IM 侧答复审批。有 pending 则消费并回复确认，无 pending 返回 false。 */
  private async answerApproval(channel: ImChannelAdapter, message: ImInboundMessage, allow: boolean): Promise<boolean> {
    const convKey = `${message.channelId}:${message.conversationId}`
    const sessionId = this.convToSession.get(convKey)
    if (!sessionId) return false
    const answered = this.approvalBroker.answer(String(sessionId), allow)
    if (answered) {
      const convId = convOf(convKey)
      await channel.sendText(convId, allow ? this.t.t('gw.approval.approved') : this.t.t('gw.approval.rejected')).catch(() => undefined)
    }
    return answered
  }

  // ── 提问桥 ────────────────────────────────────────────────────────────

  /**
   * 包装 ctx.userQuestions.ask：当 agent 提问时，把问题推送到绑定该会话的 IM chat，
   * 与 Web 端竞速，第一答生效。无绑定 IM 会话时委托回原始 ask。
   */
  private installQuestionBridge(): void {
    const service = this.ctx.get('userQuestions') as
      | { ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> }
      | undefined
    if (!service?.ask) return

    const originalAsk = service.ask.bind(service)
    const gateway = this

    const wrappedAsk = async (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => {
      const sessionId = request.agent ? String(request.agent.session.id) : ''
      const convKey = sessionId ? gateway.sessionToConv.get(sessionId) : undefined
      if (!sessionId || !convKey) return originalAsk(request)

      const channel = gateway.channelForConv(convKey)
      if (!channel) return originalAsk(request)

      const convId = convOf(convKey)
      const timeoutSecs = Math.max(1, gateway.config.questionTimeoutSecs)
      const timeoutMs = timeoutSecs * 1000
      const webAbort = new AbortController()
      const forwardAbort = () => webAbort.abort(request.signal?.reason)
      request.signal?.addEventListener('abort', forwardAbort, { once: true })

      const imWait = gateway.questionBroker.wait(sessionId, request.questions, timeoutMs, request.signal)
      await channel
        .sendText(convId, formatQuestionPrompt(request.questions, timeoutSecs, this.t))
        .catch(() => undefined)
      gateway.ctx.logger.info(`[im-gateway] 提问已同步到 ${convKey}（${request.questions.length} 个问题）`)

      const webWait = originalAsk({ ...request, signal: webAbort.signal }).then(
        (answer) => ({ kind: 'web' as const, answer }),
        (error: unknown) => ({ kind: 'web-error' as const, error }),
      )

      const finishWeb = async (): Promise<AskUserQuestionAnswer> => {
        const web = await webWait
        if (web.kind === 'web-error') throw web.error
        gateway.questionBroker.finishFromWeb(sessionId, web.answer)
        await channel
          .sendText(convId, this.t.t('gw.question.answeredWeb', formatAnswerSummary(request.questions, web.answer)))
          .catch(() => undefined)
        return web.answer
      }

      try {
        const first = await Promise.race([webWait, imWait])
        if (first.kind === 'web') {
          gateway.questionBroker.finishFromWeb(sessionId, first.answer)
          await channel
            .sendText(convId, this.t.t('gw.question.answeredWeb', formatAnswerSummary(request.questions, first.answer)))
            .catch(() => undefined)
          return first.answer
        }
        if (first.kind === 'web-error') {
          gateway.questionBroker.cancel(sessionId)
          throw first.error
        }
        if (first.kind === 'answered') {
          webAbort.abort()
          void webWait
          await channel
            .sendText(
              convId,
              this.t.t('gw.question.answeredIM', formatAnswerSummary(request.questions, first.answer), first.source.label ?? first.source.channelId),
            )
            .catch(() => undefined)
          return first.answer
        }
        if (first.kind === 'external') return first.answer
        if (first.kind === 'timeout') {
          await channel.sendText(convId, this.t.t('gw.question.timeout')).catch(() => undefined)
        }
        // cancelled / busy / timeout：Web provider 仍是最终兜底
        return finishWeb()
      } finally {
        request.signal?.removeEventListener('abort', forwardAbort)
      }
    }

    service.ask = wrappedAsk
    this.restoreUserQuestionsAsk = () => {
      if (service.ask === wrappedAsk) service.ask = originalAsk
    }
  }

  /** IM 侧答复提问。有 pending 则尝试解析，成功/无效/已答过都消费（不转发 agent）。 */
  private async answerQuestion(channel: ImChannelAdapter, message: ImInboundMessage): Promise<boolean> {
    const convKey = `${message.channelId}:${message.conversationId}`
    const sessionId = this.convToSession.get(convKey)
    if (!sessionId) return false
    const sid = String(sessionId)
    const questions = this.questionBroker.questionsFor(sid)
    const result = this.questionBroker.answer(sid, message.text, {
      channelId: message.channelId,
      conversationId: message.conversationId,
      label: channel.label,
    })
    if (result.kind === 'not-pending') return false
    const convId = convOf(convKey)
    if (result.kind === 'invalid') {
      await channel.sendText(convId, this.t.t('gw.question.invalid', result.message)).catch(() => undefined)
      return true
    }
    if (result.kind === 'already-answered') {
      await channel.sendText(convId, `ℹ️ ${result.message}`).catch(() => undefined)
      return true
    }
    if (questions) {
      this.ctx.logger.info(`[im-gateway] 提问由 ${convKey} 回答：${formatAnswerSummary(questions, result.answer)}`)
    }
    return true
  }

  // ── 白名单 ────────────────────────────────────────────────────────────

  /** 检查用户是否在白名单中。渠道本地授权优先，其次全局白名单和 UI 批准。 */
  private authorized(channelId: string, userId?: string): boolean {
    if (this.config.allowAllUsers) return true
    if (!userId) return false
    const perChannel = this.config.allowedUserIds[channelId]
    if (perChannel && perChannel.includes(userId)) return true
    // 扁平兜底：keys 为 '*' 时按全局名单
    const global = this.config.allowedUserIds['*']
    if (global && global.includes(userId)) return true
    // UI 批准的渠道白名单
    const extra = this.extraAllowlist.get(channelId)
    if (extra && extra.has(userId)) return true
    return false
  }

  /** 添加 UI 批准的白名单用户（manager 同步调用；重启后需重新灌入）。 */
  addAuthorizedUser(channelId: string, userId: string): void {
    let set = this.extraAllowlist.get(channelId)
    if (!set) {
      set = new Set()
      this.extraAllowlist.set(channelId, set)
    }
    set.add(userId)
  }


  // ── helpers ────────────────────────────────────────────────────────────

  private channelForConv(convKey: string): ImChannelAdapter | undefined {
    const channelId = convKey.slice(0, convKey.indexOf(':'))
    return this.channels.get(channelId)
  }
}

/** convKey = `channelId:conversationId` → conversationId (supports ':' inside it). */
function convOf(convKey: string): string {
  return convKey.slice(convKey.indexOf(':') + 1)
}

/**
 * Build dsh ContentBlock[] from a normalized inbound message.
 *
 * PoC is TEXT-ONLY. Real multimodal requires registering raw bytes with the
 * `@deepseek-ai/dsh-attachment` service to obtain an `ImageAttachmentRef`
 * (the actual `ImageBlock` shape is `{ type: 'image'; attachment }`, NOT inline
 * base64). That is a tracked seam: inbound images currently arrive as the
 * "[图片]" text note the channel adapter emits. Wire `ctx.attachments` before
 * enabling vision.
 */
function toContentBlocks(message: ImInboundMessage): ContentBlock[] {
  const blocks: ContentBlock[] = []
  if (message.text) {
    // In group chats, attribute who spoke so the agent can tell members apart
    // (pi-desk-top prefixes the sender in multi-user conversations).
    const text = message.isGroup && message.senderNick ? `[@${message.senderNick}] ${message.text}` : message.text
    blocks.push({ type: 'text', text })
  }
  return blocks
}


/**
 * Whether an error is a session-persistence id collision. The persistence
 * coordinator throws several distinct collision messages; match on the
 * stable substring instead of the error class (which can be duplicated when a
 * dependency is inlined into the bundle).
 */
function isIdCollision(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return message.includes('id collision') || message.includes('already has a persisted log')
}
