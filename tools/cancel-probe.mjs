// Validates the {type:'cancel'} round trip against the live gateway.
//
// Flow:
//   1. hello
//   2. voice (with streamId) — pretend we just transcribed something the
//      model will want to reason about (forces a non-trivial reply).
//   3. wait for the first {type:'status', text:'processing'} heartbeat.
//   4. send {type:'cancel', streamId}.
//   5. listen for 8s and confirm:
//        - exactly one {type:'status', text:'cancelled'} ack
//        - no {type:'reply'} after the cancel
//        - heartbeats stop within ~3s
//
// Run: node openclaw-clawglassos/tools/cancel-probe.mjs

import WebSocket from "ws";

const URL = "ws://100.115.214.56:8787/ws?token=dev-token-changeme";
const DEVICE = "probe-cancel-01";
const STREAM = "stream-cancel-" + Math.random().toString(36).slice(2, 8);
const QUESTION =
  "请用一段话向我介绍一下量子计算的基本原理，包括叠加态和纠缠的含义。";

const ws = new WebSocket(URL);
const t0 = Date.now();
const log = (...a) => console.log(`[+${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

let cancelSent = false;
let cancelSentAt = 0;
let processingCount = 0;
let cancelledAckCount = 0;
let replyAfterCancel = 0;
let replyBeforeCancel = 0;
let heartbeatsAfterCancel = 0;

ws.on("open", () => {
  log("connected; sending hello");
  ws.send(JSON.stringify({ type: "hello", deviceId: DEVICE, label: "probe-cancel" }));
  setTimeout(() => {
    log("sending voice frame, streamId=", STREAM);
    ws.send(JSON.stringify({ type: "voice", text: QUESTION, streamId: STREAM }));
  }, 300);
});

ws.on("message", (d, isBinary) => {
  if (isBinary) {
    log("<- binary", d.byteLength);
    return;
  }
  const raw = d.toString("utf8");
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    log("<- (non-JSON)", raw.slice(0, 200));
    return;
  }

  if (msg.type === "status" && msg.text === "processing") {
    processingCount++;
    log(`<- status:processing  (#${processingCount})${cancelSent ? "  ⚠ after cancel" : ""}`);
    if (cancelSent) heartbeatsAfterCancel++;
    if (!cancelSent && processingCount === 1) {
      // First heartbeat — wait a beat then cancel.
      setTimeout(() => {
        log(`-> cancel streamId=${STREAM}`);
        ws.send(JSON.stringify({ type: "cancel", streamId: STREAM }));
        cancelSent = true;
        cancelSentAt = Date.now();
      }, 400);
    }
    return;
  }

  if (msg.type === "status" && msg.text === "cancelled") {
    cancelledAckCount++;
    log(`<- status:cancelled  (#${cancelledAckCount})`);
    return;
  }

  if (msg.type === "reply") {
    if (cancelSent) {
      replyAfterCancel++;
      log("<- reply AFTER CANCEL (BUG) text=", String(msg.text).slice(0, 100));
    } else {
      replyBeforeCancel++;
      log("<- reply (before cancel — model was too fast)", String(msg.text).slice(0, 100));
    }
    return;
  }

  if (msg.type === "transcript") {
    log("<- transcript final=", msg.final, "text=", String(msg.text).slice(0, 80));
    return;
  }

  log("<-", raw.slice(0, 200));
});

ws.on("error", (e) => {
  log("ERROR", e.message);
  process.exit(1);
});

ws.on("close", (c, r) => log("closed", c, r?.toString()));

// Final tally after 12s.
setTimeout(() => {
  log("=== SUMMARY ===");
  log(`processing heartbeats total: ${processingCount}`);
  log(`processing heartbeats AFTER cancel: ${heartbeatsAfterCancel}`);
  log(`cancelled acks: ${cancelledAckCount}`);
  log(`reply frames before cancel: ${replyBeforeCancel}`);
  log(`reply frames AFTER cancel: ${replyAfterCancel}`);
  const ok =
    cancelSent &&
    cancelledAckCount === 1 &&
    replyAfterCancel === 0 &&
    heartbeatsAfterCancel <= 1; // one in-flight heartbeat is fine
  log(ok ? "PASS ✓" : "FAIL ✗");
  ws.close();
  process.exit(ok ? 0 : 2);
}, 12_000);
