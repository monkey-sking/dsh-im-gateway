/**
 * DingTalk AI Card streaming protocol (ported from
 * pi-desk-top/src/main/im/dingtalk/dingtalk-card.ts, itself ported from
 * dingtalk-openclaw-connector, MIT — protocol code only).
 *
 * Lifecycle:
 *   createDingtalkCard() → POST /v1.0/card/instances + /deliver (card instance)
 *   streamDingtalkCard() → PUT /v1.0/card/streaming (incremental content updates)
 *   finishDingtalkCard() → final streaming frame + PUT /v1.0/card/instances (FINISHED)
 *
 * The whole path is rate-limited by a global token bucket (DingTalk caps at
 * ~40 req/s; we stay at 20) with a 2s backoff + one retry on QPS errors.
 *
 * HTTP uses the global fetch (Node >=18); no axios dependency.
 *
 * CRITICAL: every request goes through `cardFetch` which enforces a 10s
 * timeout (AbortController) and checks DingTalk's business error code
 * (HTTP 200 but errcode != 0). WITHOUT the timeout, a hung PUT would leave
 * the gateway's endStream() pending forever — no card finalize AND no plain
 * text fallback, i.e. the agent "replies" but the user sees nothing.
 */

const DINGTALK_API = 'https://api.dingtalk.com'
/** Official DingTalk AI Card template (same as the reference project). */
const AI_CARD_TEMPLATE_ID = '02fcf2f4-5e02-4a85-b672-46d1f715543e.schema'
const CARD_API_MAX_QPS = 20
const QPS_BACKOFF_DURATION_MS = 2_000
const TOKEN_EXPIRE_MS = 2 * 60 * 60 * 1000 // DingTalk access token TTL
/** Hard cap per card API request — a hang must become a rejection. */
const CARD_REQUEST_TIMEOUT_MS = 10_000

/** Card flow status codes (DingTalk AI Card protocol). */
const AICardStatus = {
  PROCESSING: '1',
  INPUTING: '2',
  FINISHED: '3',
  EXECUTING: '4',
  FAILED: '5',
} as const

export interface AICardTarget {
  type: 'user' | 'group'
  /** userId for user DMs, openConversationId for groups. */
  targetId: string
}

export interface AICardInstance {
  cardInstanceId: string
  accessToken: string
  tokenExpireTime: number
  inputingStarted: boolean
}

interface DingtalkCardCredentials {
  clientId: string
  clientSecret: string
}

// ── token cache (same pattern as the reference) ──
const tokenCache = new Map<string, { token: string; expiryMs: number }>()

async function getAccessToken(cfg: DingtalkCardCredentials): Promise<string> {
  const key = cfg.clientId
  const cached = tokenCache.get(key)
  if (cached && cached.expiryMs > Date.now() + 60_000) return cached.token
  const data = await cardFetch(`${DINGTALK_API}/v1.0/oauth2/accessToken`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: cfg.clientId, appSecret: cfg.clientSecret }),
  })
  const token = data?.accessToken as string | undefined
  if (!token) throw new Error(`dingtalk card accessToken missing: ${JSON.stringify(data).slice(0, 200)}`)
  const expireInSec = Number(data?.expireIn ?? 0) || 7200
  tokenCache.set(key, { token, expiryMs: Date.now() + expireInSec * 1000 })
  return token
}

// ── global token bucket (QPS guard, shared across all cards) ──
class TokenBucket {
  private tokens = CARD_API_MAX_QPS
  private lastRefill = Date.now()
  private backoffUntil = 0

  async waitForToken(): Promise<void> {
    for (;;) {
      const now = Date.now()
      if (now < this.backoffUntil) {
        await sleep(this.backoffUntil - now)
        continue
      }
      const elapsed = (now - this.lastRefill) / 1000
      this.tokens = Math.min(CARD_API_MAX_QPS, this.tokens + elapsed * CARD_API_MAX_QPS)
      this.lastRefill = now
      if (this.tokens >= 1) {
        this.tokens -= 1
        return
      }
      const waitMs = Math.ceil(((1 - this.tokens) / CARD_API_MAX_QPS) * 1000)
      await sleep(waitMs)
    }
  }

