/**
 * 审批应答经纪：IM 里的「批准 / 拒绝」→ approval/request waterfall 的等待结果。
 *
 * 当 agent 调用需要审批的工具时，dsh-user-approval 通过 `approval/request`
 * 事件征询答案。本桥把请求挂起并推送到 IM 会话，等待用户在 IM 里回复
 * 「批准」或「拒绝」。支持多 pending（不同会话可并发审批），按 session id 路由。
 *
 * @module im-gateway/approval
 */

/** 审批结论：allow=放行一次，reject=拒绝，undefined=超时/撤回（委托下游）。 */
export type ApprovalVerdict = 'allow' | 'reject' | undefined

interface Pending {
  resolve: (v: ApprovalVerdict) => void
  timer: ReturnType<typeof setTimeout>
}

export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>()

  get size(): number {
    return this.pending.size
  }

  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  /**
   * 挂起一个批准请求，等待 IM 答复。
   * 同 sessionId 已有 pending 时立即返回 undefined（不排队，直接委托下游 answerer）。
   * signal 中止（提问方撤回）也返回 undefined。
   */
  wait(sessionId: string, timeoutMs: number, signal?: AbortSignal): Promise<ApprovalVerdict> {
    if (this.pending.has(sessionId)) return Promise.resolve(undefined)
    return new Promise((resolve) => {
      const settle = (v: ApprovalVerdict) => {
        const entry = this.pending.get(sessionId)
        if (!entry) return
        clearTimeout(entry.timer)
        this.pending.delete(sessionId)
        resolve(v)
      }
      const timer = setTimeout(() => settle(undefined), timeoutMs)
      timer.unref?.()
      this.pending.set(sessionId, { resolve: settle, timer })
      signal?.addEventListener('abort', () => settle(undefined), { once: true })
    })
  }

  /** IM 侧答复。没有 pending 返回 false。 */
  answer(sessionId: string, allow: boolean): boolean {
    const entry = this.pending.get(sessionId)
    if (!entry) return false
    entry.resolve(allow ? 'allow' : 'reject')
    return true
  }

  /** 清理所有 pending（服务卸载时调用）。 */
  dispose(): void {
    for (const key of [...this.pending.keys()]) {
      const entry = this.pending.get(key)
      // 直接 resolve：settle 内部会清理 pending 表（先 resolve 后 delete，顺序敏感）
      if (entry) entry.resolve(undefined)
    }
  }
}