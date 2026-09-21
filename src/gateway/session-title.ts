/**
 * IM 会话标题前缀 —— 让来自 IM 的会话在 dsh 会话列表里自带通道标识。
 *
 * ## 为什么只能这样改
 * dsh 会话列表行**直接渲染 title 投影**：
 *   `dsh-client-ui-workspace/lib/client.js`
 *   `function sessionTitle(s) { return s.blank ? "" : s.displayTitle }`
 * 该包的 SlotMap 只声明了 `conversation.hero.workspace.directoryFlow` 与
 * `sidebar.workspaces.directoryFlow` 两个槽，**没有会话行标题 seat** ——
 * 所以「只在 UI 加前缀」做不到，只能改数据。
 *
 * 官方写入口是 `ctx.sessionTitle.rename(session, title)`；官方自己的
 * `dsh-webhook` 插件就是这么给会话命名的（lib/index.js:119）：
 *   `ctx.sessionTitle.rename(handle.agent.session, resolved.title)`
 *
 * ## 两条必须遵守的约束（均来自 dsh-session-title 的实现）
 * 1. **provider 槽位独占**：`SessionTitleService.register()` 只接受一个 provider，
 *    官方 `dsh-session-title-first-prompt-llm` 已占用 —— 插件再注册会抛
 *    `already registered`，所以只能**事后 rename**，不能自己写标题生成器。
 * 2. **rename 会 pin**：它写入的 source 是 `kind:'user'`，会 supersede 掉进行中的
 *    自动生成，且此后用户消息不再触发生成（只有 `refresh()` 能解 pin）。因此
 *    **必须等官方标题（provider / fallback）落地之后**再调用。
 *
 * @module im-gateway/session-title
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'

/**
 * `ctx.sessionTitle` 的最小结构面。
 *
 * 刻意不 import `@deepseek-ai/dsh-session-title`：它是 host 侧服务，本插件不把它
 * 写进 dependencies（避免安装期依赖校验与版本耦合）。运行时探测不到就静默关闭，
 * 插件其余功能不受影响。
 */
interface SessionTitleSnapshot {
  title: string
  source?: { kind?: string }
}

interface SessionTitleServiceLike {
  get(session: Session): SessionTitleSnapshot | undefined
  rename(session: Session, title: string): unknown
}

/** `ctx.get` 的最小结构面（无需 inject 声明的显式服务查找）。 */
interface ContextWithGet {
  get?: (name: string, strict?: boolean) => unknown
}

/**
 * 取 host 服务。
 *
 * **必须用 `ctx.get(name)`，不能用 `ctx.name` 属性访问。** cordis 的 ReflectService
 * proxy trap 对未在本插件 `inject` 里声明的服务名会直接抛
 * `cannot get property "<name>" without inject` —— 属性访问不是「取不到返回
 * undefined」，是**抛异常**。本插件刻意不把 host 服务写进 inject（写进去就等于
 * 该插件在服务缺席时永不激活），所以一律走显式查找；`sessions` 也是同款写法
 * （见 gateway/im-gateway.ts 的 adoptExistingTitle）。
 *
 * 前两条是正常路径，后两条是兜底（个别层级上 `get` 可能不在，属性访问在 root 上
 * 反而合法）。整段不抛错：调用方有事件管线与定时器两条路径，任何一处抛出去都会
 * 变成未捕获异常。
 */
function titleService(ctx: Context): SessionTitleServiceLike | undefined {
  const candidates: Array<() => unknown> = [
    () => (ctx as unknown as ContextWithGet).get?.('sessionTitle'),
    () => (ctx.root as unknown as ContextWithGet).get?.('sessionTitle'),
    () => (ctx as unknown as { sessionTitle?: unknown }).sessionTitle,
    () => (ctx.root as unknown as { sessionTitle?: unknown }).sessionTitle,
  ]
  for (const read of candidates) {
    try {
      const value = read()
      if (value) return value as SessionTitleServiceLike
    } catch {
      // 未 inject 的属性访问会抛错；换下一条路径。
    }
  }
  return undefined
}

/** 「host 未提供 sessionTitle 服务」只提醒一次，避免每回合刷屏。 */
let missingServiceWarned = false

/**
 * 标题是否已带 `[名称] ` 前缀。
 *
 * 用于幂等：同一会话可能被多条路径处理（provider 标题事件、fallback 兜底定时器、
 * 重启后 resume 补前缀），靠文本形态判定，进程重启也不会叠成 `[QQ] [QQ] xxx`。
 * 代价是模型恰好生成了以 `[..]` 开头的标题时会少加一次前缀，可以接受。
 */
export function hasTitlePrefix(title: string): boolean {
  return /^\[[^[\]]{1,40}\] /.test(title)
}

/**
 * 给一个 IM 会话的标题加 `[<label>] ` 前缀（幂等）。
 *
 * @param ctx - host 上下文，用于取 sessionTitle 服务与 logger
 * @param session - 目标 live session
 * @param label - 通道展示名（实例名，未填时为通道类型名）
 * @returns 真正写入返回 true；无标题 / 已有前缀 / 服务不可用 / rename 失败返回 false
 */
export function prefixSessionTitle(ctx: Context, session: Session, label: string): boolean {
  const svc = titleService(ctx)
  if (!svc) {
    if (!missingServiceWarned) {
      missingServiceWarned = true
      ctx.logger.warn(
        '[im-gateway] sessionTitle service unavailable — IM session titles will not carry the channel prefix',
      )
    }
    return false
  }

  let snapshot: SessionTitleSnapshot | undefined
  try {
    snapshot = svc.get(session)
  } catch {
    // 会话尚未建立标题投影（不该发生，但不值得让调用方失败）。
    return false
  }
  const current = snapshot?.title
  if (!current || hasTitlePrefix(current)) return false
  // 用户在 Web 端手动重命名过（source kind === 'user'）→ 尊重他的选择，不覆盖。
  // 兜底定时器可能在用户重命名之后才到点，这一步是防止把用户标题顶掉。
  if (snapshot?.source?.kind === 'user') return false

  try {
    svc.rename(session, `[${label}] ${current}`)
    ctx.logger.info(`[im-gateway] session title prefixed: [${label}] ${current}`)
    return true
  } catch (err) {
    // rename 会拒绝非 live session（store 查不到）或规范化后为空的标题。
    ctx.logger.debug(`[im-gateway] session title prefix skipped: ${String(err)}`)
    return false
  }
}
