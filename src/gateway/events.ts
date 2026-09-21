/**
 * 事件分发器：从 im-gateway.ts 提取的 onSessionEvent 逻辑。
 *
 * 把 dsh agent 的 SessionEvent（turn/start, assistant/chunk, tool/call,
 * assistant/message, turn/end）翻译为 IM 渠道的 sendText / beginStream /
 * streamText / endStream 调用。
 *
 * 通过 EventHandle 接口访问服务内部状态，避免循环依赖。
 *
 * @module im-gateway/events
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { joinAssistantStreamText } from '@deepseek-ai/dsh-llm'
import type { ImChannelAdapter } from './types'
import { splitText } from './split'
import type { StreamThrottle } from './stream'
import type { Translator } from './i18n'
import { prefixSessionTitle } from './session-title'

/**
 * 等官方 LLM 标题的最长时间。
 *
 * 官方链路（`dsh-base/cordis.patch.yml` 实配 `dsh-session-title-first-prompt-llm`）
 * 在首条用户消息后**先**写入一个确定性 fallback 标题，再由 LLM 异步覆盖成智能标题。
 * 这个窗口就是给那次 LLM 调用留的：到点仍只有 fallback 就退而用 fallback 加前缀。
 *
 * 取值依据（实测会话日志）：`session/title`(fallback) 与 `session/title-llm-request`
 * 在同**一秒**内先后落盘，即窗口从请求真正发起时才开始计时；小模型生成 5 词标题
 * 一般 1–3 秒返回。10s 已是宽裕上界，再长就纯粹是让用户干等。
 * 注意：provider 是否真能产出标题取决于标题模型本身（本机走 lm-studio 本地模型时
 * 实测长期无 provider 标题落地），所以**不能**把这个窗口当「LLM 一定会来」来依赖。
 */
const TITLE_LLM_WAIT_MS = 10_000

/** 事件分发器需要的服务内部状态接口。 */
export interface EventHandle {
  ctx: Context
  t: Translator
  sessionToConv: Map<string, string>
  streamThrottle?: StreamThrottle
  channelForConv(convKey: string): ImChannelAdapter | undefined
}

/** convKey → conversationId */
function convOf(convKey: string): string {
  return convKey.slice(convKey.indexOf(':') + 1)
}

/** 从 ContentBlock[] 中提取纯文本。 */
function extractText(content: ContentBlock[]): string {
  return content
    .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
    .map((b) => b.text)
    .join('')
}

export class EventDispatcher {
  /** Per-conversation accumulator for the final assistant text (turn scope). */
  private readonly finalText = new Map<string, string>()
  /** convId → 本回合由实时流累积出的可见文本（真流式路径）。 */
  private readonly liveText = new Map<string, string>()
  /** 本回合是否已经推过实时增量（有则 `assistant/message` 不再重复推送）。 */
  private readonly liveActive = new Set<string>()
  /** convId → 当前所在段落（`turn:step`），用于段落之间补空行。 */
  private readonly liveSegment = new Map<string, string>()
  /** convId → 标题兜底定时器（等官方 LLM 标题的时间窗内不动 fallback 标题）。 */
  private readonly titleTimers = new Map<string, ReturnType<typeof setTimeout>>()

  constructor(private readonly gw: EventHandle) {}