  triggerBackoff(): void {
    this.backoffUntil = Date.now() + QPS_BACKOFF_DURATION_MS
    this.tokens = 0
  }
}

const cardRateLimiter = new TokenBucket()

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function isQpsLimitError(err: any): boolean {
  const msg = `${err?.message ?? ''} ${err?.errmsg ?? ''} ${err?.code ?? ''}`.toLowerCase()
  return msg.includes('qps') || msg.includes('rate limit') || msg.includes('too many')
}

/**
 * fetch wrapper for every card API call. Guarantees:
 *  1. 10s hard timeout — a hung request rejects instead of hanging forever
 *     (the caller's catch then triggers the plain-text fallback).
 *  2. Business error detection — DingTalk often returns HTTP 200 with
 *     `errcode`/`errorCode` != 0; a bare `res.ok` check would treat a failed
 *     FINISHED as success and leave the card spinning forever.
 * Returns the parsed JSON body.
 */
async function cardFetch(url: string, init: RequestInit): Promise<any> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CARD_REQUEST_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: controller.signal })
  } catch (err: any) {
    clearTimeout(timer)
    if (err?.name === 'AbortError') {
      const e = new Error(`card api timeout after ${CARD_REQUEST_TIMEOUT_MS}ms: ${url}`) as any
      e.timeout = true
      throw e
    }
    throw err
  }
  clearTimeout(timer)

  let data: any = null
  try {
    data = await res.json()
  } catch {
    /* non-JSON body — fall through to the HTTP status check */
  }
  // Business error: HTTP 200 but errcode/errorCode != 0.
  const errcode = data?.errcode ?? data?.errorCode
  if (!res.ok || (errcode !== undefined && errcode !== null && Number(errcode) !== 0)) {
    const err: any = new Error(
      `card api HTTP ${res.status} errcode ${errcode}: ${data?.errmsg ?? data?.message ?? ''}`.slice(0, 300),
    )
    err.status = res.status
    err.code = String(errcode)
    err.errmsg = data?.errmsg ?? data?.message
    throw err
  }
  return data
}

function buildDeliverBody(cardInstanceId: string, target: AICardTarget, robotCode: string): any {
  const base = { outTrackId: cardInstanceId, userIdType: 1 }
  if (target.type === 'group') {
    return {
      ...base,
      openSpaceId: `dtv1.card//IM_GROUP.${target.targetId}`,
      imGroupOpenDeliverModel: { robotCode },
    }
  }
  return {
    ...base,
    openSpaceId: `dtv1.card//IM_ROBOT.${target.targetId}`,
    imRobotOpenDeliverModel: {
      spaceType: 'IM_ROBOT',
      robotCode,
      extension: { dynamicSummary: 'true' },
    },
  }
}

/** Create a card instance and deliver it to the target. */
export async function createDingtalkCard(
  cfg: DingtalkCardCredentials,
  target: AICardTarget,
): Promise<AICardInstance | null> {
  try {
    const token = await getAccessToken(cfg)
    const cardInstanceId = `card_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`

    const createBody = {
      cardTemplateId: AI_CARD_TEMPLATE_ID,
      outTrackId: cardInstanceId,
      cardData: {
        cardParamMap: {
          config: JSON.stringify({ autoLayout: true }),
        },
      },
      callbackType: 'STREAM',
      imGroupOpenSpaceModel: { supportForward: true },
      imRobotOpenSpaceModel: { supportForward: true },
    }
    await cardFetch(`${DINGTALK_API}/v1.0/card/instances`, {
      method: 'POST',
      headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(createBody),
    })

    const deliverBody = buildDeliverBody(cardInstanceId, target, String(cfg.clientId ?? ''))
    await cardFetch(`${DINGTALK_API}/v1.0/card/instances/deliver`, {
      method: 'POST',
      headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(deliverBody),
    })

    return {
      cardInstanceId,
      accessToken: token,
      tokenExpireTime: Date.now() + TOKEN_EXPIRE_MS,
      inputingStarted: false,
    }
  } catch (err: any) {
    console.error(`[im:dingtalk] AI Card create failed:`, err?.message ?? err)
    return null
  }
}

