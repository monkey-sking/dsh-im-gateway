/**
 * @lijian-ui/dsh-im-gateway — browser half (client bundle).
 *
 * Registers ONE Settings page (`settings.section`, "IM 通道", below Models)
 * that renders every channel INSTANCE in the bundle config
 * (`channels: ImChannelInstance[]`, multi-bot: the same channel type may
 * appear many times).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * MECHANISM (verified against installed packages, not assumptions):
 *  - The official API gateway (`dsh-host-apiproxy`) exposes only an
 *    allowlist of settings namespaces to the Web client; third-party
 *    namespaces get `settings-not-exposed` on both describe and update.
 *    So this page does NOT use `api.settings.*` / `settingsScope` for the
 *    `im-gateway` namespace — it calls the host Typert Remote service
 *    `imGatewayRemote` (src/remote.ts) through `ctx.remote`: the official
 *    channel for business packages to expose RPC to the Web client
 *    (see docs/api-gateway.md in the harness repo + the dsh-skill-viewer
 *    reference bundle).
 *  - This bundle ships through `exports["./client"]` + package.json
 *    `dsh.client` (platform: "web"). `dsh-client-modules` discovers the
 *    loader entry named `@lijian-ui/dsh-im-gateway`, serves
 *    `/plugins/@lijian-ui/dsh-im-gateway/client.js`, and the browser half loads via the
 *    CJS factory format `window.__ModuleLoader__.load({ id, factory })`.
 *  - `settings.section` is a list slot; the settings shell
 *    (`dsh-client-ui-settings-general`) sorts entries by `order` into the
 *    left nav. Models uses `order: 10`; we use `order: 20` → "IM 通道" below it.
 *  - Saves send the COMPLETE channels array (host replaces arrays
 *    wholesale, and blank secrets are merged back from storage server-side).
 *
 * This file is the BROWSER half — it must not import host code, must not
 * import non-platform modules, and its built output is plain JS. Keep it
 * dependency-light: React + cordis only.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only pulls the SlotMap merge that declares `settings.section`
// (the settings domain owns that slot's type home).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { ImChannelsSection } from './ImChannelsSection.ts'
import { createConfigApi } from './config-api.ts'

/** Section identity in the Settings left-nav rail. */
const SECTION_ID = 'im-channels'
/** Sits below Models (order 10) in the settings nav. */
const SECTION_ORDER = 20

/** Services this browser plugin requires (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'remote']

/**
 * Mount the IM channels settings page.
 * @param ctx - the browser plugin context (guarded facade).
 */
export function apply(ctx: ClientContext): void {
  const configApi = createConfigApi(ctx)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: SECTION_ORDER,
    label: () => 'IM 通道',
    inject: () => ({ configApi }),
  }, ImChannelsSection))
}
