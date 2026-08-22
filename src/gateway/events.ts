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
import type { ImChannelAdapter } from './types'
import { splitText } from './split'
import type { StreamThrottle } from './stream'
import type { Translator } from './i18n'

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
  /** Whether beginStream was already called for this conversation's reply cycle. */
  private readonly streamStarted = new Map<string, boolean>()

  constructor(private readonly gw: EventHandle) {}

  /**
   * 把 dsh session 事件翻译为 IM 渠道操作。
   *
   * 流程概览（事件 → 动作）：
   *   turn/start        → 重置 finalText/streamStarted
   *   assistant/chunk   → 首个 text-delta 时 beginStream；累积文本；节流推送
   *   tool/call         → 显示「正在调用工具」提示
   *   assistant/message → 用权威文本覆盖累积值
   *   turn/end          → flush 节流；endStream 或 sendText（含分片兜底）
   */
  dispatch(session: Session, event: SessionEvent): void {
    const convKey = this.gw.sessionToConv.get(String(session.id))
    if (!convKey) return
    const channel = this.gw.channelForConv(convKey)
    if (!channel) return
    const convId = convOf(convKey)

    switch (event.type) {
      case 'turn/start': {
        this.finalText.set(convId, '')
        this.streamStarted.delete(convId)
        break
      }
      case 'assistant/chunk': {
        const chunk = event.data.chunk
        if (chunk.type === 'text-delta') {
          if (channel.beginStream && !this.streamStarted.get(convId)) {
            this.streamStarted.set(convId, true)
            void channel.beginStream(convId).catch((err) => {
              this.gw.ctx.logger.warn(`[im-gateway] beginStream failed: ${err instanceof Error ? err.message : String(err)}`)
            })
          }
          this.finalText.set(convId, (this.finalText.get(convId) ?? '') + chunk.text)
          this.gw.streamThrottle?.push(channel, convId, chunk.text)
        }
        break
      }
      case 'tool/call': {
        const name = (event.data as { name?: string }).name ?? this.gw.t.t('evt.tool.unknown')
        if (channel.streamText) {
          void channel.streamText(convId, this.gw.t.t('evt.tool.calling', name)).catch(() => undefined)
        } else {
          void channel.sendText(convId, this.gw.t.t('evt.tool.callingPlain', name))
        }
        break
      }
      case 'assistant/message': {
        this.finalText.set(convId, extractText(event.data.message.content))
        break
      }
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

  /** 获取某会话的累积文本（供外部读取，如 CommandHandler 的 /status）。 */
  getFinalText(convId: string): string | undefined {
    return this.finalText.get(convId)
  }

  /** 清理指定会话的事件状态。 */
  disposeConversation(convId: string): void {
    this.finalText.delete(convId)
    this.streamStarted.delete(convId)
  }
}