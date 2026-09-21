declare module 'qrcode' {
  export function toDataURL(text: string, options?: Record<string, unknown>): Promise<string>
  export function toString(text: string, options?: Record<string, unknown>): Promise<string>
  export function toCanvas(canvas: unknown, text: string, options?: Record<string, unknown>): Promise<void>
  /**
   * `import QRCode from 'qrcode'` resolves to the DEFAULT export, so the
   * default must re-declare the same functions — typing it as a loose
   * `Record<string, unknown>` made `QRCode.toDataURL(...)` infer `unknown` in
   * every QR register/login module (TS18046).
   */
  const exp: {
    toDataURL: typeof toDataURL
    toString: typeof toString
    toCanvas: typeof toCanvas
  }
  export default exp
}

/**
 * 企业微信智能机器人 SDK —— 运行时懒加载的可选依赖（见 channels/wecom.ts
 * 的动态 import，与 qq / dingtalk 通道一样不在启动时加载）。
 *
 * SDK 自带完整 .d.ts，但未安装时 tsc 会因「找不到模块」直接失败（TS2307），
 * 而通道本身应能在缺依赖时优雅降级并给出安装提示。故此处只声明本项目真正
 * 用到的表面，结构与 SDK v1.0.7 一致：
 *   - `WSClient`：连接 / 收发 / 流式回复
 *   - `generateReqId`：生成 stream id
 * 未声明的成员请以官方 npm README 与 node_modules 内真实类型为准。
 */
declare module '@wecom/aibot-node-sdk' {
  /** 回复时用于透传 req_id 的最小帧头。 */
  export interface WsFrameHeaders {
    req_id: string
    [key: string]: unknown
  }

  export interface WsFrame<T = unknown> {
    cmd?: string
    headers: WsFrameHeaders
    body?: T
    errcode?: number
    errmsg?: string
  }

  export interface WSClientOptions {
    /** 智能机器人 BotID（企业微信管理后台获取）。 */
    botId: string
    /** 长连接专用密钥。 */
    secret: string
    reconnectInterval?: number
    maxReconnectAttempts?: number
    heartbeatInterval?: number
    requestTimeout?: number
    /** 私有部署时的自定义长连接地址。 */
    wsUrl?: string
    logger?: unknown
  }

  export class WSClient {
    constructor(options: WSClientOptions)
    on(event: string, handler: (...args: any[]) => void): this
    connect(): this
    disconnect(): void
    /** 被动回复（透传回调帧的 req_id）。 */
    reply(frame: WsFrame | WsFrameHeaders, body: Record<string, unknown>, cmd?: string): Promise<WsFrame>
    /** 流式回复：content 为**全量内容**（同 streamId 原位替换），finish=true 结束。 */
    replyStream(
      frame: WsFrame | WsFrameHeaders,
      streamId: string,
      content: string,
      finish?: boolean,
      msgItem?: unknown[],
      feedback?: unknown,
    ): Promise<WsFrame>
    /** 主动推送（免回调帧）。 */
    sendMessage(chatid: string, body: Record<string, unknown>): Promise<WsFrame>
    /** 上传临时素材 → media_id。 */
    uploadMedia(fileBuffer: Buffer, options: Record<string, unknown>): Promise<{ media_id?: string }>
    /** 主动发送媒体消息。 */
    sendMediaMessage(chatid: string, mediaType: string, mediaId: string, videoOptions?: Record<string, unknown>): Promise<WsFrame>
    /** 下载并 AES 解密入站媒体。 */
    downloadFile(url: string, aesKey: string): Promise<{ buffer: Buffer; filename?: string }>
    readonly isConnected: boolean
  }

  export function generateReqId(prefix: string): string

  const AiBot: { WSClient: typeof WSClient; generateReqId: typeof generateReqId }
  export default AiBot
}
