/**
 * IM Channels settings section (browser half).
 *
 * Renders the whole IM bundle config on one page: header with an "Add channel"
 * button (top-right), channel instances GROUPED BY TYPE (钉钉 / QQ / 个人微信 —
 * each type may have MULTIPLE bot instances), empty state, and the add/edit
 * modal. Data lives in the `im-gateway` config as `channels: ImChannelInstance[]`
 * and is read/written through the host config route (see config-api.ts) — the
 * official `api.settings.*` refuses third-party namespaces.
 *
 * Browser-half constraints: no JSX (React.createElement), no CSS modules
 * (inline styles), no lucide icons (inline SVG), platform modules only.
 */
import { createElement, useEffect, useState } from 'react'
import {
  ImChannelModal,

  TYPE_ORDER,
  type ChannelDraft,
  type ImChannelInstance,
} from './ImChannelModal.ts'
import type { ChannelStatus } from '../gateway/types'
import type { ConfigApi } from './config-api.ts'

export interface ImChannelsSectionProps {
  /** Config read/write api (host route backed). */
  configApi: ConfigApi
  /** Translation function (bound to 'im-gateway' namespace). */
  t: (key: string, params?: Record<string, unknown>) => string
}

// ── inline styles (ported from pi-desk-top ImPage.module.css) ──

const page: React.CSSProperties = { display: 'flex', flexDirection: 'column', minWidth: 0, width: '100%' }
const header: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 0', flexShrink: 0, borderBottom: '1px solid var(--dsw-alias-border-l2, #eee)' }
const titleRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }
const title: React.CSSProperties = { fontSize: 17, fontWeight: 500, color: 'var(--dsw-alias-label-primary, inherit)', margin: 0, whiteSpace: 'nowrap' }
const countBadge: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 22, height: 22, padding: '0 7px', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-3, #eee)', color: 'var(--dsw-alias-label-secondary, #555)', fontSize: 11, fontWeight: 500 }
const headerRight: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }
const addBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 14px', border: 'none', borderRadius: 8, background: 'var(--dsw-alias-state-business-primary, #185FA5)', color: '#fff', fontSize: 13, fontWeight: 500, cursor: 'pointer' }
const body: React.CSSProperties = { flex: 1, overflowY: 'auto', padding: '16px 0 24px', display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 760, width: '100%' }
const errorStyle: React.CSSProperties = { fontSize: 12, lineHeight: 1.5, color: 'var(--dsw-alias-state-error-primary, #e24b4a)', padding: '10px 14px', background: 'rgba(226,75,74,0.08)', border: '1px solid rgba(226,75,74,0.35)', borderRadius: 8, whiteSpace: 'pre-wrap' }
const empty: React.CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 6, padding: '32px 24px', border: '1px dashed var(--dsw-alias-border-l3, #ccc)', borderRadius: 10, background: 'var(--dsw-alias-bg-layer-1, transparent)', textAlign: 'center' }
const emptyText: React.CSSProperties = { margin: 0, fontSize: 13, color: 'var(--dsw-alias-label-secondary, #555)' }
const group: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8 }
const groupHead: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }
const groupTitle: React.CSSProperties = { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary, inherit)', margin: 0 }
const groupCount: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', minWidth: 18, height: 18, padding: '0 6px', borderRadius: 999, background: 'var(--dsw-alias-bg-layer-3, #eee)', color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 10, fontWeight: 500 }
const channelList: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 10 }
const channelCard: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 14, padding: '14px 16px', background: 'var(--dsw-alias-bg-layer-2, transparent)', border: '1px solid var(--dsw-alias-border-l2, #e0e0e0)', borderRadius: 10 }
const channelIcon: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 32, height: 32, borderRadius: 8, background: 'var(--dsw-alias-bg-layer-3, #eee)', color: 'var(--dsw-alias-label-secondary, #555)', flexShrink: 0 }
const channelInfo: React.CSSProperties = { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }
const channelNameRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }
const channelName: React.CSSProperties = { fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary, inherit)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const statusDot: React.CSSProperties = { width: 8, height: 8, borderRadius: '50%', flexShrink: 0 }

