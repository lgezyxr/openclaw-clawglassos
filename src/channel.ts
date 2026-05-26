// ChannelPlugin: the OpenClaw-facing half of the clawglassos channel.
//
// Two jobs:
//   1. config.resolveAccount  -- pull token / allowFrom out of OpenClawConfig
//   2. outbound.sendText      -- when OpenClaw has an AI reply for a glasses
//                                user, push it down the live WebSocket via
//                                the registry.

import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from 'openclaw/plugin-sdk/channel-core'
import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core'
import type { ConnectionRegistry } from './types.js'
import type { ResolvedAccountConfig } from './inbound.js'
import { startWsServer, type WsServerHandle } from './ws-server.js'
import { azureWhisperProvider, stubSttProvider, type SttProvider } from './stt.js'

interface BuildOptions {
  registry: ConnectionRegistry
}

export function buildChannelPlugin({ registry }: BuildOptions) {
  // WS server is started lazily by gateway.startAccount and torn down by
  // stopAccount / abortSignal. Single-account today; if we add multi-account
  // we'll key this map by accountId.
  let wsHandle: WsServerHandle | null = null

  function readSection(cfg: OpenClawConfig): Record<string, any> | undefined {
    return (cfg.channels as Record<string, any> | undefined)?.['clawglassos']
  }

  function resolveAccount(
    cfg: OpenClawConfig,
    accountId?: string | null,
  ): ResolvedAccountConfig {
    const section = readSection(cfg)
    if (!section?.token) {
      throw new Error(
        'clawglassos: token is required in channels."clawglassos".token',
      )
    }
    return {
      accountId: accountId ?? null,
      token: section.token,
      allowFrom: section.allowFrom ?? [],
      dmPolicy: section.dmSecurity,
    }
  }

  const base = createChannelPluginBase<ResolvedAccountConfig>({
    id: 'clawglassos',
    capabilities: {
      chatTypes: ['direct'],
      media: false,
      reactions: false,
      threads: false,
    },
    config: {
      listAccountIds: (cfg) => {
        const section = readSection(cfg)
        return section ? ['default'] : []
      },
      resolveAccount,
      inspectAccount: (cfg) => {
        const section = readSection(cfg)
        const hasToken = Boolean(section?.token)
        return {
          enabled: hasToken,
          configured: hasToken,
          tokenStatus: hasToken ? 'available' : 'missing',
        }
      },
    },
    setup: {
      resolveAccountId: ({ accountId }) => accountId ?? 'default',
      applyAccountConfig: ({ cfg }) => cfg,
    },
  })

  // The gateway adapter owns the WS server lifecycle. We attach it onto the
  // base object directly because createChannelPluginBase's options type
  // doesn't expose `gateway`, but ChannelPlugin does.
  const gatewayAdapter = {
    // gateway.startAccount is the hook the gateway actually calls per
    // channel-account at startup. The plugin entry's registerFull callback is
    // dead code for externally loaded plugins -- the loader uses
    // "cli-metadata" registration mode, which never invokes it.
    startAccount: async (ctx: any) => {
      // eslint-disable-next-line no-console
      console.error('[clawglassos] gateway.startAccount fired', {
        accountId: ctx.account?.accountId ?? null,
        hasChannelRuntime: Boolean(ctx.channelRuntime),
      })
      const section = readSection(ctx.cfg) ?? {}
      const resolved = ctx.account as ResolvedAccountConfig
      if (wsHandle) {
        ctx.log?.warn?.(
          `[clawglassos:${resolved.accountId ?? 'default'}] ws server already running; skipping start`,
        )
        return
      }

      wsHandle = startWsServer({
        host: section.host ?? '0.0.0.0',
        port: section.port ?? 8787,
        path: section.path ?? '/ws',
        token: resolved.token,
        registry,
        inboundContext: {
          config: resolved,
          channelRuntime: ctx.channelRuntime ?? null,
          cfg: ctx.cfg,
          log: ctx.log,
        },
        sttProvider: resolveSttProvider(section, ctx.log),
      })

      ctx.log?.info?.(
        `[clawglassos:${resolved.accountId ?? 'default'}] ws server listening on ${section.host ?? '0.0.0.0'}:${section.port ?? 8787}${section.path ?? '/ws'}`,
      )

      const prev = ctx.getStatus()
      ctx.setStatus({
        ...prev,
        running: true,
        connected: true,
        lastConnectedAt: Date.now(),
      })

      // Keep the start task alive until the gateway aborts us. Returning
      // immediately makes the channel manager think the channel exited
      // cleanly, and it'll auto-restart us in a loop.
      await new Promise<void>((resolve) => {
        if (ctx.abortSignal.aborted) {
          if (wsHandle) {
            void wsHandle.close()
            wsHandle = null
          }
          resolve()
          return
        }
        ctx.abortSignal.addEventListener(
          'abort',
          () => {
            if (wsHandle) {
              void wsHandle.close()
              wsHandle = null
            }
            resolve()
          },
          { once: true },
        )
      })
    },
    stopAccount: async (ctx: any) => {
      if (wsHandle) {
        await wsHandle.close()
        wsHandle = null
      }
      const prev = ctx.getStatus()
      ctx.setStatus({ ...prev, running: false, connected: false })
    },
  }
  ;(base as any).gateway = gatewayAdapter

  return createChatChannelPlugin<ResolvedAccountConfig>({
    // createChannelPluginBase widens `capabilities` back to optional in its
    // return type even when we pass it; the runtime carries it through, but
    // ChatChannelPluginBase wants it non-optional. Cast is safe here because
    // we just set it above.
    base: base as Parameters<
      typeof createChatChannelPlugin<ResolvedAccountConfig>
    >[0]['base'],

    // The glasses are a single-user device. DM only.
    //
    // SDK gotcha: `dmSecurity: "open"` does NOT mean "admit everyone". The
    // OpenClaw ingress runtime still runs the allowlist gate, so an empty
    // allowFrom blocks all senders with reasonCode=dm_policy_not_allowlisted.
    // To truly admit any deviceId you must either:
    //   - set `allowFrom: ["*"]` (wildcard), or
    //   - put the deviceId(s) you care about into allowFrom explicitly
    //     (and leave dmSecurity at "allowlist" -- behaviour is identical).
    security: {
      dm: {
        channelKey: 'clawglassos',
        resolvePolicy: (account) => account.dmPolicy,
        resolveAllowFrom: (account) => account.allowFrom,
        defaultPolicy: 'allowlist',
      },
    },

    // No "send a code to the user" channel exists on the G2 itself, so
    // pairing surfaces the code on the glasses display.
    pairing: {
      text: {
        idLabel: 'G2 device id',
        message: 'Enter this code on the glasses to verify:',
        notify: async ({ id, message }) => {
          // `id` is the device id we admit, `message` is the prompt above
          // with the pairing code already inlined by the SDK.
          registry.send(id, {
            type: 'display',
            text: message,
          })
        },
      },
    },

    threading: { topLevelReplyToMode: 'reply' },

    outbound: {
      base: {
        deliveryMode: 'direct',
      },
      attachedResults: {
        channel: 'clawglassos',
        sendText: async (ctx) => {
          const messageId = generateMessageId()
          const ok = registry.send(ctx.to, {
            type: 'reply',
            messageId,
            text: ctx.text,
          })
          if (!ok) {
            // Connection isn't live right now. Fail loudly so OpenClaw can
            // surface "glasses offline" rather than silently dropping.
            throw new Error(
              `clawglassos: no live connection for device ${ctx.to}`,
            )
          }
          return { messageId }
        },
      },
    },
  })
}

