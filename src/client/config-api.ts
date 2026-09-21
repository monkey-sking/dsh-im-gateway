/**
 * Client-side config api for the IM channels settings page (browser half).
 *
 * Talks to the host Typert Remote service `imGatewayRemote` (see
 * src/remote.ts) through `ctx.remote` — the official channel for a business
 * package to expose RPC to the Web client. This replaces `api.settings.*`
 * for our namespace (the official API gateway refuses third-party settings
 * namespaces with `settings-not-exposed`) and the earlier raw webServer
 * fetch route.
 *
 * The wire contract is the shared artifact src/typert.remote-client.ts
 * (exported as ./remote), mirroring the official generator's emitRemote.
 * Browser-half constraints: no JSX, platform modules only.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ImChannelInstance } from './ImChannelModal.ts'
import type { ChannelStatus } from '../gateway/types'
import { TYPERT_REMOTE } from '../typert.remote-client'

/** Remote namespace exposed by the host face (src/typert.host.ts). */
const REMOTE_NS = 'imGatewayRemote'

export interface ConfigLoadResult {
  ok: boolean
  channels?: ImChannelInstance[]
  revision?: number
  code?: string
  message?: string
}

export interface ChannelStatusesResult {
  ok: boolean
  statuses?: Record<string, ChannelStatus>
  code?: string
  message?: string
}

/** Unified QR-login snapshot for every QR-bound channel (qq / weixin / dingtalk / feishu / wecom). */
export interface QrLoginStatus {
  loginId: string
  status: string
  /** QR image as data URL (what the UI shows in <img>). */
  qrcodeUrl: string
  /** Raw QR content (fallback link). */
  qrcode: string
  message: string
  /** WeChat pairing-code flow: set when the server wants a code. */
  verifyCodeNeeded?: boolean
  /** Present when status === "confirmed". */
  credentials?: Record<string, string>
}

export interface QrLoginResult {
  ok: boolean
  status?: QrLoginStatus
  code?: string
  message?: string
}

export interface ConfigApi {
  /** GET current channels + revision (secrets redacted). */
  load(): Promise<ConfigLoadResult>
  /** Wholesale-replace the channels array. */
  save(channels: ImChannelInstance[], expectedRevision?: number): Promise<ConfigLoadResult>
  /** GET live channel runtime statuses (online/offline/error). */
  statuses(): Promise<ChannelStatusesResult>
  /** Start a QR-scan login ('qq' | 'weixin' | 'dingtalk' | 'feishu' | 'wecom'). */
  startQrLogin(channelType: string): Promise<QrLoginResult>
  /** Poll the current QR-login snapshot. */
  getQrLoginStatus(loginId: string): Promise<QrLoginResult>
  /** Submit the phone pairing code (WeChat). */
  submitQrVerifyCode(loginId: string, code: string): Promise<{ ok: boolean; value?: boolean; code?: string; message?: string }>
  /** Cancel an in-flight QR login. */
  cancelQrLogin(loginId: string): Promise<{ ok: boolean; value?: boolean; code?: string; message?: string }>
}

/**
 * Create the config api bound to this browser plugin's context.
 * Mounts the shared remote contribution once; every call awaits the mount, then
 * invokes the namespace service and unwraps the `{ok, value/error}` envelope.
 */
export function createConfigApi(ctx: ClientContext): ConfigApi {
  const mount = ctx.remote.$mount(TYPERT_REMOTE)

  const call = async (method: 'getConfig' | 'saveConfig' | 'getChannelStatuses' | 'startQrLogin' | 'getQrLoginStatus' | 'submitQrVerifyCode' | 'cancelQrLogin', ...args: unknown[]): Promise<ConfigLoadResult | ChannelStatusesResult | QrLoginResult | { ok: boolean; value?: boolean; code?: string; message?: string }> => {
    try {
      await mount
      const remote = ctx.get(`remote.${REMOTE_NS}`) as unknown as Record<string, (...a: unknown[]) => Promise<{ ok: boolean; value?: unknown; error?: { code?: string; message?: string } }>>
      const result = await remote[method](...args)
      if (!result.ok) {
        return { ok: false, code: result.error?.code ?? 'remote-error', message: result.error?.message ?? `${REMOTE_NS}.${method} failed` }
      }
      return { ...(result.value as ConfigLoadResult & ChannelStatusesResult & QrLoginResult), ok: true }
    } catch (err) {
      return { ok: false, code: 'remote-error', message: err instanceof Error ? err.message : String(err) }
    }
  }

  return {
    load: () => call('getConfig') as Promise<ConfigLoadResult>,
    save: (channels, expectedRevision) => call('saveConfig', channels, expectedRevision) as Promise<ConfigLoadResult>,
    statuses: () => call('getChannelStatuses') as Promise<ChannelStatusesResult>,
    startQrLogin: (channelType) => call('startQrLogin', channelType) as Promise<QrLoginResult>,
    getQrLoginStatus: (loginId) => call('getQrLoginStatus', loginId) as Promise<QrLoginResult>,
    submitQrVerifyCode: (loginId, code) => call('submitQrVerifyCode', loginId, code) as Promise<{ ok: boolean; value?: boolean; code?: string; message?: string }>,
    cancelQrLogin: (loginId) => call('cancelQrLogin', loginId) as Promise<{ ok: boolean; value?: boolean; code?: string; message?: string }>,
  }
}
