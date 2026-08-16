/**
 * Add / edit IM channel modal (browser half).
 *
 * Ported from pi-desk-top/src/renderer/im/ImChannelModal.tsx, adapted to the
 * multi-instance model: the bundle's `im-gateway` namespace holds
 * `channels: ImChannelInstance[]`, and the SAME channel type may appear many
 * times (multi-bot support). The modal either adds a brand-new instance
 * (type picker + name + credentials; a unique `<type>-<rand>` id is minted)
 * or edits an existing one (type locked, values prefilled).
 *
 * Saving hands the COMPLETE new channels array to the parent section via
 * `onSave` (host `mergeLayers` replaces arrays wholesale, so the caller must
 * write the full array — see docs/plugin-development.md §10).
 *
 * Browser-half constraints: no JSX (React.createElement), no CSS modules
 * (inline styles), no lucide icons (inline SVG), platform modules only.
 */
import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import type { ConfigApi, QrLoginStatus } from './config-api.ts'

/** The single settings namespace owning every channel config. */
export const BUNDLE_NS = 'im-gateway'

/** Channel type literal (must mirror the host-side ChannelType). */
export type ChannelType = 'dingtalk' | 'qq' | 'weixin'

/** One channel instance, as stored in `channels[]` (host: ImChannelInstance). */
export interface ImChannelInstance {
  id: string
  type: ChannelType
  name: string
  enabled: boolean
  config: Record<string, unknown>
}

/** Display label per channel type. */
export const TYPE_LABELS: Record<string, string> = {
  dingtalk: '钉钉',
  qq: 'QQ',
  weixin: '个人微信',
}

/** Display order of the type groups on the page. */
export const TYPE_ORDER: ChannelType[] = ['dingtalk', 'qq', 'weixin']

/**
 * Credential fields per channel type. qq / weixin are QR-scan bound: their
 * fields are HIDDEN from the form (the QR flow fills them), but the keys are
 * still needed to initialize/save values. dingtalk stays a manual form.
 */
const TYPE_FIELDS: Record<string, { key: string; label: string; secret?: boolean; type?: string }[]> = {
  dingtalk: [
    { key: 'clientId', label: 'AppKey (clientId)' },
    { key: 'clientSecret', label: 'AppSecret (clientSecret)', secret: true },
  ],
  qq: [],
  weixin: [],
}

/** Every credential key per type — used to init/persist QR-hidden values. */
const TYPE_CREDENTIAL_KEYS: Record<string, string[]> = {
  dingtalk: ['clientId', 'clientSecret'],
  qq: ['appId', 'clientSecret', 'botAppId'],
  weixin: ['token', 'botId', 'baseUrl', 'cdnBaseUrl'],
}

export interface ChannelDraft {
  /** The COMPLETE new channels array (replace semantics on the host side). */
  channels: ImChannelInstance[]
  /** Id of the instance this draft added or edited. */
  instanceId: string
}

export interface ImChannelModalProps {
  /** Instance id to edit (undefined = add a new instance). */
  editId?: string
  /** Current channels array (prefill + id-collision avoidance). */
  instances: ImChannelInstance[]
  /** Config api — used for QR-scan login on qq / weixin types. */
  configApi?: ConfigApi
  onClose: () => void
  onSave: (draft: ChannelDraft) => Promise<void>
}

// ── inline styles (ported from ImChannelModal.module.css, token-based) ──

const overlay: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 300,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(0, 0, 0, 0.5)',
  padding: 24,
}

const modal: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  width: 520,
  maxWidth: '100%',
  maxHeight: '90vh',
  background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, #fff))',
  border: '1px solid var(--dsw-alias-border-l2, #ddd)',
  borderRadius: 14,
  overflow: 'hidden',
  boxShadow: '0 20px 48px rgba(0,0,0,0.36), 0 4px 12px rgba(0,0,0,0.2)',
}

