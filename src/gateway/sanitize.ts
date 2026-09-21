/**
 * 出站文本清洗：剥离不应出现在 IM 消息里的内部内容。
 *
 * dsh 的会话事件里可能混入框架脚手架块（`<system-reminder>`、`<previous_response>`）
 * 与模型推理块（deepseek 的 `` `think` … `/think` ``、claude 的 `<thinking>`），
 * 直接转发到 QQ/钉钉会污染用户可见的输出。这里统一清洗，同时保留 Markdown/HTML
 * 供 QQ Bot 的 Markdown 渲染使用。
 *
 * 移植自参考项目 openclaw-qqbot/src/outbound/sanitize.ts。
 *
 * @module im-gateway/sanitize
 */

const INTERNAL_TAGS: RegExp[] = [
  // 框架脚手架块（整体删除，含内部内容）
  /<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi,
  /<previous_response\b[^>]*>[\s\S]*?<\/previous_response>/gi,
  // 残留的孤立开闭标签
  /<\s*\/?\s*(?:system-reminder|previous_response)\b[^>]*\/?\s*>/gi,
  // deepseek 推理块：反引号作定界符 —— `think` … `/think`
  /`think`[\s\S]*?`\/think`/gi,
  /<\s*\/?\s*think\b[^>]*\/?\s*>/gi,
  // claude 推理块：<thinking>…</thinking>
  /<thinking\b[^>]*>[\s\S]*?<\/thinking>/gi,
  /<\s*\/?\s*thinking\b[^>]*\/?\s*>/gi,
]

/**
 * 清洗出站文本。返回的文本已 trim；输入为空时返回空串。
 * 幂等：对已清洗文本再调用不会产生变化。
 */
export function sanitizeOutboundText(text: string): string {
  if (!text) return ''
  let result = text
  for (const re of INTERNAL_TAGS) {
    result = result.replace(re, '')
  }
  return result.trim()
}
