/**
 * 流式节流器：把高频 text-delta 攒批后按 throttleMs 间隔推送给渠道。
 *
 * 语义是**累积全文覆盖**：`push()` 收到的是增量片段，内部累加；`flush()`
 * 推给渠道的是「到目前为止的全文」，并且**不清空**累积 —— 下一批继续在同
 * 一份全文上追加。于是渠道每一帧拿到的都是一份完整、单调增长的内容。
 *
 * 为什么必须传全文（而不是本批增量）：三家渠道的流式 API 都要求全量覆盖 ——
 *   - QQ `stream_messages` 是 append-only，新帧必须是旧帧的前缀扩展；
 *   - 钉钉 AI Card 走 `isFull: true`；
 *   - 飞书 CardKit `cardElement.content` 文档明确要求全量文本而非 delta。
 *
 * 早先的实现在 `flush()` 里 `entry.text = ''` 清空累积，推出去的是「本批增量」，
 * 只有在一轮恰好只产生一条 assistant 消息时才碰巧正确。接入真正的逐字流之后
 * 这个矛盾会立刻暴露：QQ 收到非前缀扩展的碎片帧会直接失败并禁用流式，钉钉 /
 * 飞书卡片则只剩下最后一批字符。
 *
 * 新回合开始时调用 `reset()` 清零累积。
 *
 * @module im-gateway/stream
 */

import type { ImChannelAdapter } from './types'

export class StreamThrottle {
  private readonly pending = new Map<string, { text: string; timer?: ReturnType<typeof setTimeout> }>()

  constructor(private readonly throttleMs: number) {}

  /** 丢弃某会话的累积全文（新回合开始 / 会话销毁时调用）。 */
  reset(convId: string): void {
    const entry = this.pending.get(convId)
    if (entry?.timer) clearTimeout(entry.timer)
    this.pending.delete(convId)
  }

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

  /**
   * 立即把「当前累积的全文」推给渠道。
   *
   * 不清空累积：下一次 push 会在这份全文之上继续追加，保证每帧都是
   * 前一次的真前缀扩展（QQ 的 append-only 约束）。
   */
  flush(channel: ImChannelAdapter, convId: string): void {
    const entry = this.pending.get(convId)
    if (!entry) return
    entry.timer = undefined
    if (!entry.text) return
    if (channel.streamText) void channel.streamText(convId, entry.text)
    else void channel.updateCard?.(convId, entry.text)
  }

  /** 清理所有缓冲（服务卸载时调用）。 */
  dispose(): void {
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer)
    }
    this.pending.clear()
  }
}
