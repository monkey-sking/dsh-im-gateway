/**
 * Host-side Remote config API for the IM gateway bundle (Typert).
 *
 * WHY Typert INSTEAD OF THE RAW webServer ROUTE: dsh's API gateway only
 * exposes allowlisted settings namespaces to the Web client (third-party
 * namespaces get `settings-not-exposed`), and the official extension path for
 * "business package → Web client" RPC is Typert (`packages/typert` +
 * `docs/api-gateway.md` in the harness repo: services extend
 * `TypertRemoteService`, contributions mount through `ctx.remote.$mount` and
 * are called as `ctx.remote.<namespace>.<method>()` with a uniform
 * `{ok, value/error}` envelope). Pattern verified against the third-party
 * `dsh-skill-viewer` bundle.
 *
 * Exposed methods (namespace `imGatewayRemote`):
 *   getConfig()               → { channels, revision }   (secrets redacted)
 *   saveConfig(channels, expectedRevision?)
 *                             → { channels, revision }    (or throws)
 *
 * Secret handling: the client never sees secret plaintext (describe redacts).
 * On save, blank secret fields are merged back from the stored value
 * (in-process describe with redactSecrets:false), so an array
 * wholesale-replace never wipes credentials the user did not retype.
 *
 * THE WIRE CONTRACT lives in src/typert.host.ts (exported as ./typert). dsh's
 * typert-loader imports that module and registers the `TYPERT` manifest into
 * `ctx.typert` — the official auto-registration path. This file only
 * instantiates the runtime service below; it must NOT call `ctx.typert.register()`
 * (that would double-register the same contribution).
 */
import { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { ChannelStatus, ImChannelInstance } from './gateway/types'
import * as qqLogin from './channels/qq-login'
import * as weixinLogin from './channels/weixin-login'
import * as dingtalkRegister from './channels/dingtalk-register'
import * as feishuRegister from './channels/feishu-register'
import * as wecomRegister from './channels/wecom-register'
import { syncChannels } from './sync'

const NS = 'im-gateway'
const SERVICE = 'imGatewayRemote'

/**
 * Secret-typed credential keys (mirrors the host Config schema roles).
 * `secret` is the WeCom long-connection key — distinct from `clientSecret`
 * (DingTalk / QQ / Feishu) and `token` (WeChat iLink).
 */
const SECRET_KEYS = new Set(['clientSecret', 'token', 'secret'])

interface SettingsLike {
  describe(opts: { redactSecrets: boolean }): { ns: string; value?: Record<string, unknown>; revision: number }[]
  update(ns: string, patch: Record<string, unknown>, expectedRevision?: number): Promise<void>
}

/** Read the namespace view (channels + revision). Secrets redacted on the wire. */
function readView(settings: SettingsLike): { channels: ImChannelInstance[]; revision: number } {
  const view = settings.describe({ redactSecrets: true }).find((n) => n.ns === NS)
  const channels = view?.value?.channels
  return {
    channels: Array.isArray(channels) ? (channels as ImChannelInstance[]) : [],
    revision: view?.revision ?? 0,
  }
}

/** Pull the current channels array (plaintext secrets) from the settings service. */
function currentChannels(settings: SettingsLike): ImChannelInstance[] {
  const view = settings.describe({ redactSecrets: false }).find((n) => n.ns === NS)
  const channels = view?.value?.channels
  return Array.isArray(channels) ? (channels as ImChannelInstance[]) : []
}

/**
 * Merge blank secrets back from storage. `channels` is a wholesale-replace
 * array; without this, a save would wipe every secret the user did not
 * retype (they see a blank password field because describe redacts).
 */
function mergeStoredSecrets(
  current: ImChannelInstance[],
  incoming: ImChannelInstance[],
): ImChannelInstance[] {
  return incoming.map((inst) => {
    const stored = current.find((c) => c.id === inst.id)
    if (!stored) return inst
    const config = { ...inst.config }
    for (const key of SECRET_KEYS) {
      const bag = config as unknown as Record<string, string | undefined>
      const value = bag[key]
      if (value === '' || value === undefined) {
        const old = (stored.config as unknown as Record<string, string | undefined> | undefined)?.[key]
        if (old !== undefined && old !== '') bag[key] = old
      }
    }
    return { ...inst, config }
  })
}

/**
 * The Remote service. Constructing it registers the `imGatewayRemote` cordis
 * service; the wire contract (src/typert.host.ts) lets the API gateway
 * dispatch the methods. Plain methods are fine — the descriptors carry the
 * contract.
 */
class ImGatewayApi extends TypertRemoteService {
  private readonly settings: SettingsLike

  constructor(ctx: Context) {
    super(ctx, SERVICE)
    this.settings = ctx.get('settings') as SettingsLike
  }

  /** Current channels + revision (secrets redacted). */
  getConfig(): { channels: ImChannelInstance[]; revision: number } {
    return readView(this.settings)
  }

  /** Wholesale-replace the channels array. Blank secrets are kept from storage. */
  async saveConfig(
    channels: ImChannelInstance[],
    expectedRevision?: number,
  ): Promise<{ channels: ImChannelInstance[]; revision: number }> {
    if (!Array.isArray(channels)) throw new Error('channels must be an array')
    const merged = mergeStoredSecrets(currentChannels(this.settings), channels)
    await this.settings.update(NS, { channels: merged }, expectedRevision)
    // Rebuild adapters from the NEW config (mirrors the reference project's
    // applyConfig). Without this, a QR-scan binding saved here would never
    // connect in the running process. `ctx.get('imGateway')` (not property
    // access) so it works without declaring the dependency in this fiber.
    try {
      const gateway = this.ctx.get('imGateway') as { stopAll(): Promise<void>; registerChannel(adapter: import('./gateway/types').ImChannelAdapter): void } | undefined
      if (gateway) {
        await syncChannels(gateway, this.ctx, { cwd: process.cwd(), streamThrottleMs: 800, slashCommands: true, approvalTimeoutSecs: 120, questionTimeoutSecs: 600, allowAllUsers: false, allowedUserIds: {}, mergeTimeoutSecs: 3, channels: [] })
      }
    } catch (err) {
      this.ctx.logger.error('[im-gateway] channel reload after save failed', err)
    }
    return readView(this.settings)
  }

  /** Live channel runtime statuses (online/offline/error) for the settings UI. */
  getChannelStatuses(): Record<string, ChannelStatus> {
    return (this.ctx.get('imGateway') as { getChannelStatuses(): Record<string, ChannelStatus> }).getChannelStatuses()
  }

  /**
   * Kick off a QR-scan login for a channel type ('qq' | 'weixin' | 'dingtalk'
   * | 'feishu' | 'wecom'). Returns
   * `{ status: snapshot }` (the client's generic `call()` spreads the value
   * to the top level, so the snapshot MUST be wrapped in a `status` key —
   * otherwise `res.status` would be the snapshot's `status` string, not the
   * snapshot object, and the polling effect would never start).
   */
  async startQrLogin(channelType: string): Promise<{ status: unknown }> {
    try {
      if (channelType === 'qq') return { status: await qqLogin.startLogin() }
      if (channelType === 'weixin') return { status: await weixinLogin.startLogin() }
      if (channelType === 'dingtalk') return { status: await dingtalkRegister.startLogin() }
      if (channelType === 'feishu') return { status: await feishuRegister.startLogin() }
      if (channelType === 'wecom') return { status: await wecomRegister.startLogin() }
      throw new Error(`unsupported channel type for QR login: ${channelType}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[im-gateway] startQrLogin(${channelType}) failed:`, message)
      return {
        status: {
          loginId: '',
          status: 'error',
          qrcodeUrl: '',
          qrcode: '',
          message: `二维码获取失败：${message}`,
        },
      }
    }
  }

  /** Read the current login snapshot (null → the login is gone/expired). */
  getQrLoginStatus(loginId: string): { status: unknown } {
    const qq = qqLogin.getLoginStatus(loginId)
    if (qq) return { status: qq }
    const wx = weixinLogin.getLoginStatus(loginId)
    if (wx) return { status: wx }
    const dd = dingtalkRegister.getLoginStatus(loginId)
    if (dd) return { status: dd }
    const fs = feishuRegister.getLoginStatus(loginId)
    if (fs) return { status: fs }
    const wc = wecomRegister.getLoginStatus(loginId)
    if (wc) return { status: wc }
    return { status: null }
  }

  /** Submit the phone pairing code (WeChat only; QQ returns false). */
  submitQrVerifyCode(loginId: string, code: string): boolean {
    return weixinLogin.submitVerifyCode(loginId, code)
  }

  /** Cancel an in-flight QR login. */
  cancelQrLogin(loginId: string): boolean {
    qqLogin.cancelLogin(loginId)
    weixinLogin.cancelLogin(loginId)
    dingtalkRegister.cancelLogin(loginId)
    feishuRegister.cancelLogin(loginId)
    wecomRegister.cancelLogin(loginId)
    return true
  }
}

/**
 * Instantiate the Remote config service. Called from the bundle apply.
 *
 * The cordis `imGatewayRemote` service must exist for the API gateway to
 * dispatch invocations; the loader registers the wire contract (src/typert.host.ts,
 * exported as ./typert) automatically — do NOT register it here again.
 */
export function registerRemoteApi(ctx: Context): void {
  new ImGatewayApi(ctx)
}
