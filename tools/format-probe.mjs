import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:8787/ws?token=dev-token-changeme");
const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now()-t0)/1000).toFixed(1)}s]`, ...a);
ws.on("open", () => {
  log("connected");
  ws.send(JSON.stringify({ type: "hello", deviceId: "fmt-probe" }));
  setTimeout(() => {
    log("ask: 解释一下什么是 TCP 三次握手");
    ws.send(JSON.stringify({ type: "text", text: "用三个要点解释 TCP 三次握手是什么" }));
  }, 300);
});
ws.on("message", (d) => {
  const s = d.toString();
  try {
    const o = JSON.parse(s);
    if (o.type === "reply") {
      log("REPLY:");
      console.log("===");
      console.log(o.text);
      console.log("===");
      ws.close(); process.exit(0);
    } else log(o.type, o.text ? o.text.slice(0,40) : "");
  } catch { log("<-", s.slice(0,100)); }
});
ws.on("error", (e) => { log("ERR", e.message); process.exit(1); });
setTimeout(() => { log("TIMEOUT"); process.exit(2); }, 60000);