const modalHeader: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '14px 18px',
  borderBottom: '1px solid var(--dsw-alias-border-l1, #eee)',
  flexShrink: 0,
}

const modalTitle: React.CSSProperties = {
  flex: 1,
  fontSize: 16,
  fontWeight: 500,
  color: 'var(--dsw-alias-label-primary, inherit)',
  margin: 0,
}

const closeBtn: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 28,
  height: 28,
  border: 'none',
  background: 'transparent',
  color: 'var(--dsw-alias-label-tertiary, #888)',
  cursor: 'pointer',
  borderRadius: 6,
  fontSize: 16,
  lineHeight: 1,
}

const modalBody: React.CSSProperties = {
  flex: 1,
  overflowY: 'auto',
  padding: '18px 18px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
}

const field: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
}

const fieldLabel: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary, #555)',
  fontWeight: 500,
}

const required: React.CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary, #e24b4a)',
  marginLeft: 2,
}

const input: React.CSSProperties = {
  height: 40,
  padding: '0 12px',
  background: 'var(--dsw-alias-bg-layer-1, transparent)',
  border: '1px solid var(--dsw-alias-border-l2, #ccc)',
  borderRadius: 8,
  color: 'var(--dsw-alias-label-primary, inherit)',
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
}

const selectInput: React.CSSProperties = { ...input, cursor: 'pointer' }

const errorStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-state-error-primary, #e24b4a)',
  padding: '8px 12px',
  background: 'rgba(226, 75, 74, 0.08)',
  borderRadius: 6,
}

const footer: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'flex-end',
  gap: 8,
  padding: '14px 18px',
  borderTop: '1px solid var(--dsw-alias-border-l1, #eee)',
  flexShrink: 0,
}

const btnGhost: React.CSSProperties = {
  height: 36,
  padding: '0 16px',
  background: 'transparent',
  color: 'var(--dsw-alias-label-secondary, #555)',
  border: '1px solid var(--dsw-alias-border-l2, #ccc)',
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: 13,
}

const btnPrimary: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  height: 36,
  padding: '0 18px',
  background: 'var(--dsw-alias-state-business-primary, #185FA5)',
  color: '#fff',
  border: 'none',
  borderRadius: 8,
  cursor: 'pointer',
  fontSize: 13,
  fontWeight: 500,
}

// ── QR-scan login styles ──

const qrBox: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 10,
  padding: '16px',
  background: 'var(--dsw-alias-bg-layer-1, rgba(0,0,0,0.02))',
  border: '1px dashed var(--dsw-alias-border-l3, #ccc)',
  borderRadius: 10,
}

const qrImg: React.CSSProperties = {
  width: 200,
  height: 200,
  borderRadius: 8,
  objectFit: 'contain',
  background: '#fff',
}

const qrHint: React.CSSProperties = {
  margin: 0,
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary, #555)',
  textAlign: 'center',
  lineHeight: 1.5,
  wordBreak: 'break-all',
}

const qrRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  width: '100%',
  justifyContent: 'center',
}

const qrLink: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--dsw-alias-state-business-primary, #185FA5)',
  textDecoration: 'none',
  cursor: 'pointer',
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

/** Mint a unique instance id: `<type>-<rand>` (never contains ':'). */
export function mintInstanceId(type: string, existing: ImChannelInstance[]): string {
  for (let i = 0; i < 50; i++) {
    const rand = Math.random().toString(36).slice(2, 6)
    const id = `${type}-${rand}`
    if (!existing.some((inst) => inst.id === id)) return id
  }
  return `${type}-${Date.now().toString(36)}`
}

/**
 * The add/edit channel modal.
 * @param props - edit target, current instances, close/save actions.
 */
