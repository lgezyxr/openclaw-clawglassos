import WebSocket from "ws";
const HOST = process.env.CGOS_HOST ?? "127.0.0.1";
const TOKEN = process.env.CGOS_TOKEN ?? "CHANGE_ME";
const URL = process.env.CGOS_WS_URL ?? `ws://${HOST}:8787/ws?token=${TOKEN}`;
const ws = new WebSocket(URL);
const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now()-t0)/1000).toFixed(1)}s]`, ...a);
ws.on("open", () => {
  log("connected");
  ws.send(JSON.stringify({ type: "hello", deviceId: "probe-tail-01", label: "probe-tail" }));
  setTimeout(() => {
    log("sending text: 1+1=?");
    ws.send(JSON.stringify({ type: "text", text: "1+1等于几？直接回答数字，不要联网搜索。" }));
  }, 300);
  setTimeout(() => { log("timeout reached, closing"); ws.close(); process.exit(0); }, 45000);
});
ws.on("message", (d, isBinary) => {
  if (isBinary) log("<- binary", d.byteLength);
  else log("<-", d.toString("utf8").slice(0, 400));
});
ws.on("error", (e) => { log("ERROR", e.message); process.exit(1); });
ws.on("close", (c, r) => log("closed", c, r?.toString()));
