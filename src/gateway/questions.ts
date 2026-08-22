/**
 * 交互提问桥：把 agent 的 ask_user_question 工具调用同步到 IM 渠道，
 * 让用户在 IM 里直接回复选项编号/文字即可作答。
 *
 * 工作原理：
 *  1. 包装 `ctx.userQuestions.ask`：当 agent 提问时，把问题推送到 IM chat
 *  2. IM 侧用户回复 → `answer()` 解析为结构化答案
 *  3. 与 Web 端原始 ask 竞速，第一答生效
 *
 * @module im-gateway/questions
 */

import type {
  AskUserQuestionAnswer,
  AskUserQuestionAnswerItem,
  AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions'
import type { Translator } from './i18n'

/** 答案来源（哪个渠道回答的）。 */
export interface QuestionAnswerSource {
  channelId: string
  conversationId: string
  label?: string
}

/** wait() 的结果：已回答 / Web 端回答 / 超时 / 取消 / 忙（已有 pending）。 */
export type QuestionWaitResult =
  | { kind: 'answered'; answer: AskUserQuestionAnswer; source: QuestionAnswerSource }
  | { kind: 'external'; answer: AskUserQuestionAnswer; source: 'web' }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'busy' }

/** answer() 的结果：已回答 / 无效 / 已答过 / 无 pending。 */
export type QuestionAnswerAttempt =
  | { kind: 'answered'; answer: AskUserQuestionAnswer }
  | { kind: 'invalid'; message: string }
  | { kind: 'already-answered'; message: string }
  | { kind: 'not-pending' }

interface PendingQuestion {
  questions: AskUserQuestionItem[]
  resolve: (result: QuestionWaitResult) => void
  timer: ReturnType<typeof setTimeout>
  signal?: AbortSignal
  onAbort?: () => void
}

interface RecentQuestion {
  questions: AskUserQuestionItem[]
  message: string
  expiresAt: number
}

/**
 * 提问经纪：同一会话只允许一个结构化问题等待；
 * 同步 claim 保证并发首答只有一个赢家。
 */
export class QuestionBroker {
  private readonly pending = new Map<string, PendingQuestion>()
  private readonly recent = new Map<string, RecentQuestion>()
  /** 翻译器（由 ImGatewayService.start() 设置）。 */
  t?: Translator

  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  questionsFor(sessionId: string): AskUserQuestionItem[] | undefined {
    return this.pending.get(sessionId)?.questions
  }

