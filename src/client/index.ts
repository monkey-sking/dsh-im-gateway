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
import { zh as clientZh, en as clientEn } from './client-i18n.ts'

/** Section identity in the Settings left-nav rail. */
const SECTION_ID = 'im-channels'
/** Sits below Models (order 10) in the settings nav. */
const SECTION_ORDER = 20
/** i18n namespace for this plugin's client-side text. */
const I18N_NS = 'im-gateway'

/** Services this browser plugin requires (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'remote']

/**
 * Mount the IM channels settings page.
 * @param ctx - the browser plugin context (guarded facade).
 */
export function apply(ctx: ClientContext): void {
  const configApi = createConfigApi(ctx)

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

  // 导航图标补丁：官方设置外壳（dsh-client-ui-settings-general）的 navIcon() 按
  // section id 硬编码映射，未识别的 id 一律回退到齿轮，且未提供图标扩展点。
  // 故监听 DOM，将「IM 通道」导航项的齿轮替换为官方图标库同款 IconSendOutline16
  // （纸飞机发送，即时消息语义）。
  // 若未来官方开放了图标注册接口，应优先改用官方方案并移除此处补丁。
  const navLabels = new Set<string>([clientZh['section.label'], clientEn['section.label']])
  const imNavSvg = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" data-imgw-nav="1">'
    + '<path d="M8.3125 0.981587C8.66767 1.0545 8.97902 1.20558 9.2627 1.43374C9.48724 1.61438 9.73029 1.85933 9.97949 2.10854L14.707 6.83608L13.293 8.25014L9 3.95717V15.0431H7V3.95717L2.70703 8.25014L1.29297 6.83608L6.02051 2.10854C6.26971 1.85933 6.51277 1.61438 6.7373 1.43374C6.97662 1.24126 7.28445 1.04542 7.6875 0.981587C7.8973 0.94841 8.1031 0.956564 8.3125 0.981587Z" fill="currentColor"/>'
    + '</svg>'
  const patchNavIcon = (): void => {
    if (typeof document === 'undefined') return
    for (const span of Array.from(document.querySelectorAll('button > span'))) {
      if (!navLabels.has(span.textContent ?? '')) continue
      const button = span.parentElement
      if (button === null) continue
      const stale = button.querySelector('svg:not([data-imgw-nav])')
      if (stale === null) continue
      const template = document.createElement('template')
      template.innerHTML = imNavSvg
      const next = template.content.firstElementChild
      if (next === null) continue
      const cls = stale.getAttribute('class')
      if (cls !== null) next.setAttribute('class', cls)
      stale.replaceWith(next)
    }
  }
  if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined' && document.body !== null) {
    let scheduled = false
    const schedule = (): void => {
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        patchNavIcon()
      })
    }
    patchNavIcon()
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true })
  }
}
