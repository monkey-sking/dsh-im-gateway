import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {
  ChannelStatus,
  ImChannelAdapter,
  ImGateway,
  ImGatewayConfig,
  ImInboundMessage,
} from './types'

// cordis reads `export const Config` as this plugin's config schema.
// Single-entry bundle: the gateway core + every channel instance live in ONE
// namespace (`im-gateway`), with `channels` as an ARRAY of instances — the
// same channel type may appear many times (multi-bot support, mirroring
// pi-desk-top's channel-instance model).
export const Config = Schema.object({
  cwd: Schema.string().default(process.cwd()),
  streamThrottleMs: Schema.number().default(800),
  slashCommands: Schema.boolean().default(true),
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
  static inject = ['agents']

  private readonly channels = new Map<string, ImChannelAdapter>()
  private readonly convToSession = new Map<string, SessionId>() // convKey → sessionId
  private readonly sessionToConv = new Map<string, string>() // sessionId → convKey
  /** Deduplicate concurrent ensureSession calls for the same conversation. */
  private readonly sessionCreations = new Map<string, Promise<SessionId>>()
  private readonly serialQueues = new Map<string, Promise<void>>()
  private readonly pendingStream = new Map<string, { text: string; timer?: ReturnType<typeof setTimeout> }>()
  private readonly finalText = new Map<string, string>()
  /** Whether beginStream was already called for this conversation's reply cycle. */
  private readonly streamStarted = new Map<string, boolean>()
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
  /** Live channel runtime status, surfaced to the settings UI via getChannelStatuses. */
  private readonly channelStatuses = new Map<string, ChannelStatus>()
  private unsubSessionEvent?: () => void
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
    // Subscribe on the ROOT context: cordis dispatches events only on the
    // ctx that emitted them (no parent/child propagation), and session events
    // are emitted on the root context by the session service. A subscription
    // on this plugin's child ctx would silently receive NOTHING.
    this.unsubSessionEvent = this.ctx.root.on('session/event', (session, event) =>
      this.onSessionEvent(session, event),
    )
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
        const handled = await this.handleSlash(channel, message)
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
        await channel.sendText(convId, `⚠️ 命令执行失败：${detail}`).catch(() => undefined)
        return
      }
    }

    const convKey = `${message.channelId}:${message.conversationId}`
    const sessionId = await this.ensureSession(convKey)
    const parts = toContentBlocks(message)

    // Serialize turns per conversation so a fast second message waits for the first.
    const prev = this.serialQueues.get(convKey) ?? Promise.resolve()
    const next = prev.then(() => this.runTurn(sessionId, convKey, channel, parts))
    this.serialQueues.set(convKey, next.catch(() => undefined))
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
    const sessionId = SessionId(`im:${convKey}`)

    // 1) Live agent already exists (defensive; same-process reuse).
    const live = this.ctx.agents.get(sessionId)
    if (live) {
      this.convToSession.set(convKey, sessionId)
      this.sessionToConv.set(sessionId, convKey)
      await this.attachToWorkspace(sessionId)
      return sessionId
    }

    // 2) Stored log exists → resume (keeps history, avoids id collision).
    const persistence = this.ctx.get('sessionPersistence') as
      | { list(): Promise<Array<{ id: SessionId }>> }
      | undefined
    if (persistence) {
      const stored = (await persistence.list()).find((header) => header.id === sessionId)
      if (stored) {
        const handle = await this.ctx.agents.resume({ resumeSessionId: sessionId })
        // A resumed agent also needs the model-selection injection (same as create).
        this.installModelSelection(handle.agent, sessionId)
        this.agentHandles.set(sessionId, handle)
        this.convToSession.set(convKey, sessionId)
        this.sessionToConv.set(sessionId, convKey)
        this.ctx.logger.info(`[im-gateway] resumed session ${sessionId} (history kept)`)
        await this.attachToWorkspace(sessionId)
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
    let handle: AgentHandle
    try {
      handle = await this.ctx.agents.create({
        sessionId,
        meta: { cwd: this.config.cwd },
      })
    } catch (err) {
      if (isIdCollision(err)) {
        handle = await this.ctx.agents.resume({ resumeSessionId: sessionId })
      } else {
        throw err
      }
    }
    // Inject the model selection into the agent's prompt assembly. The persona
    // template renders {{provider}}/{{model}} from the selected model; official
    // entry points (api-proxy selectionFor) install this, but a bare
    // agents.create does not — without it every turn fails with
    // `prompt variable "{{model}}" has no value`. We use the deployment's
    // default model selection (agent-default-model), like the official paths do.
    this.installModelSelection(handle.agent, sessionId)
    this.agentHandles.set(sessionId, handle)

    this.convToSession.set(convKey, sessionId)
    this.sessionToConv.set(sessionId, convKey)
    await this.attachToWorkspace(sessionId)
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
  private async attachToWorkspace(sessionId: SessionId): Promise<void> {
    try {
      const workspaceRegistry = this.ctx.get('workspaceRegistry') as
        | {
            resolveByPath(path: string): Promise<{ attachSession(id: SessionId): Promise<void> } | undefined>
            create(path: string): Promise<{ attachSession(id: SessionId): Promise<void> }>
          }
        | undefined
      if (!workspaceRegistry) return
      const cwd = this.config.cwd
      if (!cwd) return
      let workspace = await workspaceRegistry.resolveByPath(cwd)
      if (!workspace) {
        workspace = await workspaceRegistry.create(cwd)
      }
      await workspace.attachSession(sessionId)
      this.ctx.logger.info(`[im-gateway] attached session ${sessionId} to workspace "${cwd}"`)
    } catch (err) {
      this.ctx.logger.warn(`[im-gateway] workspace attach failed for ${sessionId}`, err)
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
  private installModelSelection(agent: { ctx: Context; options?: Record<string, unknown> }, sessionId: SessionId): void {
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
    installModelSelection(agent.ctx, ref)
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
      await channel.sendText(convId, '⚠️ 会话未就绪，请稍后重试。')
      return
    }
    const userMessage: UserMessage = createUserMessage({ content: parts, source: { kind: 'user' } })
    try {
      // `followup` enqueues a user turn; the agent loop produces session events
      // that we receive via ctx.on('session/event').
      agent.followup(userMessage)
    } catch (err) {
      this.ctx.logger.error(`[im-gateway] followup failed for ${convKey}`, err)
      await channel.sendText(convId, '⚠️ 处理失败，请稍后重试。')
    }
  }

  // ── agent event → channel reply (ctx.on('session/event')) ──────────────

  private onSessionEvent(session: Session, event: SessionEvent): void {
    const convKey = this.sessionToConv.get(String(session.id))
    if (!convKey) return // not one of our IM sessions
    const channel = this.channelForConv(convKey)
    if (!channel) return
    const convId = convOf(convKey)

    switch (event.type) {
      case 'turn/start': {
        // Reset per-turn accumulators. The streaming channel is NOT opened
        // here — dsh fires turn/start when the agent STARTS processing the
        // user message (before any assistant output). Opening a server-side
        // StreamSession at this point would leave the QQ client on
        // "连接中" while the agent is still thinking. Mirrors the reference
        // project: beginStream happens on the first assistant text (below).
        this.finalText.set(convId, '')
        this.streamStarted.delete(convId)
        break
      }
      case 'assistant/chunk': {
        // StreamChunk union; only text-delta carries incremental text.
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') {
          // Assistant is actually producing text NOW → open the streaming
          // channel on the first delta (reference: message_start + dedupe).
          if (channel.beginStream && !this.streamStarted.get(convId)) {
            this.streamStarted.set(convId, true)
            void channel.beginStream(convId).catch((err) => {
              this.ctx.logger.warn(`[im-gateway] beginStream failed: ${err instanceof Error ? err.message : String(err)}`)
            })
          }
          this.finalText.set(convId, (this.finalText.get(convId) ?? '') + chunk.text)
          this.streamToChannel(channel, convId, chunk.text)
        }
        break
      }
      case 'tool/call': {
        const name = (event.data as { name?: string }).name ?? '未知工具'
        if (channel.streamText) {
          // Streaming channels: overwrite the card with the tool-call note —
          // the next text-delta replaces it with the real reply (reference
          // behavior: "show tool, then reply").
          void channel.streamText(convId, `🔧 正在调用工具：${name} …`).catch(() => undefined)
        } else {
          void channel.sendText(convId, `🔧 ${name} …`)
        }
        break
      }
      case 'assistant/message': {
        // Authoritative final text for the step (more reliable than folding chunks).
        this.finalText.set(convId, extractText(event.data.message.content))
        break
      }
      case 'turn/end': {
        this.flushStream(channel, convId)
        const full = this.finalText.get(convId) ?? ''
        if (channel.endStream) {
          // Streaming channels: finalize the card. ALWAYS call endStream even
          // with no text (pure tool-call replies) so the card closes instead
          // of hanging in "inputing". The adapter falls back to sendText if
          // its card was never created.
          void channel
            .endStream(convId, full || '✅ 已完成（无文本输出）')
            .catch((err) => {
              this.ctx.logger.warn(`[im-gateway] endStream failed: ${err instanceof Error ? err.message : String(err)}`)
              // Never lose the reply: plain-text fallback.
              if (full) void channel.sendText(convId, full).catch(() => undefined)
            })
        } else if (!channel.updateCard) {
          if (full) {
            void channel.sendText(convId, full)
          } else {
            // No assistant output: surface the failure to the user instead of
            // staying silent (e.g. model not configured → {{model}} unbound).
            const reason = (event.data as { reason?: { kind?: string; error?: { message?: string } } })?.reason
            if (reason?.kind === 'error') {
              const detail = typeof reason.error?.message === 'string' ? reason.error.message : '未知错误'
              void channel.sendText(convId, `⚠️ 处理失败：${detail.slice(0, 200)}`)
            }
          }
        }
        break
      }
      default:
        break
    }
  }

  // ── streaming throttle (card channels) ─────────────────────────────────

  private streamToChannel(channel: ImChannelAdapter, convId: string, delta: string): void {
    if (!channel.streamText && !channel.updateCard) return // no streaming support → rely on turn/end sendText
    const entry = this.pendingStream.get(convId) ?? { text: '' }
    entry.text += delta
    if (!entry.timer) {
      entry.timer = setTimeout(() => this.flushStream(channel, convId), this.config.streamThrottleMs)
    }
    this.pendingStream.set(convId, entry)
  }

  private flushStream(channel: ImChannelAdapter, convId: string): void {
    const entry = this.pendingStream.get(convId)
    if (!entry) return
    const text = entry.text
    entry.text = ''
    entry.timer = undefined
    this.pendingStream.set(convId, entry)
    if (!text) return
    // Prefer the full streaming lifecycle (streamText), fall back to the
    // legacy one-shot updateCard for channels that only implement that.
    if (channel.streamText) void channel.streamText(convId, text)
    else void channel.updateCard?.(convId, text)
  }

  // ── slash commands ─────────────────────────────────────────────────────

  private async handleSlash(channel: ImChannelAdapter, message: ImInboundMessage): Promise<boolean> {
    const parts = message.text.slice(1).split(/\s+/)
    const cmd = parts[0]
    const arg = parts.slice(1).join(' ').trim()
    const convKey = `${message.channelId}:${message.conversationId}`
    const convId = convOf(convKey)
    switch (cmd) {
      case 'help':
        // DingTalk's `markdown` msgtype collapses bare `\n` — only markdown
        // structure (list / blockquote / heading) yields a new line. Render
        // every command as a `- ` list item so each lands on its own row.
        await channel.sendText(
          convId,
          [
            '**可用指令**',
            '',
            '- `/help` — 显示本帮助',
            '- `/reset` · `/clear` · `/new` — 重置当前会话（开启新一轮）',
            '- `/model` — 列出可用模型；`/model <编号|模型名|provider/model>` 切换',
            '- `/status` — 查看当前渠道、工作目录与模型',
            '- `/stop` — 中止当前正在生成的回答',
          ].join('\n'),
        )
        return true
      case 'reset':
      case 'clear':
      case 'new': {
        const sessionId = this.convToSession.get(convKey)
        // dispose the agent + drop our mapping so the next message starts fresh.
        if (sessionId) {
          await this.agentHandles.get(sessionId)?.dispose().catch(() => undefined)
          this.agentHandles.delete(sessionId)
          this.modelRefs.delete(sessionId)
          this.modelOverrides.delete(sessionId)
          this.sessionToConv.delete(sessionId)
          this.convToSession.delete(convKey)
        }
        this.finalText.delete(convId)
        await channel.sendText(convId, '✅ 会话已重置，下一句将开启新一轮。')
        return true
      }
      case 'model':
        await this.handleModelCommand(channel, convKey, convId, arg)
        return true
      case 'status':
        await this.handleStatusCommand(channel, convKey, convId, message)
        return true
      case 'stop':
        await this.handleStopCommand(channel, convKey, convId)
        return true
      default:
        return false // not a known command → forward to the agent
    }
  }

  // ── /model ────────────────────────────────────────────────────────────

  private async handleModelCommand(
    channel: ImChannelAdapter,
    convKey: string,
    convId: string,
    arg: string,
  ): Promise<void> {
    const sessionId = this.convToSession.get(convKey)
    const models = await this.listAvailableModels()
    if (models.length === 0) {
      await channel.sendText(convId, '⚠️ 暂无可用的模型（未配置 provider）。')
      return
    }
    // 列目录不需要 session：先选好"当前"按 session override → global override → defaults 的优先级，
    // 这样用户即使还没发过消息，也能看到当前默认是啥。
    if (!arg) {
      const current =
        (sessionId ? this.modelOverrides.get(sessionId) : undefined) ??
        this.globalModelOverride ??
        this.ctx.get('agentDefaultModel')?.currentSelection()
      // Markdown list (each line `- …`) → one row per model on DingTalk.
      // DingTalk's markdown renderer resets ASCII numbers (`- 1.`, `- 2.`)
      // to a uniform value when they appear inside list items, so we use
      // emoji numerals (`1️⃣`, `2️⃣`, …) for unambiguous selection by /model.
      const NUM_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'] as const
      const lines = models.map((m, i) => {
        const isCur = current && current.provider === m.provider && current.model === m.model
        const label = m.name && m.name !== m.model ? `${m.model}（${m.name}）` : m.model
        const num = NUM_EMOJI[i] ?? `${i + 1}.`
        return `- ${num} ${label} \`[${m.provider}]\`${isCur ? ' ← 当前' : ''}`
      })
      await channel.sendText(
        convId,
        [
          '**可用模型**（输入 `/model <emoji|模型名|provider/model>` 切换——emoji 即列表左侧的 1️⃣2️⃣ 等；无会话时切换将设为默认模型，下次建立会话生效）',
          '',
          ...lines,
        ].join('\n'),
      )
      return
    }
    const target = this.resolveModelArg(arg, models)
    if (!target) {
      await channel.sendText(convId, `⚠️ 未找到模型「${arg}」。输入 /model 查看可用列表。`)
      return
    }
    // 无会话：写到 globalModelOverride，等会话建立时自动套用。
    if (!sessionId) {
      this.globalModelOverride = { provider: target.provider, model: target.model }
      await channel.sendText(
        convId,
        `✅ 已设置默认模型：\`${target.model}\` [\`${target.provider}\`]（下次建立会话时生效，下一次发送消息后立即应用）`,
      )
      return
    }
    // 有会话：写到会话级 override，并刷新该会话的 ref 让下一句立即生效。
    this.modelOverrides.set(sessionId, { provider: target.provider, model: target.model })
    const ref = this.modelRefs.get(sessionId)
    if (ref) {
      ;(ref as { current: ModelSelection | undefined }).current = { provider: target.provider, model: target.model }
    }
    await channel.sendText(convId, `✅ 已切换模型：\`${target.model}\` [\`${target.provider}\`]（下一句生效）`)
  }

  /** Build the provider/model catalog from the host llm registry. */
  private async listAvailableModels(): Promise<Array<{ provider: string; model: string; name: string }>> {
    const llm = this.ctx.get('llm') as
      | {
          // NOTE: `listProviders` is SYNC in @deepseek-ai/dsh-llm (returns an
          // array, see LlmRuntime.listProviders) — do NOT `.catch()` it, an
          // array has no such method and the TypeError kills the whole slash
          // command silently. `listModels` is async.
          listProviders(): Array<{ id: string; name: string }>
          listModels(p: string): Promise<Array<{ id: string; name?: string }>>
          resolveModelInfo?(p: string, m: string): Promise<unknown>
        }
      | undefined
    if (!llm?.listProviders) return []
    const out: Array<{ provider: string; model: string; name: string }> = []
    let providers: Array<{ id: string; name: string }> = []
    try {
      providers = llm.listProviders() ?? []
    } catch (err) {
      this.ctx.logger.warn(`[im-gateway] listProviders failed: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
    for (const p of providers) {
      let models: Array<{ id: string; name?: string }> = []
      try {
        models = await llm.listModels(p.id)
      } catch (err) {
        this.ctx.logger.warn(`[im-gateway] listModels("${p.id}") failed: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      for (const m of models) out.push({ provider: p.id, model: m.id, name: m.name ?? m.id })
    }
    return out
  }

  /** Resolve a /model argument (index | model id | partial | provider/model) to a catalog entry. */
  private resolveModelArg(
    arg: string,
    models: Array<{ provider: string; model: string; name: string }>,
  ): { provider: string; model: string } | undefined {
    const byIndex = arg.match(/^(\d+)$/)
    if (byIndex) {
      const idx = Number(byIndex[1]) - 1
      return models[idx]
    }
    if (arg.includes('/')) {
      const [provider, ...rest] = arg.split('/')
      const model = rest.join('/')
      return models.find((m) => m.provider === provider && m.model === model)
    }
    // exact model id, then case-insensitive partial match
    return (
      models.find((m) => m.model === arg) ??
      models.find((m) => m.model.toLowerCase() === arg.toLowerCase()) ??
      models.find((m) => m.model.toLowerCase().includes(arg.toLowerCase()))
    )
  }

  // ── /status ──────────────────────────────────────────────────────────

  private async handleStatusCommand(
    channel: ImChannelAdapter,
    convKey: string,
    convId: string,
    message: ImInboundMessage,
  ): Promise<void> {
    const sessionId = this.convToSession.get(convKey)
    const sessionOverride = sessionId ? this.modelOverrides.get(sessionId) : undefined
    const sel = sessionOverride ?? this.globalModelOverride ?? this.ctx.get('agentDefaultModel')?.currentSelection()
    const handle = sessionId ? this.agentHandles.get(sessionId) : undefined
    const lines = ['**当前状态**', '']
    lines.push(
      `- 📡 渠道：\`${message.channelId}\``,
      `- 📁 工作目录：\`${this.config.cwd}\``,
      `- 🤖 当前模型：${sel ? `\`${sel.provider} / ${sel.model}\`` : '未知'}`,
      `- 💬 会话：${sessionId ? '已建立' : '未建立'}`,
    )
    if (this.globalModelOverride && !sessionOverride) {
      lines.push(`- 🌐 全局默认模型（预选）：\`${this.globalModelOverride.provider} / ${this.globalModelOverride.model}\``)
    }
    if (handle) lines.push(`- ⚙️ 运行状态：\`${handle.agent.status}\``)
    await channel.sendText(convId, lines.join('\n'))
  }

  // ── /stop ────────────────────────────────────────────────────────────

  private async handleStopCommand(
    channel: ImChannelAdapter,
    convKey: string,
    convId: string,
  ): Promise<void> {
    const sessionId = this.convToSession.get(convKey)
    const handle = sessionId ? this.agentHandles.get(sessionId) : undefined
    if (!handle) {
      await channel.sendText(convId, '⚠️ 当前没有进行中的会话。')
      return
    }
    try {
      // Same call the official session.cancel RPC makes. keepInbox preserves any
      // queued follow-up so a later message still works.
      handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
      await channel.sendText(convId, '🛑 已中止当前轮次。')
    } catch (err) {
      this.ctx.logger.error(`[im-gateway] /stop failed for ${convKey}`, err)
      await channel.sendText(convId, '⚠️ 中止失败，请稍后重试。')
    }
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

/** Extract plain text from an assistant message's content blocks. */
function extractText(content: ContentBlock[]): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
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