/** Color for a channel runtime status dot. */
function statusColor(s?: ChannelStatus): string {
  if (s?.status === 'online') return 'var(--dsw-alias-state-success-primary, #1D9E75)'
  if (s?.status === 'error') return 'var(--dsw-alias-state-error-primary, #e24b4a)'
  return 'var(--dsw-alias-label-tertiary, #bdbdbd)'
}
const badge: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', fontSize: 10, lineHeight: 1, padding: '3px 9px', borderRadius: 999, border: '1px solid transparent', flexShrink: 0, fontWeight: 500 }
const badgeOff: React.CSSProperties = { ...badge, color: 'var(--dsw-alias-state-error-primary, #e24b4a)', borderColor: 'rgba(226,75,74,0.35)', background: 'rgba(226,75,74,0.08)' }
const badgeOn: React.CSSProperties = { ...badge, color: 'var(--dsw-alias-state-success-primary, #1D9E75)', borderColor: 'rgba(29,158,117,0.35)', background: 'rgba(29,158,117,0.08)' }
const channelSub: React.CSSProperties = { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #888)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const channelActions: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }
const iconBtn: React.CSSProperties = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44, border: 'none', borderRadius: 6, background: 'transparent', color: 'var(--dsw-alias-label-tertiary, #888)', cursor: 'pointer' }

/** Edit button — text style matching the official models settings page (secondaryButton). */
const editBtn: React.CSSProperties = { boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: 28, padding: '0 10px', fontSize: 12, lineHeight: '18px', borderRadius: 14, border: '1px solid var(--dsw-alias-border-l2, #ddd)', background: 'transparent', color: 'var(--dsw-alias-label-primary, inherit)', cursor: 'pointer' }

