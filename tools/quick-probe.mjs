import WebSocket from "ws";
const ws = new WebSocket("ws://100.115.214.56:8787/ws?token=dev-token-changeme");
const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now()-t0)/1000).toFixed(1)}s]`, ...a);
ws.on("open", () => {
  log("connected");
  ws.send(JSON.stringify({ type: "hello", deviceId: "quick-probe" }));
  setTimeout(() => { ws.close(); process.exit(0); }, 2500);
});
ws.on("message", (d) => log("<-", d.toString()));
ws.on("error", (e) => { log("ERR", e.message); process.exit(1); });
ws.on("close", (c, r) => log("close", c, r?.toString()));
setTimeout(() => { log("TIMEOUT"); process.exit(2); }, 7000);
