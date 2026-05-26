import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:8787/ws?token=dev-token-changeme");
const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now()-t0)/1000).toFixed(1)}s]`, ...a);
ws.on("open", () => {
  log("connected");
  ws.send(JSON.stringify({ type: "hello", deviceId: "local-probe" }));
  setTimeout(() => { ws.close(); process.exit(0); }, 2500);
});
ws.on("message", (d) => log("<-", d.toString()));
ws.on("error", (e) => { log("ERR", e.message); process.exit(1); });
setTimeout(() => { log("TIMEOUT"); process.exit(2); }, 6000);