  /**
   * 把 dsh session 事件翻译为 IM 渠道操作。
   *
   * 流程概览（事件 → 动作）：
   *   turn/start        → beginStream（立即在 QQ 端建立「机器人头像 + 三个点」占位）
   *   assistant/message → 经 streamThrottle 把权威文本推给 channel.streamText
   *                       （仅在该回合**没有**实时流时；有实时流则内容已推过）
   *   tool/call         → 不推送（气泡由 StreamSession 心跳维持）
   *   turn/end          → flush 节流；endStream（DONE 帧）或 sendText 兜底
   *
   * 实时逐字增量走另一条入口 `dispatchAssistantStream()`（`agent/assistant-stream`），
   * 而不是这里的 `session/event` —— 后者要等一条 assistant 消息**完成**才触发。
   */
  dispatch(session: Session, event: SessionEvent): void {
    const convKey = this.gw.sessionToConv.get(String(session.id))
    if (!convKey) return
    const channel = this.gw.channelForConv(convKey)
    if (!channel) return
    const convId = convOf(convKey)

    // `session/title` 的载荷类型由 @deepseek-ai/dsh-session-title 通过 declare
    // module 合并进 SessionEventMap；本插件未依赖该包，故在 switch 之外单独判定
    // （详见 ./session-title 的模块注释）。
    if ((event as { type: string }).type === 'session/title') {
      this.dispatchSessionTitle(session, convId, channel, event)
      return
    }

    switch (event.type) {
      case 'turn/start': {
        this.finalText.set(convId, '')
        // 新回合：清空上一轮的流式累积（节流器 + 实时流状态）。
        this.gw.streamThrottle?.reset(convId)
        this.liveText.delete(convId)
        this.liveActive.delete(convId)
        this.liveSegment.delete(convId)
        // 立即开流：用户发消息瞬间就在 QQ 端显示「机器人头像 + 三个点」占位。
        // StreamSession 心跳（qq.ts 内）会在整个回合（思考 + 工具调用）持续续命，
        // 阻止动画中途消失。群聊 / 不支持流式的通道自动降级为 turn/end 的 sendText。
        if (channel.beginStream) {
          void channel.beginStream(convId).catch((err) => {
            this.gw.ctx.logger.warn(`[im-gateway] beginStream failed: ${err instanceof Error ? err.message : String(err)}`)
          })
        }
        break
      }
      // dsh 0.1.5 移除了逐字 `assistant/chunk` 事件；assistant/message 在
      // 一条消息完成时触发，携带最终文本与流的 compact 记录。IM 侧把该文本
      // 经 streamThrottle 推给通道的 streamText（实时替换 StreamSession 气泡）。
      // 首帧「机器人头像 + 三个点」已在 turn/start 的 beginStream 立即建立，
      // 这里只负责把真正的文本填进去。
      case 'assistant/message': {
        const message = event.data.message
        const text =
          joinAssistantStreamText(event.data.stream) ||
          extractText(message.content) ||
          ''
        if (!text) break
        // 本回合已通过 agent/assistant-stream 逐字推过同一份文本 → 不再推一次，
        // 否则节流器里会变成「全文 + 全文」的重复内容。终态文本以实时累积为准。
        if (this.liveActive.has(convId)) {
          this.finalText.set(convId, this.liveText.get(convId) || text)
          break
        }
        this.finalText.set(convId, text)
        this.gw.streamThrottle?.push(channel, convId, text)
        break
      }
      // 工具调用阶段不向 IM 推送任何提示（按用户要求）。StreamSession 的心跳
      // 继续维持「正在生成」气泡，直到 turn/end。
      case 'tool/call':
        break
      case 'turn/end': {
        this.gw.streamThrottle?.flush(channel, convId)
        const full = this.finalText.get(convId) ?? ''
        if (channel.endStream) {
          void channel
            .endStream(convId, full || this.gw.t.t('evt.turn.noOutput'))
            .catch((err) => {
              this.gw.ctx.logger.warn(`[im-gateway] endStream failed: ${err instanceof Error ? err.message : String(err)}`)
              if (full) {
                const max = channel.maxMessageChars ?? 4000
                for (const chunk of splitText(full, max, this.gw.t.lang)) {
                  void channel.sendText(convId, chunk).catch(() => undefined)
                }
              }
            })
        } else if (!channel.updateCard) {
          if (full) {
            const max = channel.maxMessageChars ?? 4000
            for (const chunk of splitText(full, max, this.gw.t.lang)) {
              void channel.sendText(convId, chunk).catch(() => undefined)
            }
          } else {
            const reason = (event.data as { reason?: { kind?: string; error?: { message?: string } } })?.reason
            if (reason?.kind === 'error') {
              const detail = typeof reason.error?.message === 'string' ? reason.error.message : this.gw.t.t('evt.turn.errorUnknown')
              void channel.sendText(convId, this.gw.t.t('evt.turn.failed', detail.slice(0, 200)))
            }
          }
        }
        break
      }
      default:
        break
    }
  }

  /**
   * 给 IM 会话标题加 `[通道名] ` 前缀。
   *
   * 时机是这里的关键 —— `rename` 写入的是 `source.kind === 'user'`，会 pin 住标题
   * 并中止后续自动生成，所以不能见到标题就改：
   *   - `provider`（LLM 生成的智能标题）→ 立即加前缀，这是正常路径
   *   - `fallback`（首条消息截断的确定性标题）→ 只登记延时兜底，把时间窗让给 LLM；
   *     若 LLM 始终没产出（未配模型 / 调用失败），兜底再给它加前缀
   *   - `user`（用户手动重命名）→ 一律不动，尊重用户的显式选择
   */
  private dispatchSessionTitle(
    session: Session,
    convId: string,
    channel: ImChannelAdapter,
    event: SessionEvent,
  ): void {
    const kind = (event.data as { source?: { kind?: string } }).source?.kind
    if (kind === 'user') {
      // 用户已经自己命名过了，撤掉还没到点的兜底，别覆盖他的选择。
      this.clearTitleFallback(convId)
      return
    }
    if (kind === 'provider') {
      this.clearTitleFallback(convId)
      prefixSessionTitle(this.gw.ctx, session, channel.label)
      return
    }
    this.scheduleTitleFallback(session, convId, channel)
  }

