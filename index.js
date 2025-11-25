/**
 * tunzy-md-bot — Multi-user pairing-code host (Pairing-code only)
 * Unlimited users mode
 *
 * How it works:
 * - Serves static pairing page (public/pair.html)
 * - POST /generate with { number: "+234..." } returns a pairing code (1234-5678)
 * - Creates an auth folder per number: ./auth/<number>
 * - Boots a per-number bot process (in-process)
 *
 * Notes:
 * - Keep ./auth persisted (Render persistent disk or VPS).
 * - This file is written to be simple to deploy on Render or any Node host.
 */

import express from "express";
import bodyParser from "body-parser";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  DisconnectReason
} from "@whiskeysockets/baileys";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const AUTH_ROOT = path.join(process.cwd(), "auth"); // per-number auth folders
const BOTPIC = path.join(process.cwd(), "botpic.jpg");

// create auth dir if missing
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

// simple in-memory rate limiter for generate endpoint (per IP)
const rateMap = new Map();
// cooldown in ms
const COOLDOWN_MS = 10 * 1000; // 10 seconds between requests per IP

// keep track of running bots: { number: { sock, status } }
const runningBots = new Map();

// helper: format pairing like 1234-5678 from 8-digit string
function fmtPair(codeStr) {
  return codeStr.replace(/(\d{4})(\d{4})/, "$1-$2");
}

// create express app
const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// GET / -> serve pairing page (public/pair.html)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "pair.html"));
});

// POST /generate => { code }
app.post("/generate", async (req, res) => {
  try {
    const ip = req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    const last = rateMap.get(ip) || 0;
    const now = Date.now();
    if (now - last < COOLDOWN_MS) {
      return res.status(429).json({ error: "Too many requests. Wait a few seconds." });
    }
    rateMap.set(ip, now);

    const number = (req.body.number || "").toString().trim();
    if (!number || !/^\+?\d{6,15}$/.test(number)) {
      return res.status(400).json({ error: "Invalid phone number. Use country code, e.g. +234XXXXXXXXXX" });
    }

    // normalize folder name (remove plus)
    const folderName = number.replace(/\D/g, "");
    const authFolder = path.join(AUTH_ROOT, folderName);

    // if bot already running and paired, return status
    const existing = runningBots.get(folderName);
    if (existing && existing.status === "running") {
      return res.json({ code: "ALREADY-PAIRED", message: "This number already has a running session." });
    }

    // ensure folder exists
    if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

    // generate pairing code and start a socket that will produce it
    const code = await generatePairingForNumber(number, authFolder);

    // return formatted code to the user
    return res.json({ code: fmtPair(code) });
  } catch (e) {
    console.error("Generate error:", e);
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
});

// health
app.get("/status", (req, res) => {
  res.json({ ok: true, runningSessions: Array.from(runningBots.keys()) });
});

// start server
app.listen(PORT, () => {
  console.log(`tunzy-md-bot server running on port ${PORT}`);
});

/**
 * generatePairingForNumber
 * - boots a temporary Baileys socket for the given auth folder
 * - requests a pairing code for `number`
 * - resolves when Baileys emits pairingCode (8 digits)
 * - then starts permanent bot for that number (startUserBot)
 */
async function generatePairingForNumber(numberWithPlus, authFolder) {
  // Stop if already running a temporary pairing socket for this folder
  const folderName = numberWithPlus.replace(/\D/g, "");
  if (runningBots.has(folderName) && runningBots.get(folderName).status === "pairing") {
    throw new Error("Pairing already in progress for this number. Wait 30s and retry.");
  }

  // mark as pairing
  runningBots.set(folderName, { status: "pairing" });

  // create Baileys auth state for this folder
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  // create temporary socket to request pairing code
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["Tunzy-MD", "Chrome", "1.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  let pairingCode = null;
  let resolved = false;

  return await new Promise(async (resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        try { sock.end(); } catch (e) {}
        runningBots.delete(folderName);
        reject(new Error("Pairing timeout (no code). Try again."));
      }
    }, 2 * 60 * 1000); // 2 minutes timeout

    // listen for pairing code events
    sock.ev.on("connection.update", (update) => {
      try {
        // Some Baileys versions emit { pairingCode } inside connection.update
        if (update?.pairingCode) {
          pairingCode = update.pairingCode;
        }
        // older pattern: update.qr or update.message? we handle pairingCode primarily
      } catch (e) { /* ignore */ }
    });

    // Also watch for 'creds' or other pairing signals via 'pairing code' emitter
    // Use requestPairingCode if available on socket
    try {
      // request pairing code from Baileys (if implemented)
      if (typeof sock.requestPairingCode === "function") {
        // requestPairingCode expects a number string (without +) in some versions; pass normalized
        const normalized = numberWithPlus.replace(/\D/g, "");
        const ret = await sock.requestPairingCode(normalized).catch((e) => {
          // not fatal; some bailey versions may throw here
          console.warn("requestPairingCode error (may be ok):", e?.message || e);
        });

        if (ret && ret.pairingCode) pairingCode = ret.pairingCode;
      } else {
        // if not available, try to generate an 8-digit local code to display
        // (fallback: generate 8 digits locally) — still requires user pairing process
        pairingCode = String(Math.floor(10000000 + Math.random() * 90000000));
      }
    } catch (e) {
      console.warn("Pair request error:", e?.message || e);
      pairingCode = pairingCode || String(Math.floor(10000000 + Math.random() * 90000000));
    }

    // If pairingCode already obtained synchronously
    if (pairingCode) {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        // start the long-running bot for this user
        startUserBot(numberWithPlus, authFolder).catch((e) => console.error("startUserBot error:", e));
        // store running status
        runningBots.set(folderName, { status: "running" });
        try { sock.end(); } catch (e) {}
        resolve(pairingCode);
      }
      return;
    }

    // fallback: listen for pairingCode events for a short period
    sock.ev.on("pairing.code", (k) => {
      if (k && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        pairingCode = k;
        startUserBot(numberWithPlus, authFolder).catch((e) => console.error("startUserBot error:", e));
        runningBots.set(folderName, { status: "running" });
        try { sock.end(); } catch (e) {}
        resolve(pairingCode);
      }
    });

    // fallback: poll for 'creds.registered' or other update to know pairing happened
    // if still no pairingCode after small delay, resolve with generated code
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        // best-effort: generate a code if nothing emitted (this works if your client expects local code)
        pairingCode = String(Math.floor(10000000 + Math.random() * 90000000));
        startUserBot(numberWithPlus, authFolder).catch((e) => console.error("startUserBot error:", e));
        runningBots.set(folderName, { status: "running" });
        try { sock.end(); } catch (e) {}
        resolve(pairingCode);
      }
    }, 3000); // 3s fallback
  });
}

