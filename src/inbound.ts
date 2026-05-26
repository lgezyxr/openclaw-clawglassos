// Inbound dispatch: WebView → OpenClaw.
//
// We follow the same pattern as the bundled clickclack plugin (model reply
// path): resolve an agent route, build an inbound envelope, then drive
// channelRuntime.turn.runPrepared with the buffered block dispatcher. The
// `deliver` callback pushes the assembled reply text back down the WebSocket
// via the connection registry.

import { createChannelMessageReplyPipeline } from 'openclaw/plugin-sdk/channel-message'
import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core'
import {
  defineStableChannelIngressIdentity,
  resolveChannelMessageIngress,
} from 'openclaw/plugin-sdk/channel-ingress-runtime'
import type { ConnectionRegistry, DeviceId } from './types.js'
import { chooseReplyFormatRules } from './glasses-prompt.js'

const CHANNEL_ID = 'clawglassos' as const

/**
 * Optional log sink mirroring ChannelLogSink shape from the SDK -- we don't
 * import the type to keep the plugin loosely coupled.
 */
export interface ChannelLogLike {
  info?: (msg: string) => void
  warn?: (msg: string) => void
  error?: (msg: string) => void
  debug?: (msg: string) => void
}

export interface InboundContext {
  /** Per-account config resolved from openclaw.json. */
  config: ResolvedAccountConfig
  /** Reference back to the live registry for sending error frames. */
  registry: ConnectionRegistry
  /**
   * Plugin SDK channel runtime surface passed in from gateway.startAccount.
   * Required for real dispatch; absent in tests / when the gateway didn't
   * grant the full surface (we degrade to a console.warn TODO in that case).
   */
  channelRuntime: any | null
  /** Live config snapshot. */
  cfg: OpenClawConfig
  /** Optional logger from the gateway context. */
  log?: ChannelLogLike
}

export interface ResolvedAccountConfig {
  accountId: string | null
  token: string
  allowFrom: string[]
  dmPolicy?: string
}

export interface InboundUserMessage {
  deviceId: DeviceId
  text: string
  /** True if `text` came from STT (rather than raw `text` frame). */
  fromVoice: boolean
}

const identity = defineStableChannelIngressIdentity({
  key: 'clawglassos-device-id',
  // Devices identify themselves with an opaque string in the `hello` frame.
  // We treat it as PII because it's tied to a specific user's glasses.
  normalize: (raw: string) => raw.trim().toLowerCase(),
  sensitivity: 'pii',
})

