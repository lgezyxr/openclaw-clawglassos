// Speech-to-text providers. (channel: clawglassos)
//
// PCM contract: signed 16-bit little-endian, 16 kHz, mono, as emitted by the
// G2 microphone via `bridge.audioControl(true)`. The Whisper-class providers
// wrap that raw PCM into a 44-byte WAV header so the upstream HTTP endpoint
// will accept it as a normal audio file upload.

import { Buffer } from 'node:buffer'

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

// ── WAV wrapping ───────────────────────────────────────────────────────

/**
 * Wrap raw PCM (signed 16-bit LE, given sampleRate + channels) into a WAV
 * buffer that any standard audio HTTP API will accept. The fmt+data layout
 * is the minimal 44-byte header; no extra chunks.
 */
export function pcm16ToWav(
  pcm: Buffer,
  sampleRate: number,
  channels: number,
): Buffer {
  const byteRate = sampleRate * channels * 2
  const blockAlign = channels * 2
  const dataSize = pcm.byteLength
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // PCM fmt chunk size
  header.writeUInt16LE(1, 20) // PCM format
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(byteRate, 28)
  header.writeUInt16LE(blockAlign, 32)
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(dataSize, 40)
  return Buffer.concat([header, pcm], header.byteLength + dataSize)
}

// ── Azure Whisper provider ─────────────────────────────────────────────

export interface AzureWhisperOptions {
  /** Resource endpoint, e.g. https://my-resource.cognitiveservices.azure.com */
  endpoint: string
  apiKey: string
  /** Whisper deployment name (per Azure portal). */
  deployment: string
  /** REST API version. Defaults to 2024-06-01. */
  apiVersion?: string
  /** Optional ISO language hint, e.g. "en" / "zh". */
  language?: string
  /** PCM stream config -- defaults match the G2 microphone. */
  sampleRate?: number
  channels?: number
  /** Skip the upload entirely if PCM is shorter than this many ms. Avoids
   *  burning Azure quota on the 0-byte / single-frame "I held the button by
   *  accident" case. */
  minAudioMs?: number
}

/**
 * Posts captured PCM (wrapped in WAV) to Azure OpenAI Whisper.
 *
 * URL shape:
 *   {endpoint}/openai/deployments/{deployment}/audio/transcriptions?api-version={ver}
 */
export function azureWhisperProvider(opts: AzureWhisperOptions): SttProvider {
  const apiVersion = opts.apiVersion ?? '2024-06-01'
  const sampleRate = opts.sampleRate ?? 16_000
  const channels = opts.channels ?? 1
  const minAudioMs = opts.minAudioMs ?? 250
  const base = opts.endpoint.replace(/\/+$/, '')
  const url = `${base}/openai/deployments/${encodeURIComponent(opts.deployment)}/audio/transcriptions?api-version=${apiVersion}`

  return {
    async transcribe(pcm: Buffer): Promise<SttResult> {
      const durationMs = (pcm.byteLength / 2 / sampleRate) * 1000
      if (durationMs < minAudioMs) {
        return { text: '', provider: 'azureWhisper' }
      }
      const wav = pcm16ToWav(pcm, sampleRate, channels)
      const form = new FormData()
      // Node 18+ exposes Blob; Whisper accepts wav by extension.
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
      if (opts.language) form.append('language', opts.language)

      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'api-key': opts.apiKey },
        body: form,
      })
      const text = await resp.text()
      if (!resp.ok) {
        throw new Error(
          `Azure Whisper HTTP ${resp.status}: ${text.slice(0, 400)}`,
        )
      }
      try {
        const parsed = JSON.parse(text) as { text?: string }
        return { text: (parsed.text ?? '').trim(), provider: 'azureWhisper' }
      } catch {
        // Whisper sometimes returns plain text in non-json modes.
        return { text: text.trim(), provider: 'azureWhisper' }
      }
    },
  }
}
