import { defineConfig } from 'tsdown'

/**
 * Client-bundle externals: the browser platform seed modules plus the one
 * documented runtime exemption. These resolve through the loader's module
 * table at runtime (`require` inside the factory), never from node_modules.
 * Mirrors packages/client/tsdown.client.ts in the harness checkout.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

/**
 * Host half: ESM library with .d.ts for the SINGLE-entry bundle.
 * Channels are internal modules (src/channels/*) — no standalone entries,
 * because the bundle is one plugin whose channels are config sub-objects.
 */
const hostConfig = {
  entry: [
    'src/index.ts',
  ],
  format: 'esm',
  outDir: 'lib',
  dts: true,
  clean: true,
}

/**
 * Browser half: CJS bundle landed exactly at lib/client.js, wrapped in the
 * loader's factory handoff format. The bundle must be plain JS after build
 * (no JSX/TS — build elements with React.createElement) and may only import
 * the platform modules listed above. clean must stay off: a default clean
 * would wipe the host-half output emitted by the config above.
 */
const clientConfig = {
  name: '@lijian-ui/dsh-im-gateway/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  external: CLIENT_EXTERNALS,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  // tsdown auto-externalizes package dependencies; anything NOT in the
  // loader module table must inline instead. The rule is the table list
  // itself: no opinion for table entries (external above wins), bundle the
  // rest (type-only imports are erased and never reach this bundle).
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: "@lijian-ui/dsh-im-gateway", factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([hostConfig, clientConfig])