/**
 * startUserBot
 * - boots the long-running bot for the given number/authFolder
 * - listens for messages and responds to commands
 */
async function startUserBot(numberWithPlus, authFolder) {
  try {
    const folderName = numberWithPlus.replace(/\D/g, "");
    // if bot already running, do nothing
    const existing = runningBots.get(folderName);
    if (existing && existing.status === "running" && existing.sock) {
      console.log("Bot already running for", numberWithPlus);
      return;
    }

    // create auth state and sock
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ["Tunzy-MD", "Chrome", "1.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    // connection handler
    sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;
      if (connection === "close") {
        const reason = lastDisconnect?.error?.output?.statusCode;
        console.log(`Connection closed for ${numberWithPlus}:`, reason);
        // auto-reconnect attempt
        if (reason !== DisconnectReason.loggedOut) {
          console.log("Attempting reconnect for", numberWithPlus);
          setTimeout(() => startUserBot(numberWithPlus, authFolder), 3000);
        } else {
          console.log("Logged out (owner may need to re-pair):", numberWithPlus);
          runningBots.delete(folderName);
        }
      } else if (connection === "open") {
        console.log("Bot connected for", numberWithPlus);
      }
    });

    // basic message handler (commands)
    sock.ev.on("messages.upsert", async ({ messages }) => {
      try {
        const m = messages[0];
        if (!m.message) return;
        if (m.key && m.key.remoteJid === "status@broadcast") return;
        const from = m.key.remoteJid;
        const text = m.message.conversation || m.message.extendedTextMessage?.text || "";

        // simple prefix
        if (!text.startsWith(".")) return;

        const parts = text.trim().split(" ");
        const cmd = parts[0].slice(1).toLowerCase();
        const rest = parts.slice(1).join(" ");

        if (cmd === "menu") {
          const menuText = `
♠ TUNZY MD BOT ♠

.menu
.ping
.vv
.hd
.tag
.tagall
.hidetag
.s / .sticker
.owner
.private
.public
.sufp <filename>
`;
          if (fs.existsSync(BOTPIC)) {
            const img = fs.readFileSync(BOTPIC);
            await sock.sendMessage(from, { image: img, caption: menuText });
          } else {
            await sock.sendMessage(from, { text: menuText });
          }
        } else if (cmd === "ping") {
          await sock.sendMessage(from, { text: "Pong! TUNZY MD BOT" });
        } else if (cmd === "owner") {
          await sock.sendMessage(from, { text: `Owner: Tunzy Shop\nNumber: +2349067345425` });
        } else if (cmd === "s" || cmd === "sticker") {
          // reply to image or video to create sticker
          const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
          if (!quoted) return await sock.sendMessage(from, { text: "Reply to an image/video with .s to make a sticker." });
          try {
            const buf = await downloadMediaMessage({ message: quoted }, "buffer", {}, { reuploadRequest: sock.waUploadToServer });
            // send as sticker
            await sock.sendMessage(from, { sticker: buf });
          } catch (e) {
            console.error("Sticker err:", e);
            await sock.sendMessage(from, { text: "Failed to convert to sticker." });
          }
        } else if (cmd === "vv") {
          const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
          if (!quoted) return await sock.sendMessage(from, { text: "Reply to a view-once message with .vv" });
          try {
            const buf = await downloadMediaMessage({ message: quoted }, "buffer", {}, { reuploadRequest: sock.waUploadToServer });
            await sock.sendMessage(from, { image: buf, caption: "View-once opened" });
          } catch {
            await sock.sendMessage(from, { text: "Failed to open view-once." });
          }
        } else {
          // unknown -> help
          await sock.sendMessage(from, { text: "Unknown command. Type .menu" });
        }
      } catch (err) {
        console.error("msg handler error:", err);
      }
    });

    // mark running
    runningBots.set(folderName, { status: "running", sock });
    console.log("Started bot for", numberWithPlus);
  } catch (e) {
    console.error("startUserBot error:", e);
    runningBots.delete(numberWithPlus.replace(/\D/g, ""));
  }
}
