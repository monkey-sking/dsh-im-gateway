/**
 * Client-side Typert Remote contribution for the IM gateway bundle.
 *
 * Consumed by src/client/config-api.ts via `ctx.remote.$mount(TYPERT_REMOTE)`
 * — the official channel for a business package to expose RPC to the Web
 * client. Bundled to lib/typert.remote-client.js and exposed through
 * package.json#exports["./remote"].
 *
 * The shape mirrors what @deepseek-ai/dsh-typert-generator emits
 * (packages/typert/generator/src/emitter.ts `emitRemote`): a default-exported
 * `TYPERT_REMOTE` object carrying `package` and `descriptors`. We author it
 * directly because the official generator is monorepo-bound (it needs the
 * workspace `tsconfig.host.json` aggregate program); the emitted object is
 * byte-format compatible, so dropping this package into deepseek-harness and
 * running the real generator reproduces an identical artifact.
 */
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

const PACKAGE = '@lijian-ui/dsh-im-gateway'
const SERVICE = 'imGatewayRemote'

/** Identity codec: the host manifest owns strict value validation. */
const identity = (value: unknown): unknown => value

/**
 * typert strict codec factory (CLIENT half). Mirrors src/typert.host.ts: dsh
 * 0.1.6-alpha.2's dsh-typert-registry requires `create` to be a FACTORY
 * FUNCTION returning a schemastery-compatible schema object ({ parse, create }).
 * The client face only owns the wire descriptors; strict value validation lives
 * on the host, so we wrap the identity parse into that shape.
 */
const codec = (typeSymbol: string) => ({
  mode: 'strict' as const,
  typeSymbol,
  create: () => ({ parse: identity, create: () => undefined }),
})

/** Wire descriptors mirroring the host contribution (src/typert.host.ts). */
const descriptors = [
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

/** The client Remote contribution. Byte-format compatible with the generator's emitRemote. */
export const TYPERT_REMOTE: TypertRemoteContribution = { package: PACKAGE, descriptors }
export default TYPERT_REMOTE
