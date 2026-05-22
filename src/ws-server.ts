// WebSocket endpoint that the ClawGlassOS WebView connects to.
// (channel: clawglassos)
//
// Wire protocol -- must stay drop-in compatible with tools/echo-server.mjs so
// the existing on-glasses client (src/ws.ts + src/AppContext.tsx) keeps
// working unchanged:
//
//   client -> server (text JSON):
//     { type: "hello", deviceId, label? }    // sent right after open
//     { type: "audio_start", streamId, encoding?, sampleRate?, channels?, lang? }
//     <binary PCM frames>                    // 16 kHz s16le mono (default)
//     { type: "audio_end", streamId? }
//     { type: "voice", text, lang?, streamId? }   // client-side STT result
//     { type: "text",  text }                // non-voice typed input
//     { type: "ping" }
//
//   server -> client (text JSON):
//     { type: "reply",      messageId, text }   // AI reply
//     { type: "transcript", streamId?, text, final }  // server-side STT result
//     { type: "display",    text }              // raw push (notifications)
//     { type: "status",     text }              // transient status line
//     { type: "pong" }
//     { type: "error",      text }
//
// Two voice paths are supported and the client picks one per turn:
//   (a) client-side STT: send a single `voice` frame. Cheapest, but the
//       device has to ship a recognizer.
//   (b) server-side STT: open with `audio_start`, stream binary PCM, close
//       with `audio_end`. Server transcribes (stub today) and emits a
//       `transcript` echo before dispatching to OpenClaw.
//
// Auth: shared token in `?token=` query string, checked at upgrade time.
// (Tailscale already gives us network-level isolation; the token is mostly a
// foot-gun guard so a misconfigured WebView can't accidentally talk to a
// stranger's OpenClaw.)

import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  ConnectionRegistry,
  type DeviceId,
  type InboundFrame,
} from './types.js'
import { dispatchToOpenClaw, type InboundContext } from './inbound.js'
import { stubSttProvider, type SttProvider } from './stt.js'

export interface WsServerOptions {
  host: string
  port: number
  path: string
  token: string
  registry: ConnectionRegistry
  inboundContext: Omit<InboundContext, 'registry'>
  sttProvider?: SttProvider
}

export interface WsServerHandle {
  close(): Promise<void>
}

interface Session {
  deviceId: DeviceId | null
  recording: boolean
  pcmChunks: Buffer[]
  pcmBytes: number
  /** Per-stream params declared at audio_start; cleared at audio_end. */
  streamId: string | null
  encoding: 'pcm_s16le' | 'opus'
  sampleRate: number
  channels: number
  lang: string | null
}

export function startWsServer(opts: WsServerOptions): WsServerHandle {
  const stt = opts.sttProvider ?? stubSttProvider
  const ctx: InboundContext = { ...opts.inboundContext, registry: opts.registry }

  const http: HttpServer = createServer((_req, res) => {
    res.statusCode = 426
    res.setHeader('content-type', 'text/plain')
    res.end('upgrade required')
  })

  const wss = new WebSocketServer({ noServer: true })

  http.on('upgrade', (req, socket, head) => {
    const url = parseUrl(req)
    if (!url || url.pathname !== opts.path) {
      reject(socket, 404, 'not found')
      return
    }
    if (url.searchParams.get('token') !== opts.token) {
      reject(socket, 401, 'unauthorized')
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const presetDevice = url.searchParams.get('device')
      handleConnection(ws, ctx, opts.registry, stt, presetDevice)
    })
  })

  http.listen(opts.port, opts.host, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[clawglassos] ws listening on ws://${opts.host}:${opts.port}${opts.path}`,
    )
  })

  return {
    async close() {
      opts.registry.closeAll()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => http.close(() => resolve()))
    },
  }
}