function generateMessageId(): string {
  return `cgos-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

/**
 * Pick an STT provider based on the channel config.
 *
 * Expected shape in openclaw.json:
 *   channels.clawglassos.stt = {
 *     provider: "azureWhisper",
 *     azure: { endpoint, apiKey, deployment, apiVersion?, language? }
 *   }
 *
 * Falls back to the stub provider when no config is present or when required
 * Azure fields are missing -- we'd rather see "[voice message - ...]" land in
 * the chat than break the entire dispatch pipeline because of a typo.
 */
function resolveSttProvider(
  section: Record<string, any>,
  log?: { info?: (msg: string) => void; warn?: (msg: string) => void },
): SttProvider {
  const stt = section?.stt as Record<string, any> | undefined
  const provider = stt?.provider ?? 'stub'
  if (provider === 'azureWhisper') {
    const azure = stt?.azure as Record<string, any> | undefined
    if (!azure?.endpoint || !azure?.apiKey || !azure?.deployment) {
      log?.warn?.(
        '[clawglassos] stt.provider=azureWhisper but azure.{endpoint,apiKey,deployment} missing; falling back to stub',
      )
      return stubSttProvider
    }
    log?.info?.(
      `[clawglassos] stt provider = azureWhisper (deployment=${azure.deployment})`,
    )
    return azureWhisperProvider({
      endpoint: azure.endpoint,
      apiKey: azure.apiKey,
      deployment: azure.deployment,
      apiVersion: azure.apiVersion,
      language: azure.language,
    })
  }
  log?.info?.('[clawglassos] stt provider = stub')
  return stubSttProvider
}
