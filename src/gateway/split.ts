/**
 * 长文本分片：按渠道单条上限切分，优先在换行/中文句号/句点处断行，
 * 分段前缀 `（i/n）` 或 `(i/n)` 的字符数参与递归收敛（不会出现「第 3/2 段」）。
 *
 * @module im-gateway/split
 */

import type { Lang } from './i18n'
import { breakChars } from './i18n'

const PREFIX_RE = /^[（(]\d+\/\d+[）)]/

/** 构造分段前缀。 */
function makePrefix(index: number, total: number, lang: Lang): string {
  if (total <= 1) return ''
  return lang === 'en' ? `(${index}/${total})` : `（${index}/${total}）`
}

/** 计算带前缀的段文本；前缀长度递归收敛进上限。 */
function withPrefix(index: number, total: number, text: string, max: number, lang: Lang): string {
  const prefix = makePrefix(index, total, lang)
  if (prefix.length >= max) return text
  const budget = max - prefix.length
  const body = [...text].slice(0, budget).join('')
  return prefix + body
}

/**
 * 把文本切分为不超过 max 码点的片段序列。
 * 断点优先级：换行 → 中文句号（。！？…；）→ 英文句点+空格 → 硬切。
 */
export function splitText(text: string, max: number, lang: Lang = 'zh'): string[] {
  if (max <= 0) return text === '' ? [] : [text]
  const chars = [...text]
  if (chars.length === 0) return []
  if (chars.length <= max) return [text]

  const parts: string[] = []
  let rest = chars
  let index = 1
  let total = Math.ceil(chars.length / max)
  while (rest.length > 0) {
    const budget = max - makePrefix(index, total, lang).length
    if (budget <= 0) {
      parts.push(rest.slice(0, max).join(''))
      rest = rest.slice(max)
      index += 1
      continue
    }
    const window = rest.slice(0, budget)
    const cut = findBreak(window, lang)
    const piece = rest.slice(0, cut === 0 ? budget : cut).join('')
    if (piece.length > 0) {
      parts.push(withPrefix(index, total, piece, max, lang))
      rest = rest.slice(piece.length)
      index += 1
    } else {
      parts.push(withPrefix(index, total, window.join(''), max, lang))
      rest = rest.slice(window.length)
      index += 1
    }
  }
  if (parts.length !== total && parts.length > 1) {
    return rePrefix(parts, max, lang)
  }
  return parts
}

/** 在窗口内找最优断点，返回断点前的长度；0 = 无自然断点。 */
function findBreak(window: string[], lang: Lang): number {
  for (let i = window.length - 1; i >= 0; i -= 1) {
    if (window[i] === '\n') return i + 1
  }
  for (let i = window.length - 1; i >= 0; i -= 1) {
    if (breakChars[lang].includes(window[i] ?? '')) return i + 1
  }
  for (let i = window.length - 2; i >= 0; i -= 1) {
    if (window[i] === '.' && window[i + 1] === ' ') return i + 1
    if (window[i] === ',' && window[i + 1] === ' ') return i + 1
  }
  return 0
}

/** 按真实段数重算前缀。 */
function rePrefix(parts: string[], max: number, lang: Lang): string[] {
  const total = parts.length
  return parts.map((raw, i) => {
    const index = i + 1
    const prefix = makePrefix(index, total, lang)
    const body = [...raw].join('')
    if ((body.startsWith('（') || body.startsWith('(')) && PREFIX_RE.test(body.slice(0, 12))) {
      const m = body.match(PREFIX_RE)
      if (m) return prefix + [...body.slice(m[0].length)].slice(0, max - prefix.length).join('')
    }
    return prefix + [...body].slice(0, max - prefix.length).join('')
  })
}