  /**
   * 挂起一个提问，等待 IM 或 Web 端答复。
   * 同 sessionId 已有 pending 时返回 busy（不排队）。
   */
  wait(
    sessionId: string,
    questions: AskUserQuestionItem[],
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<QuestionWaitResult> {
    this.pruneRecent()
    if (this.pending.has(sessionId)) return Promise.resolve({ kind: 'busy' })
    if (signal?.aborted) return Promise.resolve({ kind: 'cancelled' })
    return new Promise((resolve) => {
      const settle = (result: QuestionWaitResult): void => {
        const entry = this.pending.get(sessionId)
        if (!entry) return
        this.pending.delete(sessionId)
        clearTimeout(entry.timer)
        if (entry.signal && entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort)
        resolve(result)
      }
      const timer = setTimeout(() => settle({ kind: 'timeout' }), timeoutMs)
      timer.unref?.()
      const entry: PendingQuestion = { questions, resolve: settle, timer, ...(signal ? { signal } : {}) }
      if (signal) {
        entry.onAbort = () => settle({ kind: 'cancelled' })
        signal.addEventListener('abort', entry.onAbort, { once: true })
      }
      this.pending.set(sessionId, entry)
    })
  }

  /** IM 侧答复。解析文本为结构化答案，成功则 resolve pending。 */
  answer(sessionId: string, text: string, source: QuestionAnswerSource): QuestionAnswerAttempt {
    this.pruneRecent()
    const entry = this.pending.get(sessionId)
    if (!entry) {
      const recent = this.recent.get(sessionId)
      if (recent && looksLikeExplicitReply(recent.questions, text) && parseQuestionReply(recent.questions, text, this.t).ok) {
        return { kind: 'already-answered', message: recent.message }
      }
      return { kind: 'not-pending' }
    }
    const parsed = parseQuestionReply(entry.questions, text, this.t)
    if (!parsed.ok) return { kind: 'invalid', message: parsed.error }
    const summary = formatAnswerSummary(entry.questions, parsed.answer)
    this.remember(sessionId, entry.questions, this.t?.t('q.remember.im', source.label ?? source.channelId, summary) ?? `该提问已由 ${source.label ?? source.channelId} 回答：${summary}`)
    entry.resolve({ kind: 'answered', answer: parsed.answer, source })
    return { kind: 'answered', answer: parsed.answer }
  }

  /** Web 端答复。有 pending 则消费并标记为 external。 */
  finishFromWeb(sessionId: string, answer: AskUserQuestionAnswer): boolean {
    const entry = this.pending.get(sessionId)
    if (!entry) return false
    this.remember(sessionId, entry.questions, this.t?.t('q.remember.web', formatAnswerSummary(entry.questions, answer)) ?? `该提问已在网页端回答：${formatAnswerSummary(entry.questions, answer)}`)
    entry.resolve({ kind: 'external', answer, source: 'web' })
    return true
  }

  /** 取消指定会话的 pending 提问。 */
  cancel(sessionId: string): void {
    this.pending.get(sessionId)?.resolve({ kind: 'cancelled' })
  }

  /** 清理所有 pending 和 recent（服务卸载时调用）。 */
  dispose(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id)
    this.recent.clear()
  }

  private remember(id: string, questions: AskUserQuestionItem[], message: string): void {
    this.recent.set(id, { questions, message, expiresAt: Date.now() + 30_000 })
  }

  private pruneRecent(): void {
    const now = Date.now()
    for (const [id, item] of this.recent) {
      if (item.expiresAt <= now) this.recent.delete(id)
    }
  }
}

/**
 * 格式化提问为 IM 文本：问题 + 选项编号 + 回复说明。
 */
export function formatQuestionPrompt(questions: AskUserQuestionItem[], timeoutSecs: number, t?: Translator): string {
  const tt = t?.t.bind(t) ?? ((k: string, ...a: (string|number)[]) => k)
  const lines = [tt('q.prompt.title', timeoutSecs), '']
  questions.forEach((question, index) => {
    lines.push(`${question.header ? `【${question.header}】` : tt('q.prompt.questionNum', index + 1)} ${question.question}`)
    if (question.detail) lines.push(question.detail)
    for (const [i, option] of (question.options ?? []).entries()) {
      lines.push(`${i + 1}) ${option.label}${option.description ? ` — ${option.description}` : ''}`)
    }
    if (question.multiSelect === true) {
      lines.push(tt('q.prompt.multiHint'))
    } else if ((question.options?.length ?? 0) === 0) {
      lines.push(tt('q.prompt.freeHint'))
    }
    lines.push('')
  })
  if (questions.length === 1) {
    lines.push(tt('q.prompt.singleReply'))
  } else {
    lines.push(tt('q.prompt.multiReply'), '1: 2', '2: 1,3')
  }
  return lines.join('\n').trim()
}

/** 格式化答案摘要（用于回执通知）。 */
export function formatAnswerSummary(questions: AskUserQuestionItem[], answer: AskUserQuestionAnswer): string {
  return answer.answers
    .map((item) => {
      const question = questions.find((candidate) => candidate.id === item.id)
      const value = [...item.selected, ...(item.custom ? [item.custom] : [])].join('、') || '（空）'
      return questions.length === 1 ? value : `${question?.header ?? question?.question ?? item.id}=${value}`
    })
    .join('；')
}

/**
 * 解析 IM 回复文本为结构化答案。
 * 单问题：直接解析；多问题：按「序号: 答案」格式解析。
 */
