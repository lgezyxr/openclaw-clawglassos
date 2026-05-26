// Shared types + the connection registry. (channel: clawglassos)
//
// The registry is what bridges the two halves of the plugin:
//   - ws-server.ts registers a connection when a WebView opens its socket
//   - channel.ts's `outbound.sendText` looks it up by `to` (= deviceId) and
//     pushes the AI reply down that socket.

import type { WebSocket } from 'ws'

export type DeviceId = string

export interface GlassesConnection {
  deviceId: DeviceId
  ws: WebSocket
  /** ms since epoch -- used for idle eviction */
  connectedAt: number
  /** Optional human-friendly label, e.g. "Xinrui's G2". */
  label?: string
}

/** PCM / audio framing parameters declared by the client at audio_start. */
export interface AudioStreamParams {
  /** Opaque, client-chosen identifier; echoed in audio_end / transcript. */
  streamId: string
  /** Wire encoding. Today only `pcm_s16le` is implemented. */
  encoding?: 'pcm_s16le' | 'opus'
  /** Hz. 16000 is the G2 microphone default. */
  sampleRate?: number
  /** 1 = mono. */
  channels?: number
  /** BCP-47 hint, e.g. "en-US", "zh-CN". Optional. */
  lang?: string
}

/** Inbound frames the WebView sends us. Binary frames carry PCM. */
export type InboundFrame =
  | { type: 'hello'; deviceId: DeviceId; label?: string }
  | ({ type: 'audio_start' } & Partial<AudioStreamParams>)
  | { type: 'audio_end'; streamId?: string }
  | { type: 'text'; text: string }
  /**
   * Client-side STT result. The glasses (or webview) ran its own recognizer
   * and is sending us the already-transcribed text. Treated the same as a
   * `text` frame for dispatch, but tagged `fromVoice: true` so OpenClaw can
   * render it like a voice turn.
   */
  | { type: 'voice'; text: string; lang?: string; streamId?: string }
  /**
   * Cancel a turn currently being processed by OpenClaw. The client sends
   * this when the user double-taps out of the 'processing' (thinking) state.
   * The plugin matches it to a registered AbortController by streamId and
   * fires .abort(), which propagates through replyOptions.abortSignal into
   * the model client and any in-flight tool calls (notably web_search).
   *
   * We key on streamId (not deviceId) so a fast "record → cancel → record
   * again" sequence doesn't kill the wrong turn.
   */
  | { type: 'cancel'; streamId: string }
  | { type: 'ping' }

/** Outbound frames we send to the WebView. */
export type OutboundFrame =
  | { type: 'reply'; messageId: string; text: string }
  | { type: 'display'; text: string }
  | { type: 'status'; text: string }
  /**
   * Server-side STT result (intermediate or final). Sent back to the client
   * after an audio_start/audio_end round-trip so the UI can show what the
   * user actually said. `final: false` allows incremental partials in the
   * future; today the stub provider only emits one final frame per stream.
   */
  | { type: 'transcript'; streamId?: string; text: string; final: boolean }
  | { type: 'pong' }
  | { type: 'error'; text: string }

/** Connection registry. Singleton per plugin instance. */
export class ConnectionRegistry {
  private byDevice = new Map<DeviceId, GlassesConnection>()
  /**
   * In-flight AbortControllers keyed by `${deviceId}:${streamId}`. A turn
   * registers itself here at dispatch start and unregisters in `finally`.
   * The {type:'cancel'} frame handler looks up the entry and fires .abort();
   * the abort signal is wired through replyOptions.abortSignal → SDK →
   * model client + tools, so the model actually stops burning tokens.
   *
   * Keyed by streamId (not just deviceId) to avoid the race where a user
   * cancels then immediately re-records: the late cancel for the dead
   * stream must not kill the fresh one.
   */
  private inflightByStream = new Map<string, AbortController>()

  register(conn: GlassesConnection): void {
    const existing = this.byDevice.get(conn.deviceId)
    if (existing && existing.ws !== conn.ws) {
      // Same device reconnected -- close the previous socket gracefully.
      try {
        existing.ws.close(4000, 'superseded by new connection')
      } catch {
        /* ignore */
      }
    }
    this.byDevice.set(conn.deviceId, conn)
  }

  unregister(deviceId: DeviceId, ws: WebSocket): void {
    const existing = this.byDevice.get(deviceId)
    if (existing && existing.ws === ws) {
      this.byDevice.delete(deviceId)
      // Also abort any in-flight turns this device owned. The WS is gone
      // so we couldn't deliver the reply anyway; better to stop billing.
      this.abortAllForDevice(deviceId, 'device disconnected')
    }
  }

  get(deviceId: DeviceId): GlassesConnection | undefined {
    return this.byDevice.get(deviceId)
  }

  send(deviceId: DeviceId, frame: OutboundFrame): boolean {
    const conn = this.byDevice.get(deviceId)
    if (!conn || conn.ws.readyState !== 1 /* OPEN */) return false
    conn.ws.send(JSON.stringify(frame))
    return true
  }

  all(): GlassesConnection[] {
    return Array.from(this.byDevice.values())
  }

  // ── In-flight turn tracking ─────────────────────────────────────────

  private inflightKey(deviceId: DeviceId, streamId: string): string {
    return `${deviceId}:${streamId}`
  }

  /** Called by dispatchToOpenClaw at the top of the turn. */
  registerInflight(
    deviceId: DeviceId,
    streamId: string,
    controller: AbortController,
  ): void {
    this.inflightByStream.set(this.inflightKey(deviceId, streamId), controller)
  }

  /** Called by dispatchToOpenClaw in `finally`. Idempotent. */
  clearInflight(deviceId: DeviceId, streamId: string): void {
    this.inflightByStream.delete(this.inflightKey(deviceId, streamId))
  }

  /**
   * Look up an in-flight turn by streamId and abort it.
   * Returns true if a matching controller was found.
   */
  abortInflight(deviceId: DeviceId, streamId: string, reason?: string): boolean {
    const key = this.inflightKey(deviceId, streamId)
    const controller = this.inflightByStream.get(key)
    if (!controller) return false
    try {
      controller.abort(reason)
    } catch {
      // AbortController.abort is non-throwing in practice; guard for safety.
    }
    this.inflightByStream.delete(key)
    return true
  }

  /** Used on disconnect: abort every turn this device owned. */
  private abortAllForDevice(deviceId: DeviceId, reason: string): void {
    const prefix = `${deviceId}:`
    for (const [key, controller] of this.inflightByStream.entries()) {
      if (!key.startsWith(prefix)) continue
      try {
        controller.abort(reason)
      } catch {
        /* ignore */
      }
      this.inflightByStream.delete(key)
    }
  }

  closeAll(): void {
    for (const conn of this.byDevice.values()) {
      try {
        conn.ws.close(1001, 'plugin shutting down')
      } catch {
        /* ignore */
      }
    }
    this.byDevice.clear()
    // Abort everything pending — server is going down, no point burning more.
    for (const controller of this.inflightByStream.values()) {
      try {
        controller.abort('plugin shutting down')
      } catch {
        /* ignore */
      }
    }
    this.inflightByStream.clear()
  }
}
