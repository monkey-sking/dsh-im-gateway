/**
 * 企业微信「扫码创建智能机器人」—— 官方 `work.weixin.qq.com/ai/qc/*` 授权流程。
 *
 * 与 `dingtalk-register.ts` 采用同一「快照 + 前端轮询」模型：
 *   startLogin() 立刻返回快照（含二维码），后台定时轮询授权结果，
 *   UI 通过 getLoginStatus() 轮询直到 confirmed。
 *
 * 流程（依据企业微信官方智能机器人长连接文档）：
 *   1. GET /ai/qc/generate?source=wecom-cli&plat=<1|2|3> → { scode, auth_url }
 *   2. 把 auth_url 渲染成二维码给用户扫
 *   3. GET /ai/qc/query_result?scode=… → { status, bot_info: { botid, secret } }
 *      status: init/waiting（等待）→ success（拿到凭据）/ expired|timeout / fail|error
 *
 * `source` 必须是 `wecom-cli`：官方 @wecom/wecom-openclaw-cli 固定使用该值，
 * 换成其它值生成接口虽然照常返回二维码，但手机端授权页会二次校验并报
 * 「参数不合法」。
 */
import { randomUUID } from 'node:crypto'
import QRCode from 'qrcode'

/** 返回给调用方（设置页经 Remote）的快照。 */
export interface WecomRegisterStatus {
  loginId: string
  status: 'running' | 'confirmed' | 'error' | 'canceled' | 'expired'
  /** 二维码图片 data URL（UI 用 <img> 展示）。 */
  qrcodeUrl: string
  /** 原始二维码内容 URL（兜底链接）。 */
  qrcode: string
  message: string
  /** status === 'confirmed' 时给出。 */
  credentials?: { botId: string; secret: string }
}

interface ActiveLogin {
  loginId: string
  status: WecomRegisterStatus['status']
  qrcodeUrl: string
  qrcode: string
  message: string
  startedAt: number
  /** 停止后台轮询。 */
  stop?: () => void
  botId?: string
  secret?: string
}

const logins = new Map<string, ActiveLogin>()

const GENERATE_URL = 'https://work.weixin.qq.com/ai/qc/generate'
const RESULT_URL = 'https://work.weixin.qq.com/ai/qc/query_result'
/** 官方 CLI 固定使用的 source（见文件头说明）。 */
const SOURCE = 'wecom-cli'
/** 轮询间隔（ms）—— 与官方 CLI 一致。 */
const POLL_INTERVAL_MS = 3_000
/** 二维码有效期（ms）—— 官方有效期约 5 分钟。 */
const QR_TTL_MS = 5 * 60_000

/** 客户端平台标识：1=移动端/iOS 2=Windows 3=Linux（官方约定）。 */
function platValue(): string {
  if (process.platform === 'win32') return '2'
  if (process.platform === 'linux') return '3'
  return '1'
}

function cleanString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function snapshot(l: ActiveLogin): WecomRegisterStatus {
  const s: WecomRegisterStatus = {
    loginId: l.loginId,
    status: l.status,
    qrcodeUrl: l.qrcodeUrl,
    qrcode: l.qrcode,
    message: l.message,
  }
  if (l.status === 'confirmed' && l.botId && l.secret) {
    s.credentials = { botId: l.botId, secret: l.secret }
  }
  return s
}

/** 清理过期（非 running）登录记录，避免 map 无限增长。 */
function purgeStale(): void {
  const now = Date.now()
  for (const [id, l] of logins) {
    if (l.status !== 'running' && now - l.startedAt > 5 * 60_000) logins.delete(id)
  }
}

/**
 * 把官方轮询状态归一成我方状态机。
 * 首次返回 `init`、以及任何未知状态都继续等待 —— 避免误杀一个仍然有效的
 * 二维码（官方文档只列出 init / success / expired 三种）。
 */
