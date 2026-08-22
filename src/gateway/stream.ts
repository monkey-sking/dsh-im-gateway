/**
 * 流式节流器：把高频 text-delta 攒批后按 throttleMs 间隔推送给渠道。
 *
 * 渠道侧支持 streamText（全量覆盖）或 updateCard（遗留单次更新）；
 * 两者都不支持时 push 静默丢弃（由 turn/end 的 sendText 兜底）。
 *
 * @module im-gateway/stream
 */

import type { ImChannelAdapter } from './types'

export class StreamThrottle {
  private readonly pending = new Map<string, { text: string; timer?: ReturnType<typeof setTimeout> }>()

  constructor(private readonly throttleMs: number) {}

  /** 攒批推送一段增量文本。 */
  push(channel: ImChannelAdapter, convId: string, delta: string): void {
    if (!channel.streamText && !channel.updateCard) return
    const entry = this.pending.get(convId) ?? { text: '' }
    entry.text += delta
    if (!entry.timer) {
      entry.timer = setTimeout(() => this.flush(channel, convId), this.throttleMs)
    }
    this.pending.set(convId, entry)
  }

  /** 立即冲刷某会话的缓冲。 */
  flush(channel: ImChannelAdapter, convId: string): void {
    const entry = this.pending.get(convId)
    if (!entry) return
    const text = entry.text
    entry.text = ''
    entry.timer = undefined
    this.pending.set(convId, entry)
    if (!text) return
    if (channel.streamText) void channel.streamText(convId, text)
    else void channel.updateCard?.(convId, text)
  }

  /** 清理所有缓冲（服务卸载时调用）。 */
  dispose(): void {
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
    }
    this.pending.clear()
  }
}