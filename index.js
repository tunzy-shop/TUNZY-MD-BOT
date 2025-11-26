// index.js
/**
 * tunzy-md-bot — Pairing page + session creation (multi-user)
 * Serves beautiful pairing page and returns real Baileys pairing code.
 *
 * Requirements: @whiskeysockets/baileys, express, cors
 */

import express from "express";
import cors from "cors";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { useMultiFileAuthState } from "@whiskeysockets/baileys";
import startUserBot from "./bot.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const AUTH_ROOT = path.join(process.cwd(), "auth");
if (!fs.existsSync(AUTH_ROOT)) fs.mkdirSync(AUTH_ROOT, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Simple rate limiter per IP
const lastRequest = new Map();
const COOLDOWN_MS = 8 * 1000;

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "pair.html"));
});

/**
 * POST /generate
 * body: { number: "+234..." }
 * returns: { code: "ABCD-1234" } or { error: "..." }
 */
app.post("/generate", async (req, res) => {
  try {
    const ip = req.ip || req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    const now = Date.now();
    if (lastRequest.get(ip) && now - lastRequest.get(ip) < COOLDOWN_MS) {
      return res.status(429).json({ error: "Too many requests. Wait a few seconds." });
    }
    lastRequest.set(ip, now);

    const number = (req.body?.number || "").toString().trim();
    if (!number || !/^\+?\d{6,15}$/.test(number)) {
      return res.status(400).json({ error: "Invalid phone number. Include country code, e.g. +234XXXXXXXXXX" });
    }

    const normalized = number.replace(/\D/g, "");
    const authFolder = path.join(AUTH_ROOT, normalized);
    if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

    // Create auth state to ensure folder gets created with required files
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    // request pairing code using Baileys helper exposed by startUserBot
    // The startUserBot exposes a helper to request pairing code. We call it indirectly
    // by launching a temporary socket inside startUserBot if not already running.
    // For reliability we call startUserBot which will start the long-running bot and return once pairing code generated.
    const pairingCode = await startUserBot(number, authFolder, { pairingOnly: true });

    if (!pairingCode) {
      return res.status(500).json({ error: "Failed to generate pairing code. Try again." });
    }

    // format like 1234-5678 if not already formatted
    const code = pairingCode.toString().replace(/(\w{4})(\w{4})/, "$1-$2");
    return res.json({ code });
  } catch (e) {
    console.error("generate error:", e);
    return res.status(500).json({ error: "Server error", details: String(e) });
  }
});

// status route
app.get("/status", (req, res) => {
  const sessions = fs.existsSync(AUTH_ROOT) ? fs.readdirSync(AUTH_ROOT) : [];
  res.json({ ok: true, sessions });
});

app.listen(PORT, () => {
  console.log(`tunzy-md-bot running on port ${PORT}`);
});