  /** 登记一次兜底加前缀；同一会话只登记一次。 */
  private scheduleTitleFallback(session: Session, convId: string, channel: ImChannelAdapter): void {
    if (this.titleTimers.has(convId)) return
    const timer = setTimeout(() => {
      this.titleTimers.delete(convId)
      // 定时器回调不在任何事件管线的错误边界内 —— 这里抛出去就是未捕获异常。
      // prefixSessionTitle 本身已保证不抛，这层 try/catch 是最后一道保险。
      try {
        prefixSessionTitle(this.gw.ctx, session, channel.label)
      } catch (err) {
        this.gw.ctx.logger.warn(`[im-gateway] session title prefix failed: ${String(err)}`)
      }
    }, TITLE_LLM_WAIT_MS)
    // 兜底属于「尽力而为」，不该拖着进程不退出（与 gateway/approval.ts 同款处理）。
    timer.unref?.()
    this.titleTimers.set(convId, timer)
  }

  /** 取消某会话的兜底定时器。 */
  private clearTitleFallback(convId: string): void {
    const timer = this.titleTimers.get(convId)
    if (!timer) return
    clearTimeout(timer)
    this.titleTimers.delete(convId)
  }

  /**
   * 把 dsh 的实时 assistant 流（`agent/assistant-stream`）翻译为渠道增量。
   *
   * 为什么需要这条入口：dsh 0.1.5 起 `session/event` 里不再有逐字事件
   * （`assistant/chunk` 已移除），`assistant/message` 要等一条消息**完成**才触发 ——
   * 只靠它做流式就只能是「憋完整段再一次性发出」。但 agent loop 实际仍会实时
   * emit `agent/assistant-stream`（web UI 正是靠它逐字渲染），frame 形如：
   *
   *   { type: 'start', turn, step, ... }            — 一次模型尝试开始
   *   { type: 'chunk', turn, step, chunk }          — chunk.type==='text-delta' → 增量文本
   *   { type: 'end', turn, step, ... }              — 尝试结束
   *
   * 该事件是 agent-scoped 派发的，订阅方必须带 `{ global: true }`（见 im-gateway.ts）。
   */
  dispatchAssistantStream(sessionId: unknown, frame: unknown): void {
    const convKey = this.gw.sessionToConv.get(String(sessionId))
    if (!convKey) return
    const channel = this.gw.channelForConv(convKey)
    if (!channel) return
    const convId = convOf(convKey)

    const f = frame as {
      type?: string
      turn?: number
      step?: number
      chunk?: { type?: string; text?: string }
    }

    if (f.type === 'end') {
      // 流已结束：立刻把最后一批推上屏，不必再等节流定时器。
      this.gw.streamThrottle?.flush(channel, convId)
      return
    }
    if (f.type !== 'chunk') return
    const chunk = f.chunk
    if (!chunk || chunk.type !== 'text-delta' || typeof chunk.text !== 'string') return
    const delta = chunk.text
    if (!delta) return

    // 同一回合内 step 变化 = 模型开始了新的一条 assistant 消息；补空行分隔两段，
    // 否则「引导语」和「最终答案」会粘成一行。
    const segment = `${f.turn ?? 0}:${f.step ?? 0}`
    const prevSegment = this.liveSegment.get(convId)
    const mine = this.liveText.get(convId) ?? ''
    if (mine && prevSegment !== undefined && prevSegment !== segment) {
      this.liveText.set(convId, `${mine}\n\n`)
      this.gw.streamThrottle?.push(channel, convId, '\n\n')
    }
    this.liveSegment.set(convId, segment)

    this.liveText.set(convId, (this.liveText.get(convId) ?? '') + delta)
    this.liveActive.add(convId)
    this.gw.streamThrottle?.push(channel, convId, delta)
  }

  /** 获取某会话的累积文本（供外部读取，如 CommandHandler 的 /status）。 */
  getFinalText(convId: string): string | undefined {
    return this.finalText.get(convId)
  }

  /** 清理指定会话的事件状态。 */
  disposeConversation(convId: string): void {
    this.finalText.delete(convId)
    this.liveText.delete(convId)
    this.liveActive.delete(convId)
    this.liveSegment.delete(convId)
    this.clearTitleFallback(convId)
  }
}
