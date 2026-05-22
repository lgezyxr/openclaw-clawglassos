// Plugin entry point.
//
// External / community channel plugins use defineChannelPluginEntry from
// openclaw/plugin-sdk/channel-core. The bundled in-repo extensions
// (qqbot, googlechat, msteams) use defineBundledChannelEntry from
// openclaw/plugin-sdk/channel-entry-contract instead; we don't.
//
// IMPORTANT: registerFull is only invoked in the test-mode registration path
// ("full"). For externally-loaded plugins the loader uses "cli-metadata", so
// any side-effect we attempt from registerFull (e.g. starting a WebSocket
// server) silently never happens. The WebSocket server is started instead
// from channelPlugin.gateway.startAccount, which is what the gateway actually
// calls per channel-account at runtime.

import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/channel-core'
import { buildChannelPlugin } from './channel.js'
import { ConnectionRegistry } from './types.js'

// eslint-disable-next-line no-console
console.error('[clawglassos] index.ts module evaluating')

// One registry per plugin instance; both halves close over it.
const registry = new ConnectionRegistry()
const plugin = buildChannelPlugin({ registry })

const entry = defineChannelPluginEntry({
  id: 'clawglassos',
  name: 'ClawGlassOS (Even G2)',
  description:
    'Community plugin: bridges Even Realities G2 smart glasses (via the ClawGlassOS WebView) to OpenClaw as a chat channel.',
  plugin,

  registerCliMetadata(api) {
    api.registerCli(
      ({ program }: any) => {
        program
          .command('clawglassos')
          .description('ClawGlassOS glasses channel management')
      },
      {
        descriptors: [
          {
            name: 'clawglassos',
            description: 'ClawGlassOS glasses channel management',
            hasSubcommands: false,
          },
        ],
      },
    )
  },
})

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default entry as any
