import { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { ImGatewayService, Config } from './gateway/im-gateway'
import type { ImGatewayConfig } from './gateway/types'
import { syncChannels } from './sync'
import { registerRemoteApi } from './remote'

export { Config }
export * from './gateway/types'

/**
 * Plugin-level dependency declaration: the bundle waits for these host
 * services before apply runs (mirrors the official dsh-skill-viewer host:
 * `export const inject = ["typert", ...]`). `imGateway` (our own core
 * service) is created inside apply and waited on via ctx.inject below.
 */
export const inject = ['typert', 'settings']

/** Settings namespace for the whole IM bundle (web UI renders `channels[]`). */
const NS = settingsNamespace('im-gateway')

/**
 * Single-entry IM gateway bundle. One plugin (`@lijian-ui/dsh-im-gateway`) provides the
 * core gateway service AND every channel (DingTalk / QQ / 个人微信) as
 * INSTANCES: `config.channels` is an array, and the same channel type may
 * appear multiple times (multi-bot support, mirroring pi-desk-top). Only
 * `enabled` instances connect out.
 */
export function apply(ctx: Context, config: ImGatewayConfig): void {
  // cordis's LoggerService only buffers logs in memory by default (the
  // default exporter just pushes into `service.buffer`), so `ctx.logger.*`
  // calls are INVISIBLE in the dsh console. Register a console exporter that
  // forwards every level to the native console (→ dsh stderr → desktop shell
  // "[dsh] " prefix → Electron terminal). Without this, debugging the IM
  // gateway is blind — there are logs, they just never surface anywhere.
  installConsoleLoggerExporter(ctx)

  // Register the bundle's editable settings namespace so the web UI
  // (设置 → IM 通道) can render the gateway + channel configs as forms.
  installSettingsSection(ctx, NS, Config, config, {
    // Live-settings seam: the UI writes the user layer; `settings.describe`
    // below merges base + user, so UI-saved config is what actually runs.
    setSource: () => {},
    onChange: () => {},
  })

  ctx.plugin(ImGatewayService, config)

  // Expose the config to the Web client through a Typert Remote service
  // (namespace imGatewayRemote: getConfig / saveConfig). The official API
  // gateway refuses third-party settings namespaces (settings-not-exposed),
  // so the settings page reads/writes through this Remote channel.
  registerRemoteApi(ctx)

  // Effective config: the SETTINGS MERGED value (base + user), not the
  // boot-time `config` snapshot. The settings user layer (what the web UI
  // saves) is a separate store from the plugin's cordis config — reading it
  // here is what makes a UI-configured channel actually start. Read INSIDE
  // the imGateway inject callback: at apply time the settings user layer may
  // not be loaded yet, so a describe there would only see the base layer.
  ctx.inject(['imGateway'], (sctx) => {
    // Initial sync at boot. Config reloads (saveConfig) re-invoke the same
    // function through the remote — mirrors the reference project's
    // applyConfig → stopAll → recreate → start.
    void syncChannels(sctx.imGateway, sctx, config)
  })
}

/**
 * Route every cordis logger message to the native console so IM gateway logs
 * actually reach the terminal. Without this, `ctx.logger.*` only lands in
 * cordis's in-memory buffer (its default exporter) and is invisible while
 * debugging. Message shape: { name, type, level, args, ... }.
 */
function installConsoleLoggerExporter(ctx: Context): void {
  try {
    const logger = ctx.root.logger as unknown as {
      exporter?(opts: {
        colors?: number
        export: (message: { name?: string; type?: string; args?: unknown[] }) => void
      }): unknown
    }
    logger?.exporter?.({
      colors: 0,
      export: (message) => {
        const { name = 'im-gateway', type = 'log', args = [] } = message
        const rendered = args
          .map((arg) =>
            arg instanceof Error
              ? (arg.stack ?? arg.message)
              : typeof arg === 'string'
                ? arg
                : (() => {
                    try {
                      return JSON.stringify(arg)
                    } catch {
                      return String(arg)
                    }
                  })(),
          )
          .join(' ')
        const line = `[${name}] ${rendered}`
        // Native console → dsh subprocess stderr → desktop shell "[dsh] " prefix.
        if (type === 'error') console.error(line)
        else if (type === 'warn') console.warn(line)
        else if (type === 'debug') console.debug(line)
        else console.info(line)
      },
    })
  } catch {
    /* logging must never break plugin boot */
  }
}
