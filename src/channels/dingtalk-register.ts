/**
 * DingTalk bot QR-scan creation — the official device-code registration flow.
 *
 * Unlike QQ/WeChat which bind an EXISTING account, DingTalk's
 * `/app/registration/*` endpoint (oapi.dingtalk.com) lets the official backend
 * CREATE a brand-new bot on our behalf when the user scans the QR in the
 * DingTalk app. The poll returns the freshly-created bot's credentials
 * (clientId/clientSecret), with AI-card & message permissions pre-provisioned —
 * no need to create/apply manually on the DingTalk Open Platform.
 *
 * Mirrors the ping-desk-top reference
 * (`dingtalk-openclaw-connector/src/device-auth.ts`): init → begin → poll,
 * rendered into a QR like `qq-login.ts` does inside the same snapshot model
 * the settings UI already polls via Remote.
 */
import { randomUUID } from 'node:crypto'
import QRCode from 'qrcode'

/** Snapshot returned to the caller (settings UI via Remote). */
export interface DingtalkRegisterStatus {
  loginId: string
  status: 'running' | 'confirmed' | 'error' | 'canceled' | 'expired'
  /** QR image as data URL (what the UI shows in <img>). */
  qrcodeUrl: string
  /** Raw QR content URL (fallback link). */
  qrcode: string
  message: string
  /** Set when status === "confirmed". */
  credentials?: { clientId: string; clientSecret: string }
}

interface ActiveLogin {
  loginId: string
  status: DingtalkRegisterStatus['status']
  qrcodeUrl: string
  qrcode: string
  message: string
  startedAt: number
  /** Stop the background poll timer. */
  stop?: () => void
  clientId?: string
  clientSecret?: string
}

const logins = new Map<string, ActiveLogin>()

/** Configurable registration base URL — defaults to the official OAPI host. */
const BASE_URL =
  (process.env.DINGTALK_REGISTRATION_BASE_URL ?? '').trim() || 'https://oapi.dingtalk.com'
/** Marks the calling context to the official registration backend. */
const SOURCE = 'DING_DWS_CLAW'

/** POST JSON and assert the DingTalk envelope (errcode === 0). */
async function post<T extends Record<string, unknown>>(
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = (await res.json()) as (T & { errcode: number; errmsg?: string }) | undefined
  if (!data || data.errcode !== 0) {
    throw new Error(data?.errmsg || `[${path}] unknown error (errcode=${data?.errcode ?? 'N/A'})`)
  }
  return data as T
}

function snapshot(l: ActiveLogin): DingtalkRegisterStatus {
  const s: DingtalkRegisterStatus = {
    loginId: l.loginId,
    status: l.status,
    qrcodeUrl: l.qrcodeUrl,
    qrcode: l.qrcode,
    message: l.message,
  }
  if (l.status === 'confirmed' && l.clientId && l.clientSecret) {
    s.credentials = { clientId: l.clientId, clientSecret: l.clientSecret }
  }
  return s
}

/** Purge stale (non-running) logins so the map never grows unbounded. */
function purgeStale(): void {
  const now = Date.now()
  for (const [id, l] of logins) {
    if (l.status !== 'running' && now - l.startedAt > 5 * 60_000) {
      logins.delete(id)
    }
  }
}

/**
 * Kick off a DingTalk bot registration. Returns immediately with a login id;
 * a background timer polls the official backend until the user's QR scan is
 * confirmed, then the UI polls getLoginStatus() for the final snapshot.
 */
export async function startLogin(): Promise<DingtalkRegisterStatus> {
  purgeStale()
  const loginId = randomUUID()

  // 1. init → nonce
  const init = await post<{ nonce?: string }>('/app/registration/init', { source: SOURCE })
  const nonce = String(init.nonce ?? '').trim()
  if (!nonce) throw new Error('[dingtalk-register] init: missing nonce')

  // 2. begin → device_code + verification URL (the QR content)
  const begin = await post<{
    device_code?: string
    verification_uri_complete?: string
    expires_in?: number
    interval?: number
  }>('/app/registration/begin', { nonce })
  const deviceCode = String(begin.device_code ?? '').trim()
  const verifyUrl = String(begin.verification_uri_complete ?? '').trim()
  if (!deviceCode || !verifyUrl) {
    throw new Error('[dingtalk-register] begin: missing device_code or verification_uri')
  }
  const expiresInMs = Math.max(60, Number(begin.expires_in ?? 7200)) * 1000
  const intervalMs = Math.max(3, Number(begin.interval ?? 3)) * 1000

  const login: ActiveLogin = {
    loginId,
    status: 'running',
    qrcodeUrl: '',
    qrcode: verifyUrl,
    message: '正在获取二维码…',
    startedAt: Date.now(),
  }
  logins.set(loginId, login)

  // Render the verification URL into an actual QR picture.
  try {
    login.qrcodeUrl = await QRCode.toDataURL(verifyUrl, { width: 240, margin: 1 })
    login.message = '请用手机钉钉扫码，一键创建机器人（或绑定已有机器人）。'
  } catch {
    login.message = '二维码渲染失败，可用下方链接扫码。'
  }

  const deadline = Date.now() + expiresInMs
  const timer = setInterval(() => {
    void (async () => {
      if (login.status !== 'running') {
        clearInterval(timer)
        return
      }
      if (Date.now() >= deadline) {
        login.status = 'expired'
        login.message = '二维码已过期，请重新扫码。'
        clearInterval(timer)
        return
      }
      try {
        const poll = await post<{
          status?: string
          client_id?: string
          client_secret?: string
          fail_reason?: string
        }>('/app/registration/poll', { device_code: deviceCode })
        const status = String(poll.status ?? '').trim().toUpperCase()
        if (status === 'WAITING') return
        if (status === 'SUCCESS') {
          const clientId = String(poll.client_id ?? '').trim()
          const clientSecret = String(poll.client_secret ?? '').trim()
          if (!clientId || !clientSecret) {
            login.status = 'error'
            login.message = '授权成功但未返回机器人凭证。'
          } else {
            login.clientId = clientId
            login.clientSecret = clientSecret
            login.status = 'confirmed'
            login.message = '机器人创建成功！AppKey 已自动填入。'
          }
          clearInterval(timer)
          return
        }
        if (status === 'FAIL') {
          login.status = 'error'
          login.message = String(poll.fail_reason ?? '授权失败').trim()
          clearInterval(timer)
          return
        }
        if (status === 'EXPIRED') {
          login.status = 'expired'
          login.message = '二维码已过期，请重新扫码。'
          clearInterval(timer)
          return
        }
      } catch (err) {
        // Transient network/server error — keep polling (will eventually time out).
        if (login.status !== 'running') {
          login.status = 'error'
          login.message = err instanceof Error ? err.message : String(err)
          clearInterval(timer)
        }
      }
    })().catch(() => {})
  }, intervalMs)
  login.stop = () => clearInterval(timer)

  return snapshot(login)
}

/** Read the current registration snapshot (null if the login is gone). */
export function getLoginStatus(loginId: string): DingtalkRegisterStatus | null {
  const l = logins.get(loginId)
  if (!l) return null
  return snapshot(l)
}

/** Cancel an in-flight registration. */
export function cancelLogin(loginId: string): void {
  const l = logins.get(loginId)
  if (!l) return
  l.stop?.()
  l.status = 'canceled'
  l.message = '注册已取消。'
}