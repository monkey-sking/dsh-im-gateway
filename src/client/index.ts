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
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only pulls the Context.slots service for settings.section registration.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only pulls the SlotMap merge that declares `settings.section`
// (the settings domain owns that slot's type home).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only pulls the Context.locale merge (the locale domain owns that service's type home).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { ImChannelsSection } from './ImChannelsSection.ts'
import { createConfigApi } from './config-api.ts'
import { zh as clientZh, en as clientEn } from './client-i18n.ts'

/** Section identity in the Settings left-nav rail. */
const SECTION_ID = 'im-channels'
/** Sits below Models (order 10) in the settings nav. */
const SECTION_ORDER = 20
/** i18n namespace for this plugin's client-side text. */
const I18N_NS = 'im-gateway'

// Register this plugin's dictionary keys in the locale namespace map so
// ctx.locale.register/bind accept the 'im-gateway' namespace key. The map
// value is the key union (LocaleKeysOf intersects it with string).
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'im-gateway': keyof typeof clientZh
  }
}

/** Services this browser plugin requires (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'remote', 'sessions']

/**
 * Mount the IM channels settings page.
 * @param ctx - the browser plugin context (guarded facade).
 */
export function apply(ctx: ClientContext): void {
  const configApi = createConfigApi(ctx)

  // 让前端对"IM 渠道新消息所在的历史会话"建立实时订阅（对话页/列表现实时渲染）。
  // 背景：dsh 前端只为"当前选中打开"的会话创建 follow 实时流；QQ 等 IM 渠道在
  // 历史会话(sessionId 稳定不变)里产生新消息时，前端没对该会话建立订阅，故对话页
  // 不追渲染。方案：复用官方 api-session/activity 事件（host 对 user/message 触发并
  // 经 remote 转发到前端），收到后调用 ctx.sessions.open(id) 把该会话置为 current，
  // 前端随之为其建立 follow 流 → 新消息实时渲染。绑定于 ctx 生命周期，随 fiber 自动清理。
  ctx.remote.$on('api-session/activity', (sessionId: string) => {
    // IM 渠道在稳定的历史会话(sessionId 不变)里产生新消息时，dsh 前端只为"当前打开"
    // 的会话建立 follow 实时流，故对话页不追渲染。收到官方 api-session/activity 事件
    // (host 对 user/message 触发并经 remote 转发)后把该会话置为 current，前端随即
    // 为其建立 follow 流 → 新消息实时渲染。绑定于 ctx 生命周期，随 fiber 自动清理。
    if (typeof sessionId !== 'string' || sessionId === '') return
    const sessions = ctx.get('sessions') as { open(id: string): void } | undefined
    if (sessions === undefined) return
    try {
      sessions.open(sessionId)
    } catch {
      /* 打开未知或已打开的会话是非致命的 */
    }
  })

  // Register bilingual dictionaries with the dsh locale service.
  ctx.effect(() => ctx.locale.register(I18N_NS, { zh: clientZh, en: clientEn }), 'im-gateway: client dictionaries')

  // Bind the translation function — t(key, params) always returns the
  // current language's text (re-evaluated on each call, so slot-rendered
  // copy follows locale/change automatically).
  const t = ctx.locale.bind(I18N_NS)

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: SECTION_ORDER,
    label: () => t('section.label'),
    inject: () => ({ configApi, t }),
  }, ImChannelsSection))
}
