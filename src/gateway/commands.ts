/**
 * Slash 命令处理器：从 im-gateway.ts 提取的 /help /reset /model /status /stop
 * /sessions /continue 命令实现。
 *
 * 通过 GatewayHandle 接口访问服务内部状态，避免循环依赖。
 *
 * @module im-gateway/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { AgentHandle, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type { ImChannelAdapter, ImGatewayConfig, ImInboundMessage } from './types'
import type { Translator } from './i18n'
import { existsSync, statSync } from 'node:fs'
import { resolve as pathResolve } from 'node:path'

/** 命令处理器需要的服务内部状态接口。 */
export interface GatewayHandle {
  config: ImGatewayConfig
  ctx: Context
  t: Translator
  convToSession: Map<string, SessionId>
  sessionToConv: Map<string, string>
  agentHandles: Map<string, AgentHandle>
  modelRefs: Map<string, ModelSelectionRef>
  modelOverrides: Map<string, { provider: string; model: string; reasoningEffort?: string }>
  globalModelOverride?: { provider: string; model: string; reasoningEffort?: string }
  clearConversationState(convId: string): void
  setGlobalModelOverride(v: { provider: string; model: string; reasoningEffort?: string } | undefined): void
  attachToWorkspace(sessionId: SessionId, cwd?: string): Promise<void>
  logWorkspaceState(label: string): void
  installModelSelection(agent: { ctx: Context; options?: Record<string, unknown> }, sessionId: SessionId): void
  channelForConv(convKey: string): ImChannelAdapter | undefined
  workspaceOf(convKey: string): string | undefined
  setWorkspace(convKey: string, path: string): void
  bumpSessionGeneration(convKey: string): void
}

/** convKey → conversationId */
function convOf(convKey: string): string {
  return convKey.slice(convKey.indexOf(':') + 1)
}

export class CommandHandler {
  constructor(private readonly gw: GatewayHandle) {}

  async handle(channel: ImChannelAdapter, message: ImInboundMessage): Promise<boolean> {
    const parts = message.text.slice(1).split(/\s+/)
    const cmd = parts[0]
    const arg = parts.slice(1).join(' ').trim()
    const convKey = `${message.channelId}:${message.conversationId}`
    const convId = convOf(convKey)
    console.log(`[im-gateway] cmd parse: text="${message.text}" cmd="${cmd}" arg="${arg}"`)
    switch (cmd) {
      case 'help':
        await channel.sendText(convId, this.helpText())
        return true
      case 'reset':
      case 'clear':
      case 'new':
        await this.handleReset(channel, convKey, convId)
        return true
      case 'model':
        await this.handleModel(channel, convKey, convId, arg)
        return true
      case 'status':
        await this.handleStatus(channel, convKey, convId, message)
        return true
      case 'stop':
        await this.handleStop(channel, convKey, convId)
        return true
      case 'sessions':
        await this.handleSessions(channel, convId)
        return true
      case 'continue':
        await this.handleContinue(channel, convKey, convId, arg)
        return true
      case 'workspaces':
        await this.handleWorkspaces(channel, convId)
        return true
      case 'workspace':
        await this.handleWorkspace(channel, convKey, convId, arg)
        return true
      default:
        return false
    }
  }

  private helpText(): string {
    const t = this.gw.t
    return [
      t.t('cmd.help.title'),
      '',
      t.t('cmd.help.help'),
      t.t('cmd.help.reset'),
      t.t('cmd.help.model'),
      t.t('cmd.help.status'),
      t.t('cmd.help.stop'),
      t.t('cmd.help.sessions'),
      t.t('cmd.help.continue'),
      t.t('cmd.help.workspaces'),
      t.t('cmd.help.workspace'),
    ].join('\n')
  }

