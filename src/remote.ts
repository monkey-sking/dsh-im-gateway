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
 */
import { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { TypertSchema } from '@deepseek-ai/dsh-typert-protocol'
import type { ChannelStatus, ImChannelInstance } from './gateway/types'
import * as qqLogin from './channels/qq-login'
import * as weixinLogin from './channels/weixin-login'
import { syncChannels } from './sync'

const NS = 'im-gateway'
const SERVICE = 'imGatewayRemote'
const PACKAGE = '@lijian-ui/dsh-im-gateway'

/** Secret-typed credential keys (mirrors the host Config schema roles). */
const SECRET_KEYS = new Set(['clientSecret', 'token'])

/** Minimal boundary schema: channels must be an array. */
const channelsSchema: TypertSchema = {
  parse(value: unknown): unknown {
    if (!Array.isArray(value)) throw new Error('channels must be an array')
    return value
  },
}

/** Minimal boundary schema: revision is an optional number. */
const revisionSchema: TypertSchema = {
  parse(value: unknown): unknown {
    if (value === undefined || value === null) return undefined
    if (typeof value !== 'number') throw new Error('expectedRevision must be a number')
    return value
  },
}

const codec = (typeSymbol: string, schema: TypertSchema) => ({ mode: 'strict' as const, typeSymbol, schema })

/**
 * The typed wire contribution registered with `ctx.typert`. HOST face:
 * the registry expects `face: 'host'` + `invocations` (the client-side
 * `$mount` contribution instead carries `descriptors`).
 */
const CONTRIBUTION = {
  package: PACKAGE,
  face: 'host' as const,
  schemas: [],
  invocations: [
    {
      id: `${PACKAGE}#${SERVICE}/getConfig`,
      service: SERVICE,
      namespace: SERVICE,
      method: 'getConfig',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec(`${PACKAGE}#ImGatewayConfigView`, { parse: (v) => v }),
    },
    {
      id: `${PACKAGE}#${SERVICE}/saveConfig`,
      service: SERVICE,
      namespace: SERVICE,
      method: 'saveConfig',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'channels', wire: 'channels', source: 'json', codec: codec(`${PACKAGE}#ChannelsArray`, channelsSchema) },
        {
          name: 'expectedRevision',
          wire: 'expectedRevision',
          source: 'json',
          acceptsUndefined: true,
          codec: codec(`${PACKAGE}#Revision`, revisionSchema),
        },
      ],
      result: codec(`${PACKAGE}#ImGatewayConfigView`, { parse: (v) => v }),
    },
    {
      id: `${PACKAGE}#${SERVICE}/getChannelStatuses`,
      service: SERVICE,
      namespace: SERVICE,
      method: 'getChannelStatuses',
      invocation: { kind: 'direct' },
      parameters: [],
      result: codec(`${PACKAGE}#ChannelStatuses`, { parse: (v) => v }),
    },
    {
      id: `${PACKAGE}#${SERVICE}/startQrLogin`,
      service: SERVICE,
      namespace: SERVICE,
      method: 'startQrLogin',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'channelType', wire: 'channelType', source: 'json', codec: codec(`${PACKAGE}#ChannelType`, { parse: (v) => v }) },
      ],
      result: codec(`${PACKAGE}#QrLoginStatus`, { parse: (v) => v }),
    },
    {
      id: `${PACKAGE}#${SERVICE}/getQrLoginStatus`,
      service: SERVICE,
      namespace: SERVICE,
      method: 'getQrLoginStatus',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'loginId', wire: 'loginId', source: 'json', codec: codec(`${PACKAGE}#LoginId`, { parse: (v) => v }) },
      ],
      result: codec(`${PACKAGE}#QrLoginStatus`, { parse: (v) => v }),
    },
    {
      id: `${PACKAGE}#${SERVICE}/submitQrVerifyCode`,
      service: SERVICE,
      namespace: SERVICE,
      method: 'submitQrVerifyCode',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'loginId', wire: 'loginId', source: 'json', codec: codec(`${PACKAGE}#LoginId`, { parse: (v) => v }) },
        { name: 'code', wire: 'code', source: 'json', codec: codec(`${PACKAGE}#VerifyCode`, { parse: (v) => v }) },
      ],
      result: codec(`${PACKAGE}#Bool`, { parse: (v) => v }),
    },
    {
      id: `${PACKAGE}#${SERVICE}/cancelQrLogin`,
      service: SERVICE,
      namespace: SERVICE,
      method: 'cancelQrLogin',
      invocation: { kind: 'direct' },
      parameters: [
        { name: 'loginId', wire: 'loginId', source: 'json', codec: codec(`${PACKAGE}#LoginId`, { parse: (v) => v }) },
      ],
      result: codec(`${PACKAGE}#Bool`, { parse: (v) => v }),
    },
  ],
  model: { services: [], events: [], objects: [] },
}

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
      const value = config[key]
      if (value === '' || value === undefined) {
        const old = stored.config?.[key]
        if (old !== undefined && old !== '') config[key] = old
      }
    }
    return { ...inst, config }
  })
}

/**
 * The Remote service. Constructing it registers the `imGatewayRemote` cordis
 * service; the contribution above lets the API gateway dispatch the two
 * methods. Plain methods are fine — the descriptors carry the wire contract.
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
    // Defensive: the wire boundary schema normally rejects non-arrays, but a
    // direct in-process caller bypasses it.
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
        await syncChannels(gateway, this.ctx, { cwd: process.cwd(), streamThrottleMs: 800, slashCommands: true, channels: [] })
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
   * Kick off a QR-scan login for a channel type ('qq' | 'weixin'). Returns
   * `{ status: snapshot }` (the client's generic `call()` spreads the value
   * to the top level, so the snapshot MUST be wrapped in a `status` key —
   * otherwise `res.status` would be the snapshot's `status` string, not the
   * snapshot object, and the polling effect would never start).
   */
  async startQrLogin(channelType: string): Promise<{ status: unknown }> {
    try {
      if (channelType === 'qq') return { status: await qqLogin.startLogin() }
      if (channelType === 'weixin') return { status: await weixinLogin.startLogin() }
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
    return true
  }
}

/**
 * Register the Remote config service. Called from the bundle apply AFTER the
 * entry's plugin-level `inject: ['typert', 'settings']` guarantee, so both
 * services are live here (synchronous registration, mirroring the official
 * dsh-skill-viewer host: `export const inject = ["typert", ...]`).
 */
export function registerRemoteApi(ctx: Context): void {
  new ImGatewayApi(ctx)
  ctx.effect(
    () => ctx.get('typert').register(CONTRIBUTION),
    `im-gateway: typert contribution ${PACKAGE}`,
  )
}