function handleConnection(
  ws: WebSocket,
  ctx: InboundContext,
  registry: ConnectionRegistry,
  stt: SttProvider,
  presetDevice: string | null,
): void {
  const session: Session = {
    deviceId: presetDevice,
    recording: false,
    pcmChunks: [],
    pcmBytes: 0,
    streamId: null,
    encoding: 'pcm_s16le',
    sampleRate: 16_000,
    channels: 1,
    lang: null,
  }

  // If the client provided ?device= we can register immediately; otherwise
  // we wait for the `hello` frame.
  if (session.deviceId) {
    registry.register({
      deviceId: session.deviceId,
      ws,
      connectedAt: Date.now(),
    })
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!session.recording) {
        // Stray binary frame outside an audio window -- drop quietly.
        return
      }
      const buf = data as Buffer
      session.pcmChunks.push(buf)
      session.pcmBytes += buf.byteLength
      return
    }

    let frame: InboundFrame
    try {
      frame = JSON.parse(data.toString('utf8')) as InboundFrame
    } catch {
      ws.send(JSON.stringify({ type: 'error', text: 'invalid JSON frame' }))
      return
    }

    void handleTextFrame(frame, session, ws, ctx, registry, stt)
  })

  ws.on('close', () => {
    if (session.deviceId) registry.unregister(session.deviceId, ws)
  })

  ws.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.warn('[clawglassos] ws error:', err)
  })
}

async function handleTextFrame(
  frame: InboundFrame,
  session: Session,
  ws: WebSocket,
  ctx: InboundContext,
  registry: ConnectionRegistry,
  stt: SttProvider,
): Promise<void> {
  switch (frame.type) {
    case 'hello': {
      session.deviceId = frame.deviceId
      registry.register({
        deviceId: frame.deviceId,
        ws,
        connectedAt: Date.now(),
        label: frame.label,
      })
      ws.send(JSON.stringify({ type: 'status', text: 'connected' }))
      return
    }
    case 'audio_start': {
      session.recording = true
      session.pcmChunks = []
      session.pcmBytes = 0
      session.streamId = frame.streamId ?? null
      session.encoding = frame.encoding ?? 'pcm_s16le'
      session.sampleRate = frame.sampleRate ?? 16_000
      session.channels = frame.channels ?? 1
      session.lang = frame.lang ?? null
      if (session.encoding !== 'pcm_s16le') {
        ws.send(
          JSON.stringify({
            type: 'error',
            text: `unsupported audio encoding: ${session.encoding} (only pcm_s16le today)`,
          }),
        )
      }
      return
    }
    case 'audio_end': {
      if (!session.recording) return
      session.recording = false
      const pcm = Buffer.concat(session.pcmChunks, session.pcmBytes)
      const streamId = session.streamId ?? frame.streamId ?? null
      session.pcmChunks = []
      session.pcmBytes = 0
      session.streamId = null
      if (!session.deviceId) {
        ws.send(JSON.stringify({ type: 'error', text: 'no device id; send hello first' }))
        return
      }
      const transcript = await stt.transcribe(pcm)
      // Echo transcript back so the client UI can render what the user said.
      ws.send(
        JSON.stringify({
          type: 'transcript',
          streamId: streamId ?? undefined,
          text: transcript.text,
          final: true,
        }),
      )
      await dispatchToOpenClaw(ctx, {
        deviceId: session.deviceId,
        text: transcript.text,
        fromVoice: true,
      })
      return
    }
    case 'text': {
      if (!session.deviceId) {
        ws.send(JSON.stringify({ type: 'error', text: 'no device id; send hello first' }))
        return
      }
      await dispatchToOpenClaw(ctx, {
        deviceId: session.deviceId,
        text: frame.text,
        fromVoice: false,
      })
      return
    }
    case 'voice': {
      if (!session.deviceId) {
        ws.send(JSON.stringify({ type: 'error', text: 'no device id; send hello first' }))
        return
      }
      const text = (frame.text ?? '').trim()
      if (!text) {
        ws.send(JSON.stringify({ type: 'error', text: 'voice frame missing text' }))
        return
      }
      await dispatchToOpenClaw(ctx, {
        deviceId: session.deviceId,
        text,
        fromVoice: true,
      })
      return
    }
    case 'ping': {
      ws.send(JSON.stringify({ type: 'pong' }))
      return
    }
    default: {
      const exhaustive: never = frame
      void exhaustive
      ws.send(JSON.stringify({ type: 'error', text: 'unknown frame type' }))
    }
  }
}

function parseUrl(req: IncomingMessage): URL | null {
  if (!req.url) return null
  const host = req.headers.host ?? 'localhost'
  try {
    return new URL(req.url, `http://${host}`)
  } catch {
    return null
  }
}

function reject(
  socket: Duplex,
  status: number,
  reason: string,
): void {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`,
  )
  socket.destroy()
}
