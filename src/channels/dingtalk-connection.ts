/**
 * DingTalk stream connection (ported from pi-desk-top/src/main/im/dingtalk/
 * dingtalk-connection.ts — MIT, protocol code only; OpenClaw framework parts
 * dropped, EventEmitter removed in favour of plain callback options).
 *
 * What this gives us:
 *  - DWClient WebSocket long connection (no public callback URL needed)
 *  - application-layer heartbeat: 10s ping / 20s timeout (SDK keepAlive off)
 *  - exponential-backoff reconnect with jitter, guarded against concurrency
 *  - message dedup with 5-minute TTL (stream-account scoped)
 *
 * The DingTalk "stream" bot pushes messages over an OUTBOUND WebSocket. We
 * register a CALLBACK listener for TOPIC_ROBOT BEFORE connect() so the connect
 * handshake carries the subscription — otherwise the server never delivers bot
 * messages to our callback (this is the gotcha the reference calls out).
 */

const HEARTBEAT_INTERVAL = 10 * 1000
const HEARTBEAT_TIMEOUT = 20 * 1000
const BASE_BACKOFF_DELAY = 2000
const MAX_BACKOFF_DELAY = 30_000
const DEDUP_TTL_MS = 5 * 60 * 1000

export interface DingtalkConnectionOptions {
  clientId: string
  clientSecret: string
  /** Raw frame string from TOPIC_ROBOT (already a JSON string). */
  onMessage: (rawData: string, headers: Record<string, string>) => void
  onStatusChange?: (connected: boolean) => void
}

// dingtalk-stream is CJS; import() lets the ESM build resolve it cleanly.
let DWClientCtor: any = null
let TOPIC_ROBOT = ''
async function loadDingtalkStream(): Promise<void> {
  if (DWClientCtor) return
  const mod: any = await import('dingtalk-stream')
  DWClientCtor = mod.DWClient ?? mod.default?.DWClient
  TOPIC_ROBOT = mod.TOPIC_ROBOT ?? '/v1.0/im/bot/messages/get'
  if (!DWClientCtor) throw new Error('dingtalk-stream: DWClient not found')
}

/**
 * Thin wrapper around the official DWClient streaming socket. NOT an EventEmitter
 * in this port — callers subscribe via the constructor callbacks.
 */
export class DingtalkConnection {
  private client: any = null
  private stopped = false
  private isReconnecting = false
  private reconnectAttempts = 0
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null
  private dedup = new Map<string, number>()
  private connected = false

  constructor(private readonly opts: DingtalkConnectionOptions) {}

  get isConnected(): boolean {
    return this.connected
  }

  /** Mark a message id as processed (returns true if it was already seen). */
  private checkAndMark(accountId: string, msgId: string): boolean {
    const now = Date.now()
    for (const [k, ts] of this.dedup) {
      if (now - ts > DEDUP_TTL_MS) this.dedup.delete(k)
    }
    const key = `${accountId}:${msgId}`
    if (this.dedup.has(key)) return true
    this.dedup.set(key, now)
    return false
  }

  private setupSocketListeners(): void {
    const socket = this.client?.socket
    if (!socket) return
    socket.on('pong', () => {
      this.reconnectAttempts = 0
      this.connected = true
    })
    socket.on('message', () => {
      this.reconnectAttempts = 0
      this.connected = true
    })
    socket.on('close', () => {
      this.connected = false
      if (!this.stopped && !this.isReconnecting) {
        void this.doReconnect(true)
      }
    })
  }

  private startKeepAlive(): void {
    this.stopKeepAlive()
    this.keepAliveTimer = setInterval(() => {
      if (!this.client?.socket) return
      if (this.client.socket.readyState === 1) {
        this.client.socket.ping()
        this.connected = true
      } else if (!this.isReconnecting) {
        void this.doReconnect(false)
      }
    }, HEARTBEAT_INTERVAL)
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = null
    }
  }

  private backoffDelay(): number {
    const exponential = BASE_BACKOFF_DELAY * 2 ** this.reconnectAttempts
    const jitter = Math.random() * 1000
    return Math.min(exponential + jitter, MAX_BACKOFF_DELAY)
  }

  private async doReconnect(immediate: boolean): Promise<void> {
    if (this.isReconnecting || this.stopped) return
    this.isReconnecting = true
    try {
      if (!immediate) {
        await new Promise((r) => setTimeout(r, this.backoffDelay()))
      }
      this.reconnectAttempts++
      this.client?.disconnect()
      // Re-register the callback before reconnecting — registerCallbackListener
      // is idempotent and guarantees the reconnect handshake carries it.
      this.registerMessageListener()
      await this.client.connect()
      this.setupSocketListeners()
      const ok = await this.waitForSocketOpen()
      if (ok) {
        this.connected = true
        this.reconnectAttempts = 0
        this.opts.onStatusChange?.(true)
      }
    } catch {
      // keep retrying on next tick
    } finally {
      this.isReconnecting = false
    }
  }

  private waitForSocketOpen(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 10_000)
      const check = () => {
        if (this.client?.socket?.readyState === 1) {
          clearTimeout(t)
          resolve(true)
        } else {
          setTimeout(check, 200)
        }
      }
      check()
    })
  }

  private registerMessageListener(): void {
    this.client.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
      const headers: Record<string, string> = res?.headers ?? {}
      const messageId = headers.messageId
      const rawData: string = res?.data ?? ''
      if (messageId) {
        this.client.socketCallBackResponse?.(messageId, { success: true })
      }
      // protocol-level dedup on headers.messageId
      if (messageId && this.checkAndMark('stream', messageId)) {
        return { status: 'SUCCESS' }
      }
      this.opts.onMessage(rawData, headers)
      return { status: 'SUCCESS' }
    })
  }

  async connect(): Promise<void> {
    await loadDingtalkStream()
    if (this.stopped) return
    this.client = new DWClientCtor({
      clientId: this.opts.clientId,
      clientSecret: this.opts.clientSecret,
      autoReconnect: false,
      keepAlive: false,
      // NOTE: no `subscriptions` here — the lib defaults to EVENT:"*" and we
      // must NOT override it. The CALLBACK subscription for TOPIC_ROBOT is
      // pushed by registerMessageListener() BEFORE connect(), so the connect
      // handshake's subscription payload includes it.
    })
    this.client.on('error', (err: Error) => {
      this.connected = false
      this.opts.onStatusChange?.(false)
      // surfaced through logger at the adapter layer; keep console for raw SDK.
      console.error('[im:dingtalk] connection error:', err?.message)
    })
    // Register the message callback BEFORE connect (see file header note).
    this.registerMessageListener()
    await this.client.connect()
    this.setupSocketListeners()
    this.startKeepAlive()
    this.connected = true
    this.opts.onStatusChange?.(true)
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.stopKeepAlive()
    this.client?.disconnect()
    this.client = null
    this.connected = false
  }
}
