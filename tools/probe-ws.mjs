// Minimal WS probe — mimics the glasses webview client.
// Usage: node tools/probe-ws.mjs
import WebSocket from "ws";

const URL = "ws://127.0.0.1:8787/ws?token=dev-token-changeme";
const DEVICE_ID = "probe-device-01";

const ws = new WebSocket(URL);

// Pick one of: "text" | "voice" | "audio"
const MODE = process.env.PROBE_MODE ?? "text";

ws.on("open", () => {
  console.log("[probe] connected, mode=", MODE);
  ws.send(JSON.stringify({ type: "hello", deviceId: DEVICE_ID, label: "probe" }));

  setTimeout(() => {
    if (MODE === "voice") {
      console.log("[probe] sending voice frame (client-side STT result)");
      ws.send(
        JSON.stringify({
          type: "voice",
          text: "hello from probe via client STT",
          lang: "en-US",
          streamId: "probe-stream-1",
        }),
      );
    } else if (MODE === "audio") {
      console.log("[probe] sending audio_start + 1s silent PCM + audio_end");
      const streamId = "probe-stream-1";
      ws.send(
        JSON.stringify({
          type: "audio_start",
          streamId,
          encoding: "pcm_s16le",
          sampleRate: 16000,
          channels: 1,
          lang: "en-US",
        }),
      );
      // 1 second of silence: 16000 samples * 2 bytes
      ws.send(Buffer.alloc(16000 * 2));
      ws.send(JSON.stringify({ type: "audio_end", streamId }));
    } else {
      console.log("[probe] sending text frame");
      ws.send(JSON.stringify({ type: "text", text: "hello from probe" }));
    }
  }, 500);

  setTimeout(() => {
    console.log("[probe] closing");
    ws.close();
    process.exit(0);
  }, 180000);
});

ws.on("message", (data, isBinary) => {
  if (isBinary) {
    console.log("[probe] <- binary", data.byteLength, "bytes");
  } else {
    console.log("[probe] <-", data.toString("utf8"));
  }
});

ws.on("error", (err) => {
  console.error("[probe] error:", err.message);
  process.exit(1);
});

ws.on("close", (code, reason) => {
  console.log("[probe] closed", code, reason?.toString());
});