async function ensureValidToken(card: AICardInstance, cfg: DingtalkCardCredentials): Promise<string> {
  if (Date.now() > card.tokenExpireTime - 5 * 60 * 1000) {
    const newToken = await getAccessToken(cfg)
    card.accessToken = newToken
    card.tokenExpireTime = Date.now() + TOKEN_EXPIRE_MS
  }
  return card.accessToken
}

async function putWithRetry(url: string, body: any, token: string): Promise<void> {
  await cardRateLimiter.waitForToken()
  try {
    await cardFetch(url, {
      method: 'PUT',
      headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (err: any) {
    if (isQpsLimitError(err)) {
      cardRateLimiter.triggerBackoff()
      await cardRateLimiter.waitForToken()
      await cardFetch(url, {
        method: 'PUT',
        headers: { 'x-acs-dingtalk-access-token': token, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    } else {
      throw err
    }
  }
}

/** Incrementally update the card content (finished=true finalizes the text). */
export async function streamDingtalkCard(
  card: AICardInstance,
  content: string,
  finished: boolean = false,
  cfg?: DingtalkCardCredentials,
): Promise<void> {
  if (!card) return
  if (cfg) await ensureValidToken(card, cfg)

  if (!card.inputingStarted) {
    await cardRateLimiter.waitForToken()
    const statusBody = {
      outTrackId: card.cardInstanceId,
      cardData: {
        cardParamMap: {
          flowStatus: AICardStatus.INPUTING,
          msgContent: content,
          staticMsgContent: '',
          sys_full_json_obj: JSON.stringify({ order: ['msgContent'] }),
          config: JSON.stringify({ autoLayout: true }),
        },
      },
    }
    try {
      await cardFetch(`${DINGTALK_API}/v1.0/card/instances`, {
        method: 'PUT',
        headers: { 'x-acs-dingtalk-access-token': card.accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify(statusBody),
      })
    } catch (err: any) {
      if (isQpsLimitError(err)) {
        cardRateLimiter.triggerBackoff()
        await cardRateLimiter.waitForToken()
        await cardFetch(`${DINGTALK_API}/v1.0/card/instances`, {
          method: 'PUT',
          headers: { 'x-acs-dingtalk-access-token': card.accessToken, 'Content-Type': 'application/json' },
          body: JSON.stringify(statusBody),
        })
      } else {
        throw err
      }
    }
    card.inputingStarted = true
  }

  const fixedContent = content
  const streamContent = finished ? fixedContent : fixedContent.replace(/\n+$/, '')
  const body = {
    outTrackId: card.cardInstanceId,
    guid: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    key: 'msgContent',
    content: streamContent,
    isFull: true,
    isFinalize: finished,
    isError: false,
  }
  await putWithRetry(`${DINGTALK_API}/v1.0/card/streaming`, body, card.accessToken)
}

/** Finalize the card (FINISHED status — removes the loading animation). */
export async function finishDingtalkCard(
  card: AICardInstance,
  content: string,
  cfg?: DingtalkCardCredentials,
  /** Skip the streaming finalize frame (PUT /card/streaming with
   *  isFinalize=true). That endpoint caps a single content frame at ~1K;
   *  long replies would be truncated with "***". Skipping it lets the
   *  FINISHED PUT below carry the full text directly. */
  skipStreamFinalize: boolean = false,
): Promise<void> {
  if (!card) return
  if (cfg) await ensureValidToken(card, cfg)
  const fixedContent = content

  if (!skipStreamFinalize) {
    await streamDingtalkCard(card, fixedContent, true, cfg)
  }

  const body = {
    outTrackId: card.cardInstanceId,
    cardData: {
      cardParamMap: {
        flowStatus: AICardStatus.FINISHED,
        msgContent: fixedContent,
        staticMsgContent: '',
        sys_full_json_obj: JSON.stringify({ order: ['msgContent'] }),
        config: JSON.stringify({ autoLayout: true }),
      },
    },
    cardUpdateOptions: { updateCardDataByKey: true },
  }
  await putWithRetry(`${DINGTALK_API}/v1.0/card/instances`, body, card.accessToken)
}
