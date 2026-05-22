// Speech-to-text slot. (channel: clawglassos)
//
// MVP keeps this as a stub: we accept PCM buffers and return a placeholder
// string. Real implementation will dispatch to Whisper / Deepgram / Soniox
// depending on plugin config (decision deferred -- see README).
//
// PCM contract: signed 16-bit little-endian, 16 kHz, mono, as emitted by the
// G2 microphone via `bridge.audioControl(true)`.

export interface SttResult {
  text: string
  /** Confidence in [0, 1], if the provider exposes it. */
  confidence?: number
  /** Provider identifier, for telemetry. */
  provider: string
}

export interface SttProvider {
  transcribe(pcm: Buffer): Promise<SttResult>
}

/** Placeholder provider -- keeps the wiring honest without a real backend. */
export const stubSttProvider: SttProvider = {
  async transcribe(pcm) {
    const seconds = (pcm.byteLength / 2 / 16_000).toFixed(1)
    return {
      text: `[voice message - ${seconds}s - ${pcm.byteLength} bytes]`,
      provider: 'stub',
    }
  },
}
