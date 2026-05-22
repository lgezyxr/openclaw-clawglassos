# openclaw-clawglassos

Community OpenClaw channel plugin for **ClawGlassOS** — the Even Realities
G2 smart-glasses companion app in this repo. Not an Even Realities or
OpenClaw official package.

## What this is

A **Channel Plugin** in the same slot as the bundled `qqbot`, `googlechat`,
`msteams` extensions in OpenClaw. It exposes the glasses as a chat channel
(`clawglassos`) so OpenClaw can:

- receive user voice / text from the glasses, and
- push AI replies / notifications back to the glasses display.

## Wiring

```
┌─────────────┐  WSS   ┌────────────────────────┐   inbound dispatch   ┌──────────┐
│  WebView    │ <────> │ ws-server (plugin)     │ ───────────────────► │ OpenClaw │
│ (on iPhone) │        │  :8787 /ws            │ ◄─────────────────── │  core    │
│  + G2 mic   │        └────────────────────────┘  outbound.sendText   └──────────┘
└─────────────┘
```

- **Channel id**: `clawglassos`
- **Default endpoint**: `ws://<host>:8787/ws?token=<token>&device=<id>`
- **Inbound frames** (client → server):
  - `{type:"hello", deviceId, label?}` — sent once, right after socket open.
  - `{type:"text", text}` — typed input.
  - `{type:"voice", text, lang?, streamId?}` — **client-side STT** result;
    treated like `text` but tagged as voice for OpenClaw rendering.
  - `{type:"audio_start", streamId, encoding?, sampleRate?, channels?, lang?}`
    + binary PCM frames + `{type:"audio_end", streamId?}` — **server-side STT**
    path. Defaults: `pcm_s16le`, 16 kHz, mono.
  - `{type:"ping"}`.
- **Outbound frames** (server → client):
  - `{type:"reply", messageId, text}` — AI reply.
  - `{type:"transcript", streamId?, text, final}` — server STT echo of the
    user's utterance (only emitted on the audio_start path).
  - `{type:"display", text}`, `{type:"status", text}`, `{type:"pong"}`,
    `{type:"error", text}`.

## MVP scope

- Open WSS endpoint
- Token gate on connection
- Text round-trip (WebView → OpenClaw → reply → WebView)
- Audio path stub: receives PCM, currently surfaces a placeholder
  (`[voice message]`) for STT. Real STT slot reserved in `src/stt.ts`.

## Status

Plumbing is in place; the actual injection of a user message into OpenClaw's
session store follows the same pattern as the bundled `qqbot` extension
(`runtime.gateway` + `buildInboundContext` + `dispatchOutbound`). The
dispatch site is marked `TODO(plugin-runtime)` in `src/inbound.ts` and will
be wired against the real `PluginRuntime` next.

## Build

```bash
npm install
npm run build
```

Then load it into your OpenClaw install per your plugin loader conventions
(externally-installed plugins use `defineChannelPluginEntry`; the bundled
`defineBundledChannelEntry` path is only for in-repo extensions).
