/**
 * Channel sync (boot + config reload) — extracted into its own module so
 * both index.ts (boot) and remote.ts (saveConfig reload) can use it WITHOUT
 * creating an import cycle (index → remote → index).
 */
import { Context } from '@deepseek-ai/cordis'
import { DingtalkAdapter } from './channels/dingtalk'
import { QQAdapter } from './channels/qq'
import { WeixinAdapter } from './channels/weixin'
import { FeishuAdapter } from './channels/feishu'
import { WecomAdapter } from './channels/wecom'
import type {
  ImChannelAdapter,
  ImChannelInstance,
  ImGatewayConfig,
  DingtalkChannelConfig,
  QqChannelConfig,
  WeixinChannelConfig,
  FeishuChannelConfig,
  WecomChannelConfig,
  ChannelType,
} from './gateway/types'

const NS = 'im-gateway'

/** Channels that should actually run = settings merged value (user layer wins). */
export function readEffectiveConfig(ctx: Context, fallback: ImGatewayConfig): ImChannelInstance[] {
  try {
    const settings = ctx.get('settings') as {
      describe(opts: { redactSecrets: boolean }): { ns: string; value?: Record<string, unknown> }[]
    }
    const view = settings.describe({ redactSecrets: false }).find((n) => n.ns === String(NS))
    const channels = view?.value?.channels
    if (Array.isArray(channels) && channels.length > 0) return channels as ImChannelInstance[]
  } catch (err) {
    ctx.logger.warn('[im-gateway] settings read failed; falling back to boot config', err)
  }
  return fallback.channels ?? []
}

/** Instantiate the right adapter class for a channel instance. */
function createAdapter(ctx: Context, inst: ImChannelInstance): ImChannelAdapter | null {
  const label = inst.name || typeLabel(inst.type)
  switch (inst.type) {
    case 'dingtalk':
      return new DingtalkAdapter(ctx, inst.config as DingtalkChannelConfig, inst.id, label)
    case 'qq':
      return new QQAdapter(ctx, inst.config as QqChannelConfig, inst.id, label)
    case 'weixin':
      return new WeixinAdapter(ctx, inst.config as WeixinChannelConfig, inst.id, label)
    case 'feishu':
      return new FeishuAdapter(ctx, inst.config as FeishuChannelConfig, inst.id, label)
    case 'wecom':
      return new WecomAdapter(ctx, inst.config as WecomChannelConfig, inst.id, label)
    default:
      ctx.logger.warn(`[im-gateway] unknown channel type "${String(inst.type)}" for "${inst.id}"`)
      return null
  }
}

function typeLabel(type: ChannelType): string {
  switch (type) {
    case 'dingtalk': return '钉钉'
    case 'qq': return 'QQ'
    case 'weixin': return '个人微信'
    case 'feishu': return '飞书'
    case 'wecom': return '企业微信'
  }
}

/**
 * Stop every channel and re-create them from the CURRENT settings merged
 * config. Called at boot and after every config save (mirrors the reference
 * project's applyConfig → stopAll → recreate → start). Without this, a
 * QR-scan binding saved from the settings UI would never take effect in the
 * running process — adapters created at boot with empty credentials stay
 * dead forever.
 *
 * @param imGateway - the gateway service instance. Passed explicitly instead
 *   of resolving `ctx.imGateway` because callers live in different fibers
 *   (boot inject vs Typert remote) whose `inject` lists differ — property
 *   access would throw `cannot get property "imGateway" without inject`.
 */
export async function syncChannels(
  imGateway: { stopAll(): Promise<void>; registerChannel(adapter: ImChannelAdapter): void },
  ctx: Context,
  fallback: ImGatewayConfig,
): Promise<void> {
  await imGateway.stopAll()
  const effective = readEffectiveConfig(ctx, fallback)
  for (const inst of effective) {
    if (!inst.enabled) continue
    const adapter = createAdapter(ctx, inst)
    if (!adapter) continue
    ctx.logger.info(`[im-gateway] starting channel "${inst.id}" (${inst.type})`)
    imGateway.registerChannel(adapter)
  }
}
