/**
 * SSRF 防护：远程 URL 安全校验。
 *
 * 下载/代理外部资源（入站图片、出站媒体 URL、TTS 音频等）之前，先确认目标
 * 不会命中内网、回环、链路本地或云元数据端点，避免模型输出的恶意链接触达
 * 内网服务（典型如 http://169.254.169.254/latest/meta-data/）。
 *
 * 移植自参考项目 openclaw-qqbot/src/utils/ssrf-guard.ts，做了以下调整：
 *   - 使用 `dns.lookup({ all: true })` 而非 `dns.resolve`，同时覆盖 hosts 文件；
 *   - 补全保留网段（CGNAT 100.64/10、198.18/15、组播/广播等）；
 *   - 不在此模块内 console 输出，交由调用方 logger 处理。
 *
 * @module im-gateway/ssrf
 */
import net from 'node:net'
import dns from 'node:dns/promises'

// ── 保留 / 不可路由地址判定 ────────────────────────────────────────────

/** IPv4 保留网段前缀。 */
const RESERVED_V4_PREFIXES = [
  '0.', // 0.0.0.0/8 — 本网络
  '10.', // 10.0.0.0/8 — 私有
  '127.', // 127.0.0.0/8 — 回环
  '169.254.', // 169.254.0.0/16 — 链路本地 / 云元数据
  '192.168.', // 192.168.0.0/16 — 私有
  '192.0.0.', // 192.0.0.0/24 — IETF 协议保留
] as const

/** 需要按数值判断的保留网段：[网络地址, 前缀长度]。 */
const RESERVED_V4_CIDRS: Array<[string, number]> = [
  ['100.64.0.0', 10], // CGNAT
  ['172.16.0.0', 12], // 私有
  ['198.18.0.0', 15], // 基准测试
  ['224.0.0.0', 4], // 组播
  ['240.0.0.0', 4], // 保留（含 255.255.255.255 广播）
]

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let out = 0
  for (const p of parts) {
    const n = Number(p)
    if (!Number.isInteger(n) || n < 0 || n > 255) return null
    out = (out << 8) | n
  }
  return out >>> 0
}

function inCidr(ip: string, network: string, prefix: number): boolean {
  const a = ipv4ToInt(ip)
  const b = ipv4ToInt(network)
  if (a === null || b === null) return false
  if (prefix <= 0) return true
  const mask = prefix >= 32 ? 0xffffffff : (~((1 << (32 - prefix)) - 1)) >>> 0
  return (a & mask) === (b & mask)
}

/**
 * 判断 IP 是否落在不可路由 / 私有网段内。
 * 覆盖 IPv4（回环、私有、链路本地、CGNAT、组播、保留）与 IPv6（::1、::、
 * fe80::/10 链路本地、fc00::/7 ULA、以及 IPv4 映射地址）。
 */
export function isReservedAddr(ip: string): boolean {
  const raw = ip.trim().replace(/^\[|\]$/g, '')
  if (!raw) return true

  if (net.isIPv4(raw)) {
    for (const pfx of RESERVED_V4_PREFIXES) {
      if (raw.startsWith(pfx)) return true
    }
    for (const [network, prefix] of RESERVED_V4_CIDRS) {
      if (inCidr(raw, network, prefix)) return true
    }
    return false
  }

  if (net.isIPv6(raw)) {
    const lower = raw.toLowerCase()
    if (lower === '::1' || lower === '::') return true
    if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
      return true // fe80::/10 链路本地
    }
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true // fc00::/7 ULA
    // IPv4 映射地址 ::ffff:a.b.c.d → 还原成 IPv4 再判一次
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return isReservedAddr(mapped[1])
    return false
  }

  // 非 IP 字面量 —— 交给调用方按域名处理
  return false
}

// ── URL 校验 ──────────────────────────────────────────────────────────

const ALLOWED_SCHEMES = new Set(['http:', 'https:'])

/**
 * QQ 官方媒体 / API 域名白名单 —— 命中后跳过 DNS 解析检查。
 * 入站附件 URL 基本都来自这里，避免 DNS 抖动导致正常图片被误拦。
 */
const TRUSTED_DOMAINS = new Set([
  'api.sgroup.qq.com',
  'sandbox.api.sgroup.qq.com',
  'bots.qq.com',
  'multimedia.nt.qq.com.cn',
  'multimedia.nt.qq.com',
  'grouppro.grouppro.qq.com',
])

/** hostname 是否命中白名单（支持一层子域，如 foo.multimedia.nt.qq.com.cn）。 */
export function isTrustedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase()
  if (!host) return false
  if (TRUSTED_DOMAINS.has(host)) return true
  const dot = host.indexOf('.')
  if (dot > 0) return TRUSTED_DOMAINS.has(host.slice(dot + 1))
  return false
}

/**
 * 校验远程 URL 是否可安全请求。不可安全请求时抛 `Error`（消息含「SSRF」）。
 *
 * 规则：
 *  1. 仅放行 http / https；
 *  2. 白名单域名直接放行；
 *  3. URL 直接携带 IP 字面量 → 即时判定；
 *  4. 域名的 DNS 解析结果逐条判定（任一条命中内网即拒绝）。
 */
export async function validateRemoteUrl(raw: string): Promise<void> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`无效的 URL：${raw}`)
  }
  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new Error(`不支持的协议 "${url.protocol}"，仅允许 http/https（URL: ${raw}）`)
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw new Error(`URL 缺少 host（URL: ${raw}）`)
  if (isTrustedHost(host)) return

  if (net.isIP(host)) {
    assertPublicAddr(host, raw)
    return
  }

  let records: Array<{ address: string }>
  try {
    records = await dns.lookup(host, { all: true })
  } catch {
    // DNS 解析失败不阻塞（后续 fetch 会自然失败）——但也不能放行内网字面量，
    // 这里 host 不是 IP，故直接返回。
    return
  }
  for (const rec of records) {
    assertPublicAddr(rec.address, raw, host)
  }
}

/** 断言 IP 为公网地址，否则抛错。 */
function assertPublicAddr(ip: string, originalUrl: string, domain?: string): void {
  if (!isReservedAddr(ip)) return
  const target = domain ? `域名 "${domain}" 解析到内网地址 "${ip}"` : `内网地址 "${ip}"`
  throw new Error(`禁止访问${target}，已拦截潜在的 SSRF 请求（URL: ${originalUrl}）`)
}