export async function dispatchToOpenClaw(
  ctx: InboundContext,
  msg: InboundUserMessage,
): Promise<void> {
  // 1. Ingress policy: decide whether to admit this message at all.
  const dmPolicy = (ctx.config.dmPolicy ?? 'allowlist') as
    | 'pairing'
    | 'allowlist'
    | 'open'
    | 'disabled'
  const ingress = await resolveChannelMessageIngress({
    channelId: CHANNEL_ID,
    accountId: ctx.config.accountId ?? 'default',
    identity,
    subject: { stableId: msg.deviceId },
    conversation: { kind: 'direct', id: msg.deviceId },
    event: { kind: 'message', authMode: 'inbound', mayPair: true },
    policy: {
      dmPolicy,
      groupPolicy: 'disabled',
      groupAllowFromFallbackToAllowFrom: false,
    },
    allowFrom: ctx.config.allowFrom,
    groupAllowFrom: [],
  })

  if (!isAdmitted(ingress.ingress.decision)) {
    ctx.registry.send(msg.deviceId, {
      type: 'error',
      text: 'message rejected by channel policy',
    })
    return
  }

  // 2. Real dispatch needs the full plugin-runtime channel surface. If we
  //    didn't get one (e.g. running under a partial gateway boot), log loudly
  //    and bail rather than silently dropping.
  const runtime = ctx.channelRuntime
  if (
    !runtime?.routing?.resolveAgentRoute ||
    !runtime?.reply?.dispatchReplyWithBufferedBlockDispatcher ||
    !runtime?.turn?.runPrepared
  ) {
    ctx.log?.warn?.(
      `[clawglassos] dispatchToOpenClaw: channelRuntime surface incomplete; payload=${JSON.stringify({
        deviceId: msg.deviceId,
        text: msg.text,
        fromVoice: msg.fromVoice,
      })}`,
    )
    ctx.registry.send(msg.deviceId, {
      type: 'error',
      text: 'OpenClaw runtime not wired (channelRuntime missing)',
    })
    return
  }

  const accountId = ctx.config.accountId ?? 'default'
  const target = msg.deviceId

  // 3. Resolve which agent should handle this conversation.
  const route = runtime.routing.resolveAgentRoute({
    cfg: ctx.cfg,
    channel: CHANNEL_ID,
    accountId,
    peer: { kind: 'direct', id: target },
  })

  // 4. Build the inbound envelope (channel/from/timestamp + body).
  const senderName = msg.fromVoice ? 'G2 (voice)' : 'G2'
  const storePath = runtime.session.resolveStorePath(ctx.cfg.session?.store, {
    agentId: route.agentId,
  })
  const previousTimestamp = runtime.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  })
  const body = runtime.reply.formatAgentEnvelope({
    channel: 'ClawGlassOS',
    from: senderName,
    timestamp: new Date(),
    previousTimestamp,
    envelope: runtime.reply.resolveEnvelopeFormatOptions(ctx.cfg),
    body: msg.text,
  })

  // Append the glasses display constraints to the message body the model
  // actually reads. Per openclaw/src/auto-reply/reply/dispatch-acp.ts
  // resolveAcpPromptText(), the agent picks the first non-empty of
  // BodyForAgent → BodyForCommands → CommandBody → RawBody → Body, so we
  // have to inject into BodyForAgent (not Body) for the rules to land.
  //
  // We append every turn (no channel-level systemPrompt hook today). A bit
  // wasteful in tokens but bullet-proof against the model "forgetting" after
  // a long conversation or context compaction. See glasses-prompt.ts for
  // the rule set + rationale.
  const formatRules = chooseReplyFormatRules(msg.text)
  const bodyForAgent = `${msg.text}\n\n${formatRules}`

  const ctxPayload = runtime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: bodyForAgent,
    RawBody: msg.text,
    CommandBody: msg.text,
    From: target,
    To: target,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? accountId,
    ChatType: 'direct',
    ConversationLabel: senderName,
    NativeChannelId: target,
    SenderName: senderName,
    SenderId: msg.deviceId,
    Provider: CHANNEL_ID,
    Surface: CHANNEL_ID,
    Timestamp: new Date().toISOString(),
    OriginatingChannel: CHANNEL_ID,
    OriginatingTo: target,
    CommandAuthorized: true,
  })

  const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
    cfg: ctx.cfg,
    agentId: route.agentId,
    channel: CHANNEL_ID,
    accountId,
  })

  // 5. Push a transient "processing" status so the WebView UI can show a
  //    spinner while the model is generating, then keep heartbeating so the
  //    client can detect when we silently die (network drop / process crash /
  //    model wedged on a hung tool call). The frontend has a watchdog that
  //    falls back to error after ~8s without a heartbeat (see AppContext).
  //
  //    Mirrors what extensions/discord does with Discord typing
  //    (src/channels/typing.ts: 3s keepalive). We don't have a server-side TTL
  //    primitive like Discord typing, so the frontend implements the TTL.
  ctx.registry.send(msg.deviceId, { type: 'status', text: 'processing' })
  const PROCESSING_HEARTBEAT_MS = 3_000
  const heartbeat = setInterval(() => {
    ctx.registry.send(msg.deviceId, { type: 'status', text: 'processing' })
  }, PROCESSING_HEARTBEAT_MS)

  try {
    await runtime.turn.runPrepared({
    channel: CHANNEL_ID,
    accountId,
    routeSessionKey: route.sessionKey,
    storePath,
    ctxPayload,
    recordInboundSession: runtime.session.recordInboundSession,
    runDispatch: async () =>
      await runtime.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: ctx.cfg,
        dispatcherOptions: {
          ...replyPipeline,
          deliver: async (payload: unknown) => {
            const text =
              payload && typeof payload === 'object' && 'text' in payload
                ? ((payload as { text?: string }).text ?? '')
                : ''
            if (!text.trim()) return
            const messageId = generateMessageId()
            ctx.registry.send(msg.deviceId, {
              type: 'reply',
              messageId,
              text,
            })
          },
          onError: (error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            ctx.log?.error?.(`[clawglassos] dispatch error: ${message}`)
            ctx.registry.send(msg.deviceId, { type: 'error', text: message })
          },
        },
        replyOptions: { onModelSelected },
      }),
    record: {
      onRecordError: (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        ctx.log?.error?.(`[clawglassos] session record failed: ${message}`)
      },
    },
  })
  } finally {
    clearInterval(heartbeat)
  }
}

function isAdmitted(decision: 'allow' | 'block' | 'pairing'): boolean {
  return decision === 'allow'
}

function generateMessageId(): string {
  return `cgos-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}