  private async handleReset(channel: ImChannelAdapter, convKey: string, convId: string): Promise<void> {
    const sessionId = this.gw.convToSession.get(convKey)
    console.log(`[im-gateway] /new ── old sessionId=${sessionId}, convKey=${convKey}`)
    if (sessionId) {
      this.gw.logWorkspaceState('before dispose')
      console.log(`[im-gateway] /new: disposing handle for ${sessionId}`)
      // 不调用 handle.dispose() — dispose 会从 ctx.sessions 中移除会话，
      // 导致 sessionQuery.listSessions() 不返回旧会话，桌面端 UI 刷新后旧会话消失。
      // 只清理 im-gateway 内部状态，旧 agent 留在 ctx.sessions/ctx.agents 中，
      // listSessions() 仍返回它%2它，UI 仍显示它。旧 agent 无 followup 调用，不会消耗资源。
      const handle = this.gw.agentHandles.get(sessionId)
      if (handle) {
        try { handle.agent.cancel({ kind: 'user' }, { keepInbox: true }) } catch { /* ignore */ }
      }
      console.log(`[im-gateway] /new: agent cancelled (not disposed)`)
      this.gw.logWorkspaceState('after dispose')
      // 检查 sessionQuery.listSessions() 是否仍返回旧会话（桌面端 UI 的数据源）
      try {
        const query = this.gw.ctx.get('sessionQuery') as
          | { listSessions(signal?: AbortSignal): Promise<Array<{ header: { id: SessionId; cwd?: string } }>> }
          | undefined
        if (query) {
          const sessions = await query.listSessions()
          console.log(`[im-gateway] after dispose ── sessionQuery.listSessions() (${sessions.length}):`)
          for (const s of sessions) {
            console.log(`[im-gateway]   ${s.header.id} cwd="${s.header.cwd ?? '?'}"`)
          }
        }
      } catch { /* ignore */ }
      this.gw.agentHandles.delete(sessionId)
      this.gw.modelRefs.delete(sessionId)
      this.gw.modelOverrides.delete(sessionId)
      this.gw.sessionToConv.delete(sessionId)
      this.gw.convToSession.delete(convKey)
    }
    this.gw.clearConversationState(convId)
    this.gw.bumpSessionGeneration(convKey)
    console.log(`[im-gateway] /new: generation bumped, session cleared`)
    await channel.sendText(convId, this.gw.t.t('cmd.reset.success'))
  }

  private async handleModel(channel: ImChannelAdapter, convKey: string, convId: string, arg: string): Promise<void> {
    const t = this.gw.t
    const sessionId = this.gw.convToSession.get(convKey)
    const models = await this.listAvailableModels()
    if (models.length === 0) {
      await channel.sendText(convId, t.t('cmd.model.none'))
      return
    }
    if (!arg) {
      const current =
        (sessionId ? this.gw.modelOverrides.get(sessionId) : undefined) ??
        this.gw.globalModelOverride ??
        this.gw.ctx.get('agentDefaultModel')?.currentSelection()
      const NUM_EMOJI = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'] as const
      const lines = models.map((m, i) => {
        const isCur = current && current.provider === m.provider && current.model === m.model
        const label = m.name && m.name !== m.model ? t.t('cmd.model.labelAlias', m.model, m.name) : m.model
        const num = NUM_EMOJI[i] ?? `${i + 1}.`
        return `- ${num} ${label} \`[${m.provider}]\`${isCur ? t.t('cmd.model.currentMark') : ''}`
      })
      await channel.sendText(
        convId,
        [
          t.t('cmd.model.listTitle'),
          '',
          ...lines,
        ].join('\n'),
      )
      return
    }
    const target = this.resolveModelArg(arg, models)
    if (!target) {
      await channel.sendText(convId, t.t('cmd.model.notFound', arg))
      return
    }
    if (!sessionId) {
      this.gw.setGlobalModelOverride({ provider: target.provider, model: target.model })
      await channel.sendText(convId, t.t('cmd.model.setGlobal', target.model, target.provider))
      return
    }
    this.gw.modelOverrides.set(sessionId, { provider: target.provider, model: target.model })
    const ref = this.gw.modelRefs.get(sessionId)
    if (ref) {
      ;(ref as { current: ModelSelection | undefined }).current = { provider: target.provider, model: target.model }
    }
    await channel.sendText(convId, t.t('cmd.model.switched', target.model, target.provider))
  }

  private async listAvailableModels(): Promise<Array<{ provider: string; model: string; name: string }>> {
    const llm = this.gw.ctx.get('llm') as
      | {
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
      this.gw.ctx.logger.warn(`[im-gateway] listProviders failed: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
    for (const p of providers) {
      let models: Array<{ id: string; name?: string }> = []
      try {
        models = await llm.listModels(p.id)
      } catch (err) {
        this.gw.ctx.logger.warn(`[im-gateway] listModels("${p.id}") failed: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      for (const m of models) out.push({ provider: p.id, model: m.id, name: m.name ?? m.id })
    }
    return out
  }

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
    return (
      models.find((m) => m.model === arg) ??
      models.find((m) => m.model.toLowerCase() === arg.toLowerCase()) ??
      models.find((m) => m.model.toLowerCase().includes(arg.toLowerCase()))
    )
  }