export function parseQuestionReply(
  questions: AskUserQuestionItem[],
  rawText: string,
  t?: Translator,
): { ok: true; answer: AskUserQuestionAnswer } | { ok: false; error: string } {
  const tt = t?.t.bind(t) ?? ((k: string, ...a: (string|number)[]) => k)
  const text = rawText.trim()
  if (text === '') return { ok: false, error: tt('q.parse.empty') }
  if (questions.length === 1) {
    const parsed = parseOne(questions[0]!, text, tt)
    return parsed.ok ? { ok: true, answer: { answers: [parsed.answer] } } : parsed
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const values = new Map<number, string>()
  for (const line of lines) {
    const match = line.match(/^(\d+)\s*[:：=]\s*(.+)$/)
    if (!match) continue
    const index = Number(match[1]) - 1
    if (index >= 0 && index < questions.length) values.set(index, match[2]!.trim())
  }
  if (values.size === 0 && lines.length === questions.length) {
    lines.forEach((line, index) => values.set(index, line))
  }
  if (values.size !== questions.length) {
    return { ok: false, error: tt('q.parse.countMismatch', questions.length) }
  }
  const answers: AskUserQuestionAnswerItem[] = []
  for (let index = 0; index < questions.length; index += 1) {
    const parsed = parseOne(questions[index]!, values.get(index)!, tt)
    if (!parsed.ok) return { ok: false, error: tt('q.parse.questionError', index + 1, parsed.error) }
    answers.push(parsed.answer)
  }
  return { ok: true, answer: { answers } }
}

/** 判断文本是否像是针对某提问的显式回复（用于已答过的提示）。 */
function looksLikeExplicitReply(questions: AskUserQuestionItem[], rawText: string): boolean {
  const text = rawText.trim()
  if (questions.length > 1) return text.split(/\r?\n/).some((line) => /^\s*\d+\s*[:：=]/.test(line))
  const question = questions[0]
  const options = question?.options ?? []
  if (options.length === 0) return false
  const tokens =
    question?.multiSelect === true
      ? text.split(/[,，、;；]+/).map((token) => token.trim()).filter(Boolean)
      : [text]
  return (
    tokens.length > 0 &&
    tokens.every((token) => {
      const index = /^\d+$/.test(token) ? Number(token) : NaN
      return (
        (Number.isInteger(index) && index >= 1 && index <= options.length) ||
        options.some((option) => option.label.toLocaleLowerCase() === token.toLocaleLowerCase())
      )
    })
  )
}

/** 解析单个问题的答案。 */
function parseOne(
  question: AskUserQuestionItem,
  text: string,
  tt: (k: string, ...a: (string|number)[]) => string = (k) => k,
): { ok: true; answer: AskUserQuestionAnswerItem } | { ok: false; error: string } {
  const value = text.trim()
  if (value === '') return { ok: false, error: tt('q.parse.empty') }
  const options = question.options ?? []
  if (options.length === 0) return { ok: true, answer: { id: question.id, selected: [], custom: value } }
  const labelAt = (token: string): string | undefined => {
    const numeric = token.match(/^\d+$/) ? Number(token) : NaN
    if (Number.isInteger(numeric) && numeric >= 1 && numeric <= options.length) return options[numeric - 1]!.label
    return options.find((option) => option.label.toLocaleLowerCase() === token.toLocaleLowerCase())?.label
  }
  if (question.multiSelect !== true) {
    const label = labelAt(value)
    return label
      ? { ok: true, answer: { id: question.id, selected: [label] } }
      : { ok: true, answer: { id: question.id, selected: [], custom: value } }
  }
  const tokens = value.split(/[,，、;；]+/).map((token) => token.trim()).filter(Boolean)
  const selected: string[] = []
  const custom: string[] = []
  for (const token of tokens) {
    const label = labelAt(token)
    if (label) {
      if (!selected.includes(label)) selected.push(label)
    } else {
      custom.push(token)
    }
  }
  return { ok: true, answer: { id: question.id, selected, ...(custom.length ? { custom: custom.join('，') } : {}) } }
}