function classifyStatus(value: unknown): 'waiting' | 'success' | 'expired' | 'failed' {
  const status = cleanString(value).toLowerCase()
  if (status === 'success') return 'success'
  if (status === 'expired' || status === 'timeout') return 'expired'
  if (status === 'fail' || status === 'failed' || status === 'error') return 'failed'
  return 'waiting'
}

/**
 * 发起一次企业微信机器人扫码创建。立即返回快照（通常已含二维码），
 * 后台定时轮询授权结果，UI 轮询 getLoginStatus() 获取最终结果。
 */
export async function startLogin(): Promise<WecomRegisterStatus> {
  purgeStale()
  const loginId = randomUUID()

  const generate = new URL(GENERATE_URL)
  generate.searchParams.set('source', SOURCE)
  generate.searchParams.set('plat', platValue())

  const res = await fetch(generate, {
    headers: { accept: 'application/json' },
    // 该接口不发生合法重定向；跟随重定向有被导向未知主机的风险。
    redirect: 'error',
  })
  if (!res.ok) throw new Error(`企业微信扫码服务 HTTP ${res.status}`)
  const body = (await res.json()) as { data?: { scode?: string; auth_url?: string } } | undefined
  const scode = cleanString(body?.data?.scode)
  const authUrl = cleanString(body?.data?.auth_url)
  if (!scode || !authUrl || !authUrl.startsWith('https://work.weixin.qq.com/')) {
    throw new Error('企业微信扫码服务返回了无效数据')
  }

  const login: ActiveLogin = {
    loginId,
    status: 'running',
    qrcodeUrl: '',
    qrcode: authUrl,
    message: '正在获取二维码…',
    startedAt: Date.now(),
  }
  logins.set(loginId, login)

  try {
    login.qrcodeUrl = await QRCode.toDataURL(authUrl, { width: 240, margin: 1 })
    login.message = '请用企业微信扫码，一键创建智能机器人。'
  } catch {
    login.message = '二维码渲染失败，可用下方链接扫码。'
  }

  const deadline = Date.now() + QR_TTL_MS
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
        const url = new URL(RESULT_URL)
        url.searchParams.set('scode', scode)
        const resultRes = await fetch(url, { headers: { accept: 'application/json' } })
        if (!resultRes.ok) return
        const result = (await resultRes.json()) as
          | { data?: { status?: string; bot_info?: { botid?: string; secret?: string } } }
          | undefined
        const state = classifyStatus(result?.data?.status)
        if (state === 'waiting') return
        if (state === 'expired') {
          login.status = 'expired'
          login.message = '二维码已过期，请重新扫码。'
          clearInterval(timer)
          return
        }
        if (state === 'failed') {
          login.status = 'error'
          login.message = '扫码授权未完成。'
          clearInterval(timer)
          return
        }
        const botId = cleanString(result?.data?.bot_info?.botid)
        const secret = cleanString(result?.data?.bot_info?.secret)
        if (!botId || !secret) {
          login.status = 'error'
          login.message = '授权成功但未返回机器人凭据。'
        } else {
          login.botId = botId
          login.secret = secret
          login.status = 'confirmed'
          login.message = '机器人创建成功！Bot ID 已自动填入。'
        }
        clearInterval(timer)
      } catch {
        // 瞬时网络错误：保持 running 继续轮询（最终由 deadline 兜底）。
      }
    })().catch(() => {})
  }, POLL_INTERVAL_MS)
  login.stop = () => clearInterval(timer)

  return snapshot(login)
}

/** 读取当前快照（登录不存在时返回 null）。 */
export function getLoginStatus(loginId: string): WecomRegisterStatus | null {
  const l = logins.get(loginId)
  return l ? snapshot(l) : null
}

/** 取消进行中的扫码创建。 */
export function cancelLogin(loginId: string): void {
  const l = logins.get(loginId)
  if (!l) return
  l.stop?.()
  if (l.status === 'running') {
    l.status = 'canceled'
    l.message = '注册已取消。'
  }
}