  private async handleStatus(
    channel: ImChannelAdapter,
    convKey: string,
    convId: string,
    message: ImInboundMessage,
  ): Promise<void> {
    const t = this.gw.t
    const sessionId = this.gw.convToSession.get(convKey)
    const sessionOverride = sessionId ? this.gw.modelOverrides.get(sessionId) : undefined
    const sel = sessionOverride ?? this.gw.globalModelOverride ?? this.gw.ctx.get('agentDefaultModel')?.currentSelection()
    const handle = sessionId ? this.gw.agentHandles.get(sessionId) : undefined
    const lines = [t.t('cmd.status.title'), '']
    lines.push(
      t.t('cmd.status.channel', message.channelId),
      t.t('cmd.status.cwd', this.gw.workspaceOf(convKey) ?? this.gw.config.cwd),
      sel ? t.t('cmd.status.model', sel.provider, sel.model) : t.t('cmd.status.modelUnknown'),
      sessionId ? t.t('cmd.status.sessionYes') : t.t('cmd.status.sessionNo'),
    )
    if (this.gw.globalModelOverride && !sessionOverride) {
      lines.push(t.t('cmd.status.globalModel', this.gw.globalModelOverride.provider, this.gw.globalModelOverride.model))
    }
    if (handle) lines.push(t.t('cmd.status.agentStatus', handle.agent.status))
    await channel.sendText(convId, lines.join('\n'))
  }

  private async handleStop(channel: ImChannelAdapter, convKey: string, convId: string): Promise<void> {
    const t = this.gw.t
    const sessionId = this.gw.convToSession.get(convKey)
    const handle = sessionId ? this.gw.agentHandles.get(sessionId) : undefined
    if (!handle) {
      await channel.sendText(convId, t.t('cmd.stop.noSession'))
      return
    }
    try {
      handle.agent.cancel({ kind: 'user' }, { keepInbox: true })
      await channel.sendText(convId, t.t('cmd.stop.done'))
    } catch (err) {
      this.gw.ctx.logger.error(`[im-gateway] /stop failed for ${convKey}`, err)
      await channel.sendText(convId, t.t('cmd.stop.failed'))
    }
  }

  private async handleSessions(channel: ImChannelAdapter, convId: string): Promise<void> {
    const t = this.gw.t
    try {
      const query = this.gw.ctx.get('sessionQuery') as
        | {
            listSessions(signal?: AbortSignal): Promise<Array<{ header: { id: SessionId; cwd?: string; createdAt?: number }; live: boolean; persisted: boolean }>>
            readTitleSnapshots(
              ids: readonly SessionId[],
              signal?: AbortSignal,
            ): Promise<Array<{ sessionId: SessionId; status: 'fulfilled'; value?: { title?: { title: string } } } | { sessionId: SessionId; status: 'rejected'; reason: unknown }>>
          }
        | undefined
      if (!query) {
        await channel.sendText(convId, t.t('cmd.sessions.unavailable'))
        return
      }
      const sessions = await query.listSessions().catch(() => [])
      if (sessions.length === 0) {
        await channel.sendText(convId, t.t('cmd.sessions.empty'))
        return
      }
      const currentSessionId = this.gw.convToSession.get(`${channel.id}:${convId}`)
      const recent = sessions.slice(0, 10)
      const ids = recent.map((s) => s.header.id)
      const titleMap = new Map<string, string>()
      try {
        const titleResults = await query.readTitleSnapshots(ids)
        for (const r of titleResults) {
          if (r.status === 'fulfilled' && r.value?.title) {
            titleMap.set(String(r.sessionId), r.value.title.title)
          }
        }
      } catch { /* ignore */ }
      const lines = [t.t('cmd.sessions.title'), '']
      for (const s of recent) {
        const sid = String(s.header.id)
        const isCurrent = sid === String(currentSessionId ?? '')
        const title = titleMap.get(sid) ?? t.t('cmd.sessions.noTitle')
        lines.push(`- ${isCurrent ? '👉 ' : ''}\`${sid.slice(0, 20)}\` ${title.slice(0, 40)}${isCurrent ? t.t('cmd.sessions.currentMark') : ''}`)
      }
      if (sessions.length > 10) lines.push('', t.t('cmd.sessions.total', sessions.length))
      await channel.sendText(convId, lines.join('\n'))
    } catch (err) {
      this.gw.ctx.logger.error('[im-gateway] /sessions failed', err)
      await channel.sendText(convId, t.t('cmd.sessions.failed'))
    }
  }