/** Delete button — text style matching the official models settings page (dangerButton). */
const deleteBtn: React.CSSProperties = { boxSizing: 'border-box', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', height: 28, padding: '0 10px', fontSize: 12, lineHeight: '18px', borderRadius: 14, border: 'none', background: 'transparent', color: 'var(--dsw-alias-state-error-primary, #e24b4a)', cursor: 'pointer' }
const toggleBtn: React.CSSProperties = { position: 'relative', width: 36, height: 21, border: 'none', borderRadius: 999, background: 'var(--dsw-alias-border-l2, #ccc)', cursor: 'pointer', padding: 0, flexShrink: 0 }
const toggleOn: React.CSSProperties = { ...toggleBtn, background: 'var(--dsw-alias-state-business-primary, #185FA5)' }
const toggleKnob: React.CSSProperties = { position: 'absolute', left: 2, top: 2, width: 17, height: 17, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.25)', transition: 'left 0.15s ease' }
const toggleKnobOn: React.CSSProperties = { ...toggleKnob, left: 17 }

/**
 * Official brand glyphs per channel type (24×24 fill paths — QQ/WeChat from
 * Simple Icons, DingTalk from MingCute, WeCom from TDesign; CC0/Apache/MIT).
 * Unknown types fall back to the DingTalk glyph.
 */
const BRAND_PATHS: Record<string, string> = {
  qq: 'M21.395 15.035a40 40 0 0 0-.803-2.264l-1.079-2.695c.001-.032.014-.562.014-.836C19.526 4.632 17.351 0 12 0S4.474 4.632 4.474 9.241c0 .274.013.804.014.836l-1.08 2.695a39 39 0 0 0-.802 2.264c-1.021 3.283-.69 4.643-.438 4.673c.54.065 2.103-2.472 2.103-2.472c0 1.469.756 3.387 2.394 4.771c-.612.188-1.363.479-1.845.835c-.434.32-.379.646-.301.778c.343.578 5.883.369 7.482.189c1.6.18 7.14.389 7.483-.189c.078-.132.132-.458-.301-.778c-.483-.356-1.233-.646-1.846-.836c1.637-1.384 2.393-3.302 2.393-4.771c0 0 1.563 2.537 2.103 2.472c.251-.03.581-1.39-.438-4.673',
  weixin: 'M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213c0 .163.13.295.29.295a.33.33 0 0 0 .167-.054l1.903-1.114a.86.86 0 0 1 .717-.098a10.2 10.2 0 0 0 2.837.403c.276 0 .543-.027.811-.05c-.857-2.578.157-4.972 1.932-6.446c1.703-1.415 3.882-1.98 5.853-1.838c-.576-3.583-4.196-6.348-8.596-6.348M5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178a1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18m5.34 2.867c-1.797-.052-3.746.512-5.28 1.786c-1.72 1.428-2.687 3.72-1.78 6.22c.942 2.453 3.666 4.229 6.884 4.229c.826 0 1.622-.12 2.361-.336a.72.72 0 0 1 .598.082l1.584.926a.3.3 0 0 0 .14.047c.134 0 .24-.111.24-.247c0-.06-.023-.12-.038-.177l-.327-1.233a.6.6 0 0 1-.023-.156a.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983a.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983a.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982',
  dingtalk: 'M6.802 2.02a1 1 0 0 1 .849.22l9.751 8.359a2 2 0 0 1 .235 2.799l-1.06 1.272l.87.436a1 1 0 0 1 .134 1.708l-7 5a1 1 0 0 1-1.539-1.101l1.21-4.034c-2.363-.9-3.747-3.055-4.233-5.483A1 1 0 0 1 7.01 10c-.474-.703-.86-1.42-1.134-2.149c-.649-1.73-.658-3.523.23-5.298a1 1 0 0 1 .696-.533',
  wecom: 'm17.326 8.158l-.003-.007a6.6 6.6 0 0 0-1.178-1.674c-1.266-1.307-3.067-2.19-5.102-2.417a9.3 9.3 0 0 0-2.124 0h-.001c-2.061.228-3.882 1.107-5.14 2.405a6.7 6.7 0 0 0-1.194 1.682A5.7 5.7 0 0 0 2 10.657c0 1.106.332 2.218.988 3.201l.006.01c.391.594 1.092 1.39 1.637 1.83l.983.793l-.208.875l.527-.267l.708-.358l.761.225c.467.137.955.227 1.517.29h.005q.515.06 1.026.059c.355 0 .724-.02 1.095-.06a9 9 0 0 0 1.346-.258c.095.7.43 1.337.932 1.81c-.658.208-1.352.358-2.061.436c-.442.048-.883.072-1.312.072q-.627 0-1.253-.072a10.7 10.7 0 0 1-1.861-.36l-2.84 1.438s-.29.131-.44.131c-.418 0-.702-.285-.702-.704c0-.252.067-.598.128-.84l.394-1.653c-.728-.586-1.563-1.544-2.052-2.287A7.76 7.76 0 0 1 0 10.658a7.7 7.7 0 0 1 .787-3.39a8.7 8.7 0 0 1 1.551-2.19c1.61-1.665 3.878-2.73 6.359-3.006a11.3 11.3 0 0 1 2.565 0c2.47.275 4.712 1.353 6.323 3.017a8.6 8.6 0 0 1 1.539 2.192c.466.945.769 1.937.769 2.978a3.06 3.06 0 0 0-2-.005c-.001-.644-.189-1.329-.564-2.09zm4.125 6.977l-.024-.024l-.024-.018l-.024-.018l-.096-.095a4.24 4.24 0 0 1-1.169-2.192q0-.038-.006-.075l-.006-.056l-.035-.144a1.3 1.3 0 0 0-.358-.61a1.386 1.386 0 0 0-1.957 0a1.4 1.4 0 0 0 0 1.963c.191.191.418.311.668.371c.024.012.06.012.084.012q.019 0 .041.006q.023.005.042.006a4.24 4.24 0 0 1 2.231 1.186c.048.048.096.095.131.143a.323.323 0 0 0 .466 0a.35.35 0 0 0 .036-.455m-1.05 4.37l-.025.025c-.119.096-.31.096-.453-.036a.326.326 0 0 1 0-.467c.047-.036.094-.083.141-.13l.002-.002a4.27 4.27 0 0 0 1.187-2.28q.005-.024.006-.043c0-.024 0-.06.012-.084a1.386 1.386 0 0 1 2.326-.67a1.4 1.4 0 0 1 0 1.964c-.167.18-.382.299-.608.359l-.143.036l-.057.005q-.035.006-.075.007a4.2 4.2 0 0 0-2.183 1.173l-.095.096q-.009.01-.018.024t-.018.024m-4.392-1.053l.024.024l.024.018q.015.009.024.018l.096.096a4.25 4.25 0 0 1 1.169 2.19q0 .04.006.076q.005.03.006.057l.035.143c.06.228.18.443.358.611c.537.539 1.42.539 1.957 0a1.4 1.4 0 0 0 0-1.964a1.4 1.4 0 0 0-.668-.371c-.024-.012-.06-.012-.084-.012q-.018 0-.041-.006l-.042-.006a4.25 4.25 0 0 1-2.231-1.185a1.4 1.4 0 0 1-.131-.144a.323.323 0 0 0-.466 0a.325.325 0 0 0-.036.455m1.039-4.358l.024-.024a.32.32 0 0 1 .453.035a.326.326 0 0 1 0 .467c-.047.036-.094.083-.141.13l-.002.002a4.27 4.27 0 0 0-1.187 2.281l-.006.042c0 .024 0 .06-.012.084a1.386 1.386 0 0 1-2.326.67a1.4 1.4 0 0 1 0-1.963c.166-.18.381-.3.608-.36l.143-.035q.026 0 .056-.006q.037-.005.075-.006a4.2 4.2 0 0 0 2.183-1.174l.096-.095l.018-.025z',
}

/** Official brand accent colors (fallback to currentColor when unset). */
const BRAND_COLORS: Record<string, string> = {
  qq: '#12B7F5',
  weixin: '#07C160',
  dingtalk: '#0089FF',
  wecom: '#0082EF',
}

/** Channel-type icon as inline SVG (official brand glyphs). */
function ChannelGlyph({ type }: { type: string }) {
  const d = BRAND_PATHS[type] ?? BRAND_PATHS.dingtalk
  const color = BRAND_COLORS[type]
  return createElement('svg', {
    width: 20,
    height: 20,
    viewBox: '0 0 24 24',
    fill: color ?? 'currentColor',
    'aria-hidden': true,
  },
    createElement('path', { d }),
  )
}

/**
 * Render the IM channels settings page.
 * @param props - injected config api.
 */
export function ImChannelsSection(props: ImChannelsSectionProps) {
  const { configApi, t } = props

  const [channels, setChannels] = useState<ImChannelInstance[]>([])
  const [revision, setRevision] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [modalOpen, setModalOpen] = useState(false)
  const [editId, setEditId] = useState<string | undefined>(undefined)
  const [pendingDelete, setPendingDelete] = useState<string | undefined>(undefined)
  const [error, setError] = useState('')
  const [statuses, setStatuses] = useState<Record<string, ChannelStatus>>({})

  // Initial load — MUST stay at component top level (Hooks rules).
  useEffect(() => {
    let current = true
    configApi.load().then((result) => {
      if (!current) return
      if (!result.ok) {
        setError(result.message ?? t('error.loadFailed'))
      } else {
        setChannels(Array.isArray(result.channels) ? result.channels : [])
        setRevision(result.revision)
      }
      setLoading(false)
    })
    return () => { current = false }
  }, [configApi])

  // Poll live channel runtime statuses (online/offline/error) every 5s.
  useEffect(() => {
    let current = true
    const tick = async () => {
      const result = await configApi.statuses()
      if (current && result.ok && result.statuses) setStatuses(result.statuses)
    }
    void tick()
    const id = setInterval(tick, 5000)
    return () => { current = false; clearInterval(id) }
  }, [configApi])

  /** Load fresh state after a write. */
  const refresh = async (): Promise<void> => {
    const result = await configApi.load()
    if (!result.ok) {
      setError(result.message ?? t('error.refreshFailed'))
      return
    }
    setChannels(Array.isArray(result.channels) ? result.channels : [])
    setRevision(result.revision)
    setError('')
  }

  /** Wholesale-replace the channels array through the host route. */
  const writeChannels = async (next: ImChannelInstance[]): Promise<void> => {
    setError('')
    const result = await configApi.save(next, revision)
    if (!result.ok) {
      setError(result.message ?? t('error.saveFailed', { 0: result.code ?? 'unknown' }))
      throw new Error(result.message ?? 'save failed')
    }
    await refresh()
  }

  const handleSave = async (draft: ChannelDraft): Promise<void> => {
    await writeChannels(draft.channels)
    setModalOpen(false)
    setEditId(undefined)
  }

  const handleToggle = async (id: string, current: boolean): Promise<void> => {
    const next = channels.map((inst) => (inst.id === id ? { ...inst, enabled: !current } : { ...inst }))
    await writeChannels(next)
  }

  const handleDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    const id = pendingDelete
    setPendingDelete(undefined)
    const next = channels.filter((inst) => inst.id !== id)
    await writeChannels(next)
  }

  const groups = TYPE_ORDER.map((type) => ({
    type,
    label: type === 'dingtalk' ? t('type.dingtalk') : type === 'qq' ? t('type.qq') : type === 'weixin' ? t('type.weixin') : type,
    items: channels.filter((inst) => inst.type === type),
  }))

  return createElement('div', { style: page },
    createElement('div', { style: header },
      createElement('div', { style: titleRow },
        createElement('h2', { style: title }, t('page.title')),
        channels.length > 0 ? createElement('span', { style: countBadge }, String(channels.length)) : null,
      ),
      createElement('div', { style: headerRight },
        createElement('button', { style: addBtn, onClick: () => { setEditId(undefined); setModalOpen(true) } },
          createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' },
            createElement('path', { d: 'M8 3v10M3 8h10' }),
          ),
          createElement('span', null, t('btn.add')),
        ),
      ),
    ),
    createElement('div', { style: body },
      error ? createElement('div', { style: errorStyle }, error) : null,
      loading ? createElement('div', { style: empty }, createElement('p', { style: emptyText }, t('state.loading'))) : (
        channels.length === 0 ? (
          createElement('div', { style: empty },
            createElement('p', { style: emptyText }, t('state.empty')),
          )
        ) : (
          createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 16 } },
            groups.filter((g) => g.items.length > 0).map((group) => (
              createElement('div', { key: group.type, style: group },
                createElement('div', { style: groupHead },
                  createElement('span', { style: channelIcon }, createElement(ChannelGlyph, { type: group.type })),
                  createElement('span', { style: groupTitle }, group.label),
                  createElement('span', { style: groupCount }, String(group.items.length)),
                ),
                createElement('div', { style: channelList },
                  group.items.map((inst) => (
                    createElement('div', { key: inst.id, style: channelCard },
                      createElement('span', { style: channelIcon }, createElement(ChannelGlyph, { type: inst.type })),
                      createElement('div', { style: channelInfo },
                        createElement('div', { style: channelNameRow },
                          createElement('span', { style: { ...statusDot, background: statusColor(statuses[inst.id]) }, title: statuses[inst.id]?.status ?? 'unknown' }),
                          createElement('span', { style: channelName }, inst.name || (inst.type === 'dingtalk' ? t('type.dingtalk') : inst.type === 'qq' ? t('type.qq') : inst.type === 'weixin' ? t('type.weixin') : inst.type)),
                          createElement('span', { style: inst.enabled ? badgeOn : badgeOff }, inst.enabled ? t('badge.connected') : t('badge.disabled')),
                        ),
                        createElement('span', { style: channelSub }, inst.id),
                      ),
                      createElement('span', { style: channelActions },
                        createElement('button', {
                          type: 'button',
                          style: inst.enabled ? toggleOn : toggleBtn,
                          title: inst.enabled ? t('toggle.disable') : t('toggle.enable'),
                          onClick: () => void handleToggle(inst.id, inst.enabled),
                        }, createElement('span', { style: inst.enabled ? toggleKnobOn : toggleKnob })),
                        createElement('button', { type: 'button', style: editBtn, onClick: () => { setEditId(inst.id); setModalOpen(true) } }, t('btn.edit')),
                        createElement('button', { type: 'button', style: deleteBtn, onClick: () => setPendingDelete(inst.id) }, t('btn.delete')),

                      ),
                    )
                  )),
                ),
              )
            )),
          )
        )
      ),
    ),
    modalOpen ? createElement(ImChannelModal, {
      editId,
      instances: channels,
      configApi,
      t,
      onClose: () => { setModalOpen(false); setEditId(undefined) },
      onSave: handleSave,
    }) : null,
    pendingDelete !== undefined ? createElement('div', {
      style: { position: 'fixed', inset: 0, zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.5)', padding: 24 },
      onMouseDown: (e: React.MouseEvent) => { if (e.target === e.currentTarget) setPendingDelete(undefined) },
    },
      createElement('div', {
        style: { display: 'flex', flexDirection: 'column', gap: 12, width: 380, maxWidth: '100%', background: 'var(--dsw-alias-bg-layer-2, #fff)', border: '1px solid var(--dsw-alias-border-l2, #ddd)', borderRadius: 14, padding: '18px', boxShadow: '0 20px 48px rgba(0,0,0,0.36)' },
        onClick: (e: React.MouseEvent) => e.stopPropagation(),
      },
        createElement('div', { style: { fontSize: 15, fontWeight: 500 } }, t('delete.title')),
        createElement('p', { style: { fontSize: 13, color: 'var(--dsw-alias-label-secondary, #555)', margin: 0 } }, t('delete.confirm')),
        createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 } },
          createElement('button', { style: { height: 32, padding: '0 14px', background: 'transparent', color: 'inherit', border: '1px solid var(--dsw-alias-border-l2, #ccc)', borderRadius: 8, cursor: 'pointer', fontSize: 13 }, onClick: () => setPendingDelete(undefined) }, t('btn.cancel')),
          createElement('button', { style: { height: 32, padding: '0 14px', background: 'var(--dsw-alias-state-error-primary, #e24b4a)', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13 }, onClick: () => void handleDelete() }, t('btn.confirmDelete')),
        ),
      ),
    ) : null,
  )
}
