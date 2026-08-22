/**
 * 手机多段输入合并：用户在 IM 里长按输入会拆成多条短消息。
 *
 * 规则：
 * - 结尾 `..`：还有后续，先别提交（buffered）
 * - 结尾 `!!`：说完了，立即提交（flushed）
 * - 裸文本：进入 mergeTimeoutSecs 合并窗口，窗口内追加，超时提交
 *
 * @module im-gateway/merge
 */

export interface MergerOptions {
  mergeTimeoutMs: number
  onSnapshot?: (key: string, buffer: string) => void
  onFlush: (key: string, text: string) => void | Promise<void>
}

export interface MergeResult {
  kind: 'buffered' | 'flushed' | 'ignored'
  text?: string
}

const CONTINUE_SUFFIX = '..'
const COMMIT_SUFFIX = '!!'

/** 去掉末尾的 `..` / `!!` 控制后缀。 */
export function stripControlSuffix(text: string): { text: string; control: 'continue' | 'commit' | 'none' } {
  if (text.endsWith(COMMIT_SUFFIX)) return { text: text.slice(0, -COMMIT_SUFFIX.length), control: 'commit' }
  if (text.endsWith(CONTINUE_SUFFIX)) return { text: text.slice(0, -CONTINUE_SUFFIX.length), control: 'continue' }
  return { text, control: 'none' }
}

/**
 * 会话合并器：按 key（channelId:conversationId）维护缓冲，
 * 支持多会话并发，超时自动提交。
 */
export class SessionMerger {
  private readonly buffers = new Map<string, { text: string; timer: ReturnType<typeof setTimeout> }>()
  private readonly options: MergerOptions

  constructor(options: MergerOptions) {
    this.options = options
  }

  /**
   * 摄入一段文本。返回：
   * - `{ kind: 'buffered' }` — 已进合并窗口，等待后续
   * - `{ kind: 'flushed', text }` — 合并完成，应提交给 agent
   * - `{ kind: 'ignored' }` — 空白或纯控制符
   */
  ingest(key: string, raw: string): MergeResult {
    const { text, control } = stripControlSuffix(raw)
    if (text.trim() === '' && control === 'none') return { kind: 'ignored' }

    if (control === 'continue') {
      const existing = this.buffers.get(key)
      const merged = existing ? `${existing.text}${text}` : text
      this.setBuffer(key, merged)
      return { kind: 'buffered' }
    }

    const existing = this.buffers.get(key)
    if (existing) {
      this.clear(key)
      const merged = `${existing.text}${text}`
      if (control === 'commit') {
        return { kind: 'flushed', text: merged }
      }
      return { kind: 'flushed', text: merged }
    }

    if (control === 'commit') {
      return { kind: 'flushed', text }
    }

    // 无缓冲 + 裸文本：开窗口，等待后续或超时
    this.setBuffer(key, text)
    return { kind: 'buffered' }
  }

  /** 恢复崩溃前的缓冲（last_update=now，超时后即提交）。 */
  restore(key: string, buffer: string): void {
    this.setBuffer(key, buffer)
  }

  /** 立即提交某 key 的缓冲（如 /new 前），返回提交的文本。 */
  flush(key: string): string | undefined {
    const entry = this.buffers.get(key)
    if (!entry) return undefined
    this.clear(key)
    return entry.text
  }

  /** 全部缓冲的快照（落盘用）。 */
  snapshots(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [key, entry] of this.buffers) out[key] = entry.text
    return out
  }

  /** 清理所有缓冲（服务卸载时调用）。 */
  dispose(): void {
    for (const key of [...this.buffers.keys()]) this.clear(key)
  }

  private setBuffer(key: string, text: string): void {
    this.clear(key)
    const timer = setTimeout(() => {
      this.clear(key)
      void this.options.onFlush(key, text)
    }, this.options.mergeTimeoutMs)
    timer.unref?.()
    this.buffers.set(key, { text, timer })
    this.options.onSnapshot?.(key, text)
  }

  private clear(key: string): void {
    const entry = this.buffers.get(key)
    if (entry) {
      clearTimeout(entry.timer)
      this.buffers.delete(key)
    }
  }
}