  private async handleContinue(
    channel: ImChannelAdapter,
    convKey: string,
    convId: string,
    arg: string,
  ): Promise<void> {
    const t = this.gw.t
    if (!arg) {
      await channel.sendText(convId, t.t('cmd.continue.usage'))
      return
    }
    const targetSessionId = SessionId(arg)
    try {
      const currentSessionId = this.gw.convToSession.get(convKey)
      if (currentSessionId && currentSessionId !== targetSessionId) {
        await this.gw.agentHandles.get(currentSessionId)?.dispose().catch(() => undefined)
        this.gw.agentHandles.delete(currentSessionId)
        this.gw.modelRefs.delete(currentSessionId)
        this.gw.modelOverrides.delete(currentSessionId)
        this.gw.sessionToConv.delete(currentSessionId)
      }
      const handle = await this.gw.ctx.agents.resume({ resumeSessionId: targetSessionId })
      this.gw.installModelSelection(handle.agent, targetSessionId)
      this.gw.agentHandles.set(targetSessionId, handle)
      this.gw.convToSession.set(convKey, targetSessionId)
      this.gw.sessionToConv.set(targetSessionId, convKey)

      await channel.sendText(convId, t.t('cmd.continue.success', arg))
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      this.gw.ctx.logger.error(`[im-gateway] /continue ${arg} failed`, err)
      await channel.sendText(convId, t.t('cmd.continue.failed', detail.slice(0, 200)))
    }
  }

  private async handleWorkspaces(channel: ImChannelAdapter, convId: string): Promise<void> {
    const t = this.gw.t
    try {
      const query = this.gw.ctx.get('sessionQuery') as
        | { listSessions(signal?: AbortSignal): Promise<Array<{ header: { id: SessionId; cwd?: string; createdAt?: number } }>> }
        | undefined
      if (!query) {
        await channel.sendText(convId, t.t('cmd.workspaces.unavailable'))
        return
      }
      const sessions = await query.listSessions().catch(() => [])
      if (sessions.length === 0) {
        await channel.sendText(convId, t.t('cmd.workspaces.empty'))
        return
      }
      const byWorkspace = new Map<string, { count: number; last: number }>()
      for (const s of sessions) {
        const cwd = s.header?.cwd ?? t.t('cmd.workspaces.unknown')
        const cur = byWorkspace.get(cwd) ?? { count: 0, last: 0 }
        cur.count += 1
        const created = s.header?.createdAt ?? 0
        if (created > cur.last) cur.last = created
        byWorkspace.set(cwd, cur)
      }
      const rows = [...byWorkspace.entries()].sort((a, b) => b[1].last - a[1].last)
      const lines = [t.t('cmd.workspaces.title', rows.length), '']
      for (const [cwd, info] of rows.slice(0, 20)) {
        lines.push(t.t('cmd.workspaces.item', cwd, info.count))
      }
      if (rows.length > 20) lines.push('', t.t('cmd.workspaces.total', rows.length))
      lines.push('', t.t('cmd.workspaces.hint'))
      await channel.sendText(convId, lines.join('\n'))
    } catch (err) {
      this.gw.ctx.logger.error('[im-gateway] /workspaces failed', err)
      await channel.sendText(convId, t.t('cmd.workspaces.failed'))
    }
  }

  private async handleWorkspace(
    channel: ImChannelAdapter,
    convKey: string,
    convId: string,
    arg: string,
  ): Promise<void> {
    const t = this.gw.t
    console.log(`[im-gateway] /workspace: arg="${arg}" convKey=${convKey}`)
    if (!arg) {
      await this.handleWorkspaces(channel, convId)
      return
    }
    const target = arg.startsWith('/') || arg.includes(':')
      ? arg
      : pathResolve(this.gw.config.cwd, arg)
    try {
      if (!existsSync(target) || !statSync(target).isDirectory()) {
        await channel.sendText(convId, t.t('cmd.workspace.notDir', target))
        return
      }
    } catch {
      await channel.sendText(convId, t.t('cmd.workspace.notFound', target))
      return
    }
    this.gw.setWorkspace(convKey, target)
    const oldSessionId = this.gw.convToSession.get(convKey)
    if (oldSessionId) {
      const handle = this.gw.agentHandles.get(oldSessionId)
      if (handle) {
        try { handle.agent.cancel({ kind: 'user' }, { keepInbox: true }) } catch { /* ignore */ }
      }
      this.gw.agentHandles.delete(oldSessionId)
      this.gw.modelRefs.delete(oldSessionId)
      this.gw.modelOverrides.delete(oldSessionId)
      this.gw.sessionToConv.delete(oldSessionId)
      this.gw.convToSession.delete(convKey)
    }
    this.gw.bumpSessionGeneration(convKey)
    await channel.sendText(convId, t.t('cmd.workspace.switched', target))
  }
}