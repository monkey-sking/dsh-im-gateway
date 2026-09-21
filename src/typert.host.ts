/**
 * Build-time Typert HOST face for the IM gateway Remote service.
 *
 * This module is the SINGLE SOURCE OF TRUTH for the wire contract. It is
 * bundled to lib/typert.host.js and exposed through
 * package.json#exports["./typert"]. dsh's typert-loader imports this module
 * and registers `TYPERT` into `ctx.typert` — the official auto-registration
 * path (no hand-written `ctx.typert.register()` call).
 *
 * The emitted object shape mirrors what @deepseek-ai/dsh-typert-generator
 * produces (packages/typert/generator/src/emitter.ts): a `TYPERT` object with
 * `package`, `face`, `schemas`, `invocations`, and the runtime `model`. We
 * author it directly because the official generator is monorepo-bound (it
 * needs the workspace `tsconfig.host.json` aggregate program); the emitted
 * object is byte-format compatible, so dropping this package into
 * deepseek-harness and running the real generator reproduces an identical
 * artifact. Keeping the contract here (instead of the deprecated inline
 * `registerContribution`) is what makes the plugin load through the official
 * loader and pass `verify-client-packages`.
 */
const PACKAGE = '@lijian-ui/dsh-im-gateway'
const SERVICE = 'imGatewayRemote'

/** Identity codec: the host manifest owns strict value validation. */
const identity = (value: unknown): unknown => value

/**
 * typert strict codec factory. dsh 0.1.6-alpha.2's dsh-typert-registry /
 * typert-loader require `create` to be a FACTORY FUNCTION returning a
 * schemastery-compatible schema object ({ parse, create }). We wrap the
 * identity parse into that shape (the host service methods enforce their own
 * structural checks, e.g. channels must be an array).
 */
const codec = (typeSymbol: string) => ({
  mode: 'strict' as const,
  typeSymbol,
  create: () => ({ parse: identity, create: () => undefined }),
})

/** The host Remote invocations (namespace `imGatewayRemote`). */
const invocations = [
  {
    id: `${PACKAGE}#${SERVICE}/getConfig`,
    service: SERVICE,
    namespace: SERVICE,
    method: 'getConfig',
    invocation: { kind: 'direct' as const },
    parameters: [],
    result: codec(`${PACKAGE}#ImGatewayConfigView`),
  },
  {
    id: `${PACKAGE}#${SERVICE}/saveConfig`,
    service: SERVICE,
    namespace: SERVICE,
    method: 'saveConfig',
    invocation: { kind: 'direct' as const },
    parameters: [
      { name: 'channels', wire: 'channels', source: 'json', codec: codec(`${PACKAGE}#ChannelsArray`) },
      {
        name: 'expectedRevision',
        wire: 'expectedRevision',
        source: 'json',
        acceptsUndefined: true,
        codec: codec(`${PACKAGE}#Revision`),
      },
    ],
    result: codec(`${PACKAGE}#ImGatewayConfigView`),
  },
  {
    id: `${PACKAGE}#${SERVICE}/getChannelStatuses`,
    service: SERVICE,
    namespace: SERVICE,
    method: 'getChannelStatuses',
    invocation: { kind: 'direct' as const },
    parameters: [],
    result: codec(`${PACKAGE}#ChannelStatuses`),
  },
  {
    id: `${PACKAGE}#${SERVICE}/startQrLogin`,
    service: SERVICE,
    namespace: SERVICE,
    method: 'startQrLogin',
    invocation: { kind: 'direct' as const },
    parameters: [
      { name: 'channelType', wire: 'channelType', source: 'json', codec: codec(`${PACKAGE}#ChannelType`) },
    ],
    result: codec(`${PACKAGE}#QrLoginStatus`),
  },
  {
    id: `${PACKAGE}#${SERVICE}/getQrLoginStatus`,
    service: SERVICE,
    namespace: SERVICE,
    method: 'getQrLoginStatus',
    invocation: { kind: 'direct' as const },
    parameters: [
      { name: 'loginId', wire: 'loginId', source: 'json', codec: codec(`${PACKAGE}#LoginId`) },
    ],
    result: codec(`${PACKAGE}#QrLoginStatus`),
  },
  {
    id: `${PACKAGE}#${SERVICE}/submitQrVerifyCode`,
    service: SERVICE,
    namespace: SERVICE,
    method: 'submitQrVerifyCode',
    invocation: { kind: 'direct' as const },
    parameters: [
      { name: 'loginId', wire: 'loginId', source: 'json', codec: codec(`${PACKAGE}#LoginId`) },
      { name: 'code', wire: 'code', source: 'json', codec: codec(`${PACKAGE}#VerifyCode`) },
    ],
    result: codec(`${PACKAGE}#Bool`),
  },
  {
    id: `${PACKAGE}#${SERVICE}/cancelQrLogin`,
    service: SERVICE,
    namespace: SERVICE,
    method: 'cancelQrLogin',
    invocation: { kind: 'direct' as const },
    parameters: [
      { name: 'loginId', wire: 'loginId', source: 'json', codec: codec(`${PACKAGE}#LoginId`) },
    ],
    result: codec(`${PACKAGE}#Bool`),
  },
]

/**
 * The host contribution. `model.services` carries the runtime service shape
 * the loader validates (`validateTypertManifest`); `members` are the `@Remote`
 * method signatures the generator would extract from `ImGatewayApi`.
 */
export const TYPERT = {
  package: PACKAGE,
  face: 'host' as const,
  schemas: [],
  invocations,
  model: {
    services: [
      {
        key: SERVICE,
        exportName: 'ImGatewayApi',
        tags: [],
        members: [
          { kind: 'method', name: 'getConfig', signature: 'getConfig(): ImGatewayConfigView', tags: [] },
          {
            kind: 'method',
            name: 'saveConfig',
            signature: 'saveConfig(channels: ImChannelInstance[], expectedRevision?: number): ImGatewayConfigView',
            tags: [],
          },
          {
            kind: 'method',
            name: 'getChannelStatuses',
            signature: 'getChannelStatuses(): Record<string, ChannelStatus>',
            tags: [],
          },
          {
            kind: 'method',
            name: 'startQrLogin',
            signature: "startQrLogin(channelType: string): { status: QrLoginStatus }",
            tags: [],
          },
          {
            kind: 'method',
            name: 'getQrLoginStatus',
            signature: 'getQrLoginStatus(loginId: string): { status: QrLoginStatus }',
            tags: [],
          },
          {
            kind: 'method',
            name: 'submitQrVerifyCode',
            signature: 'submitQrVerifyCode(loginId: string, code: string): boolean',
            tags: [],
          },
          {
            kind: 'method',
            name: 'cancelQrLogin',
            signature: 'cancelQrLogin(loginId: string): boolean',
            tags: [],
          },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
}