export function ImChannelModal(props: ImChannelModalProps) {
  const { editId, instances, configApi, onClose, onSave } = props

  const editing = editId !== undefined ? instances.find((inst) => inst.id === editId) : undefined
  const initialType = (editing?.type ?? 'dingtalk') as string

  const [type, setType] = useState<string>(initialType)
  const [name, setName] = useState<string>(editing?.name ?? '')
  const [values, setValues] = useState<Record<string, string>>(() => {
    const pre = (editing?.config ?? {}) as Record<string, unknown>
    const out: Record<string, string> = {}
    for (const key of TYPE_CREDENTIAL_KEYS[initialType] ?? []) {
      const v = pre[key]
      if (typeof v === 'string' || typeof v === 'number') out[key] = String(v)
      else out[key] = ''
    }
    return out
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // ── QR-scan login state (qq / weixin) ──
  const [qr, setQr] = useState<QrLoginStatus | null>(null)
  const [qrPolling, setQrPolling] = useState(false)
  const [verifyCode, setVerifyCode] = useState('')
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  // Poll the QR-login snapshot while a login is in flight.
  useEffect(() => {
    if (!qrPolling || !qr?.loginId || !configApi) return
    const loginId = qr.loginId
    const tick = async () => {
      const res = await configApi.getQrLoginStatus(loginId)
      if (!res.ok || !res.status) return
      setQr(res.status)
      // Terminal states stop the poll.
      const s = res.status.status
      if (s === 'confirmed' || s === 'error' || s === 'canceled' || s === 'expired') {
        setQrPolling(false)
      }
    }
    // Fetch immediately, then keep polling — the first snapshot comes back
    // with an empty QR (the connector fetches the code async), so an
    // immediate tick makes the QR appear as soon as it's ready.
    void tick()
    pollTimer.current = setInterval(() => void tick(), 1500)
    return () => {
      if (pollTimer.current) clearInterval(pollTimer.current)
      pollTimer.current = null
    }
  }, [qrPolling, qr?.loginId, configApi])

  // When a login confirms, auto-fill the credential fields from the result.
  useEffect(() => {
    if (!qr || qr.status !== 'confirmed' || !qr.credentials) return
    setValues((prev) => {
      const next = { ...prev }
      if (type === 'qq' && qr.credentials) {
        if (qr.credentials.appId) next.appId = qr.credentials.appId
        if (qr.credentials.appSecret) next.clientSecret = qr.credentials.appSecret
      }
      if (type === 'weixin' && qr.credentials) {
        if (qr.credentials.token) next.token = qr.credentials.token
        if (qr.credentials.botId) next.botId = qr.credentials.botId
        if (qr.credentials.baseUrl) next.baseUrl = qr.credentials.baseUrl
      }
      return next
    })
  }, [qr, type])

  const handleStartQrLogin = async () => {
    if (!configApi) return
    setError('')
    setVerifyCode('')
    const res = await configApi.startQrLogin(type)
    if (!res.ok || !res.status) {
      setError(res.message ?? '扫码登录启动失败')
      return
    }
    setQr(res.status)
    setQrPolling(true)
  }

  const handleSubmitVerifyCode = async () => {
    if (!qr?.loginId || !verifyCode.trim() || !configApi) return
    await configApi.submitQrVerifyCode(qr.loginId, verifyCode.trim())
    setVerifyCode('')
  }

  const handleCancelQrLogin = async () => {
    if (!qr?.loginId || !configApi) return
    await configApi.cancelQrLogin(qr.loginId)
    setQr(null)
    setQrPolling(false)
  }

  const fields = TYPE_FIELDS[type] ?? []
  const credentialKeys = TYPE_CREDENTIAL_KEYS[type] ?? []

  // Whether the current values already carry bound credentials (editing an
  // existing QR-bound channel). Used to show "已配置" instead of the
  // "尚未配置机器人凭据" hint when credentials exist.
  const hasCredentials = useMemo(() => {
    if (type === 'qq') {
      return (values['appId'] ?? '').trim() !== '' && (values['clientSecret'] ?? '').trim() !== ''
    }
    if (type === 'weixin') {
      return (values['token'] ?? '').trim() !== '' && (values['botId'] ?? '').trim() !== ''
    }
    return false
  }, [values, type])

  // dingtalk: manual credential form must be non-empty. qq/weixin: QR-scan
  // bound — the required field is the QR-derived token (appId+secret for qq,
  // token+botId for weixin); allow saving once those are present.
  const canSave = useMemo(() => {
    if (type === 'qq') {
      return (values['appId'] ?? '').trim() !== '' && (values['clientSecret'] ?? '').trim() !== ''
    }
    if (type === 'weixin') {
      return (values['token'] ?? '').trim() !== '' && (values['botId'] ?? '').trim() !== ''
    }
    const requiredKeys = fields.filter((f) => !f.secret).map((f) => f.key)
    return requiredKeys.every((k) => (values[k] ?? '').trim() !== '')
  }, [fields, values, type])

  const handleTypeChange = (next: string) => {
    setType(next)
    const out: Record<string, string> = {}
    for (const key of TYPE_CREDENTIAL_KEYS[next] ?? []) out[key] = ''
    setValues(out)
    setError('')
    setQr(null)
    setQrPolling(false)
    setVerifyCode('')
  }

  const handleEdit = (key: string, text: string) => {
    setValues((prev) => ({ ...prev, [key]: text }))
    setError('')
  }

  const handleSave = async () => {
    if (!canSave || !type) return
    setSaving(true)
    setError('')
    // All credential keys (including QR-hidden ones) → config. Number fields
    // → numbers; everything else stays string.
    const config: Record<string, unknown> = {}
    for (const key of credentialKeys) {
      const raw = (values[key] ?? '').trim()
      const fieldMeta = TYPE_FIELDS[type]?.find((f) => f.key === key)
      if (fieldMeta?.type === 'number') config[key] = raw === '' ? '' : Number(raw)
      else config[key] = raw
    }
    const next = instances.map((inst) => ({ ...inst }))
    let instanceId: string
    if (editing) {
      instanceId = editing.id
      const target = next.find((inst) => inst.id === instanceId)
      if (target) {
        target.name = name
        target.config = config
      }
    } else {
      instanceId = mintInstanceId(type, instances)
      next.push({ id: instanceId, type: type as ChannelType, name, enabled: true, config })
    }
    try {
      await onSave({ channels: next, instanceId })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  // Add mode: any type may be picked. Edit mode: locked to the instance's type.
  const typeOptions = Object.keys(TYPE_LABELS).filter((k) => editId === undefined || k === editing?.type)

  return createElement('div', { style: overlay, onMouseDown: (e: React.MouseEvent) => { if (e.target === e.currentTarget) onClose() } },
    createElement('div', { style: modal, onClick: (e: React.MouseEvent) => e.stopPropagation() },
      // Header
      createElement('div', { style: modalHeader },
        createElement('h3', { style: modalTitle }, editId ? `编辑通道 · ${TYPE_LABELS[editing?.type ?? ''] ?? ''}` : '添加通道'),
        createElement('button', { style: closeBtn, onClick: onClose, title: '关闭', 'aria-label': '关闭' },
          createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' },
            createElement('path', { d: 'M3 3l10 10M13 3L3 13' }),
          ),
        ),
      ),
      // Body
      createElement('div', { style: modalBody },
        // Channel type picker
        createElement('label', { style: field },
          createElement('span', { style: fieldLabel },
            '渠道类型',
            createElement('span', { style: required }, '*'),
          ),
          createElement('select', {
            style: selectInput,
            value: type,
            disabled: editId !== undefined,
            onChange: (e: React.ChangeEvent<HTMLSelectElement>) => handleTypeChange(e.target.value),
          },
            typeOptions.map((ct) => createElement('option', { key: ct, value: ct }, TYPE_LABELS[ct] ?? ct)),
          ),
        ),
        // Display name
        createElement('label', { style: field },
          createElement('span', { style: fieldLabel }, '通道名称'),
          createElement('input', {
            style: input,
            type: 'text',
            value: name,
            placeholder: `如：${TYPE_LABELS[type] ?? type}主机器人`,
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => { setName(e.target.value); setError('') },
          }),
        ),
        // Per-type credential fields
        fields.map((f) => createElement('label', { key: f.key, style: field },
          createElement('span', { style: fieldLabel },
            f.label,
            f.secret ? null : createElement('span', { style: required }, '*'),
          ),
          createElement('input', {
            style: input,
            type: f.secret ? 'password' : f.type === 'number' ? 'number' : 'text',
            value: values[f.key] ?? '',
            placeholder: f.secret ? '••••••••' : '',
            onChange: (e: React.ChangeEvent<HTMLInputElement>) => handleEdit(f.key, e.target.value),
          }),
        )),
        // QR-scan login (qq / weixin) — fill credentials automatically.
        (type === 'qq' || type === 'weixin') && configApi ? (
          createElement('div', { style: qrBox },
            qr && qr.status === 'confirmed' ? (
              createElement('p', { style: qrHint }, '✅ 扫码登录成功，凭据已自动填入下方字段，点击「保存」生效。')
            ) : qr && qr.qrcodeUrl ? (
              [
                createElement('img', { key: 'img', src: qr.qrcodeUrl, style: qrImg, alt: '登录二维码' }),
                createElement('p', { key: 'hint', style: qrHint }, qr.message || (type === 'qq' ? '请用手机 QQ 扫码绑定机器人' : '请用手机微信扫码') + '；若图片无法显示，可点击下方链接扫码'),
                createElement('div', { key: 'row', style: qrRow },
                  qr.qrcode ? createElement('a', { style: qrLink, href: qr.qrcode, target: '_blank', rel: 'noreferrer' }, qr.qrcode.slice(0, 60)) : null,
                  createElement('button', { style: btnGhost, onClick: () => void handleCancelQrLogin() }, '取消'),
                ),
                // WeChat pairing-code flow.
                qr.verifyCodeNeeded || qr.status === 'need_verifycode' ? (
                  createElement('div', { key: 'verify', style: { ...qrRow, marginTop: 4 } },
                    createElement('input', {
                      style: { ...input, width: 140, height: 32 },
                      type: 'text',
                      value: verifyCode,
                      placeholder: '输入配对码',
                      onChange: (e: React.ChangeEvent<HTMLInputElement>) => setVerifyCode(e.target.value),
                    }),
                    createElement('button', { style: btnPrimary, onClick: () => void handleSubmitVerifyCode(), disabled: !verifyCode.trim() }, '确认'),
                  )
                ) : null,
              ]
            ) : (
              [
                createElement('p', { key: 'hint', style: qrHint }, qr?.message || (hasCredentials
                  ? (type === 'qq' ? '已绑定机器人凭据（AppID 已自动填入）。如需更换，重新扫码即可。' : '已绑定微信凭据。如需更换，重新扫码即可。')
                  : (type === 'qq' ? '尚未配置机器人凭据？扫码绑定，免去在 QQ 开放平台手动创建' : '尚未绑定微信？扫码连接个人微信账号'))),
                createElement('button', {
                  key: 'start',
                  style: btnGhost,
                  onClick: () => void handleStartQrLogin(),
                  disabled: qrPolling,
                }, qrPolling ? '获取二维码中…' : `扫码登录（${TYPE_LABELS[type] ?? type}）`),
              ]
            ),
          )
        ) : null,
        error ? createElement('div', { style: errorStyle }, error) : null,
      ),
      // Footer
      createElement('div', { style: footer },
        createElement('button', { style: btnGhost, onClick: onClose }, '取消'),
        createElement('button', { style: btnPrimary, onClick: () => void handleSave(), disabled: saving || !canSave },
          saving ? '保存中…' : '保存',
        ),
      ),
    ),
  )
}
