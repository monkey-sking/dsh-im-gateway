/**
 * 飞书 CardKit 流式卡片 —— 协议层。
 *
 * 与 `dingtalk-card.ts` 职责对齐：本文件只做「建卡 / 流式更新 / 关流式 /
 * 全量替换」的无状态 API 调用与卡片 JSON 构造，序列号（sequence）与会话
 * 状态由 `feishu.ts` 的适配器持有。
 *
 * 为什么必须用卡片：
 *   飞书 **没有** 原生 typing / 逐字流式气泡（对照参考项目 openclaw-lark）。
 *   要实现「打字机」效果只能走 CardKit：先 `card.create` 建一张卡片实体
 *   （`config.streaming_mode: true`），用 `im.message` 把 card_id 发出去，
 *   之后反复调 `cardElement.content` 更新同一个元素 —— 飞书会自动 diff
 *   新旧内容并播放增量动画；结束后 `card.settings` 关流式 + `card.update`
 *   落到最终态。
 *
 * 权限前提（缺失则整条流式链路失效，见 feishu-register.ts 的 addons）：
 *   `cardkit:card:write`。
 *
 * 已知服务端限制（对照参考项目的错误处理）：
 *   - `230020` 更新过快 → 丢帧重试即可，不算失败；
 *   - `230099` / `11310` 卡片内表格数量超限 → 必须放弃流式，退回纯文本，
 *     否则后续每次更新都会失败。
 */
import type * as Lark from '@larksuiteoapi/node-sdk'

/**
 * 流式更新的目标元素 id。`cardElement.content()` 按此 id 定位到卡片里那块
 * markdown 区域，做增量 diff —— 改名等于换一块区域渲染。
 */
export const FEISHU_STREAMING_ELEMENT_ID = 'streaming_content'

/** 飞书卡片更新过快（丢帧即可，非致命）。 */
const CODE_RATE_LIMITED = 230020
/** 卡片内表格数量超出限制（两种回报形态）。 */
const CODE_TABLE_LIMIT = 230099
const CODE_TABLE_LIMIT_ALT = 11310

/** summary（会话列表预览）截断长度。 */
const SUMMARY_MAX_CHARS = 120

/** 从飞书 SDK 错误里提取业务码（SDK 抛错与返回体两种形态都覆盖）。 */
export function cardErrorCode(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const e = err as { code?: unknown; response?: { data?: { code?: unknown } } }
  const raw = e.code ?? e.response?.data?.code
  if (typeof raw === 'number') return raw
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw)
  return undefined
}

/** 更新过快：跳过本帧，流式继续。 */
export function isCardRateLimited(err: unknown): boolean {
  return cardErrorCode(err) === CODE_RATE_LIMITED
}

/** 卡片表格超限：必须整体放弃 CardKit 流式（否则每帧都会失败）。 */
export function isCardTableLimit(err: unknown): boolean {
  const code = cardErrorCode(err)
  return code === CODE_TABLE_LIMIT || code === CODE_TABLE_LIMIT_ALT
}

/** summary 用纯文本（去掉 markdown 记号），供会话列表预览。 */
function summaryOf(text: string): { content: string } {
  const plain = text.replace(/[*_`#>~[\]]/g, '').replace(/\s+/g, ' ').trim()
  return { content: plain.slice(0, SUMMARY_MAX_CHARS) || '处理中…' }
}

/**
 * 流式态卡片（CardKit 2.0）。
 *
 * `config.streaming_mode: true` 打开流式渲染开关；正文那块 markdown 带
 * `element_id`，后续 `cardElement.content` 就更新它。
 */
export function buildStreamingCard(text: string): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      streaming_mode: true,
      locales: ['zh_cn', 'en_us'],
      summary: summaryOf(text),
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: text,
          element_id: FEISHU_STREAMING_ELEMENT_ID,
          text_align: 'left',
          text_size: 'normal_v2',
          margin: '0px 0px 0px 0px',
        },
      ],
    },
  }
}

/** 终态卡片：不带 streaming_mode，飞书不再播放增量动画。 */
export function buildFinalCard(text: string): Record<string, unknown> {
  return {
    schema: '2.0',
    config: {
      locales: ['zh_cn', 'en_us'],
      summary: summaryOf(text),
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: text,
          element_id: FEISHU_STREAMING_ELEMENT_ID,
          text_align: 'left',
          text_size: 'normal_v2',
          margin: '0px 0px 0px 0px',
        },
      ],
    },
  }
}

/**
 * 飞书 SDK 对非 0 code 的返回体不一定抛错，故两种形态都要拦。
 * 抛出的错误带上 `code`，交由 `isCardRateLimited` / `isCardTableLimit` 分类。
 */
function assertCardOk(resp: unknown, api: string): void {
  const r = resp as { code?: number; msg?: string } | undefined
  if (r && typeof r.code === 'number' && r.code !== 0) {
    const err = new Error(`cardkit ${api} failed: ${r.code} ${r.msg ?? ''}`) as Error & { code?: number }
    err.code = r.code
    throw err
  }
}

/** 建卡片实体，返回 card_id（失败返回 null —— 调用方退回纯文本）。 */
export async function createCardEntity(
  client: Lark.Client,
  card: Record<string, unknown>,
): Promise<string | null> {
  const resp = (await client.cardkit.v1.card.create({
    data: { type: 'card_json', data: JSON.stringify(card) },
  })) as { code?: number; msg?: string; data?: { card_id?: string }; card_id?: string }

  const cardId = resp?.data?.card_id ?? resp?.card_id ?? null
  assertCardOk(resp, 'card.create')
  return cardId ?? null
}

/**
 * 流式更新正文元素。`content` 是**全量累积文本**（不是增量），飞书负责 diff。
 * `sequence` 必须单调递增，否则服务端拒收。
 */
export async function streamCardContent(
  client: Lark.Client,
  cardId: string,
  elementId: string,
  content: string,
  sequence: number,
): Promise<void> {
  const resp = (await client.cardkit.v1.cardElement.content({
    data: { content, sequence },
    path: { card_id: cardId, element_id: elementId },
  })) as { code?: number; msg?: string }
  assertCardOk(resp, 'cardElement.content')
}

/** 全量替换整张卡片（终态）。 */
export async function updateCardKitCard(
  client: Lark.Client,
  cardId: string,
  card: Record<string, unknown>,
  sequence: number,
): Promise<void> {
  const resp = (await client.cardkit.v1.card.update({
    data: { card: { type: 'card_json', data: JSON.stringify(card) }, sequence },
    path: { card_id: cardId },
  })) as { code?: number; msg?: string }
  assertCardOk(resp, 'card.update')
}

/**
 * 开关流式模式。结束前必须关掉，否则卡片会一直保持「正在生成」的视觉状态
 * （转发/互动回调等常规行为也不恢复）。
 */
export async function setCardStreamingMode(
  client: Lark.Client,
  cardId: string,
  streamingMode: boolean,
  sequence: number,
): Promise<void> {
  const resp = (await client.cardkit.v1.card.settings({
    data: { settings: JSON.stringify({ streaming_mode: streamingMode }), sequence },
    path: { card_id: cardId },
  })) as { code?: number; msg?: string }
  assertCardOk(resp, 'card.settings')
}

/** 引用卡片消息的 content 形态：IM 消息只持有 card_id 的引用。 */
export function cardMessageContent(cardId: string): string {
  return JSON.stringify({ type: 'card', data: { card_id: cardId } })
}
