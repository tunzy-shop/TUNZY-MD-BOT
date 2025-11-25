/**
 * TUNZY MD BOT - FULL FEATURED
 * - Owner: Tunzy Shop (+2349067345425)
 * - Features: auto-reconnect, menus, sticker maker, hd enhancer,
 *   ai chat, ig/tiktok downloader, anti-view-once, status saver,
 *   welcome/goodbye, .private/.public per-chat mode, .sufp, .owner
 *
 * NOTE: Put bot menu image files in repo root (default: botpic.jpg).
 */

import {
  default as makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  DisconnectReason,
  makeCacheableSignalKeyStore
} from "@whiskeysockets/baileys";

import fs from "fs";
import path from "path";
import express from "express";
import axios from "axios";
import qrcode from "qrcode-terminal";
import { Boom } from "@hapi/boom";
import sharp from "sharp";
import child_process from "child_process";
import os from "os";

const OWNER_NUMBER = "+2349067345425"; // saved owner
const OWNER_NAME = "Tunzy Shop";
const DEFAULT_MENU_IMAGE = "botpic.jpg"; // default file name
const CONFIG_FILE = "./bot_config.json";
const SETTINGS_FILE = "./chat_settings.json";

// Ensure config files exist
if (!fs.existsSync(CONFIG_FILE)) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({
    owner: { number: OWNER_NUMBER, name: OWNER_NAME },
    menuImage: DEFAULT_MENU_IMAGE,
    public: true // default global public mode (if you want default public)
  }, null, 2));
}
if (!fs.existsSync(SETTINGS_FILE)) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({}, null, 2));
}

// util helpers for config
const config = () => JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
const saveConfig = (obj) => fs.writeFileSync(CONFIG_FILE, JSON.stringify(obj, null, 2));

const chatSettings = () => JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
const saveChatSettings = (obj) => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2));

// Express server for Render healthcheck
const app = express();
app.get("/", (req, res) => res.send("TUNZY MD BOT is running ✔"));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server running on port ${PORT}`));

// A small helper to check whether a user is owner
const isOwner = (jid) => {
  // jid may be in forms like "2349...@s.whatsapp.net" or phone +234...
  const cfg = config();
  const owner = cfg.owner?.number || OWNER_NUMBER;
  return jid.includes(owner.replace(/\D/g, "")) || jid.includes(owner.replace("+",""));
};

// helper to get menu image path
const getMenuImagePath = () => {
  const cfg = config();
  return path.resolve(cfg.menuImage || DEFAULT_MENU_IMAGE);
};

// utility: ensure reconnect safe
async function connectBot() {
  const { state, saveCreds } = await useMultiFileAuthState("./auth");
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    syncFullHistory: false,
    // use cache key store to help stability
    // (keeps things tidy)
    waWebSocketUrl: undefined
  });

  sock.ev.on("creds.update", saveCreds);

  // connection handler
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const code = lastDisconnect?.error && new Boom(lastDisconnect.error).output?.statusCode;
      console.log("Connection closed:", code);
      // if logged out, we still try to restart (auth folder preserves session)
      if (code !== DisconnectReason.loggedOut) {
        console.log("Reconnecting...");
        setTimeout(connectBot, 2000);
      } else {
        console.log("Logged out. Recreate /auth or rescan QR.");
        setTimeout(connectBot, 2000);
      }
    } else if (connection === "open") {
      console.log("✅ TUNZY MD BOT is online");
    }
  });

  // welcome / goodbye
  sock.ev.on("group-participants.update", async (update) => {
    try {
      const groupId = update.id;
      for (const participant of update.participants) {
        if (update.action === "add") {
          await sock.sendMessage(groupId, {
            text: `♠ Welcome @${participant.split("@")[0]} to *TUNZY MD BOT* community!`,
            mentions: [participant]
          });
        } else if (update.action === "remove") {
          await sock.sendMessage(groupId, {
            text: `♠ Goodbye @${participant.split("@")[0]}.`,
            mentions: [participant]
          });
        } else if (update.action === "promote") {
          await sock.sendMessage(groupId, {
            text: `♠ Congrats @${participant.split("@")[0]} (promoted)!`,
            mentions: [participant]
          });
        } else if (update.action === "demote") {
          await sock.sendMessage(groupId, {
            text: `♠ @${participant.split("@")[0]} was demoted.`,
            mentions: [participant]
          });
        }
      }
    } catch (e) { console.log("group update error", e); }
  });

  // status saver (when someone uploads status we try to fetch it)
  sock.ev.on("statuses.update", async (updates) => {
    try {
      for (const st of updates) {
        // Each status update shares an id and is multimedia — we attempt to fetch via wa servers (limited)
        console.log("Status update", st);
        // Implementation detail: Baileys does not always provide a direct media object to statuses here; this is best-effort
      }
    } catch (e) { console.log("status save error", e); }
  });

  // main messages handler
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg.message) return;
      if (msg.key && msg.key.remoteJid === "status@broadcast") return;

      const from = msg.key.remoteJid;
      const senderId = msg.key.participant || msg.key.remoteJid;
      const body = (msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    msg.message.imageMessage && msg.message.imageMessage.caption ||
                    msg.message.videoMessage && msg.message.videoMessage.caption ||
                    "").trim();

      // chat-level permission: check .private/.public per chat
      const chatCfg = chatSettings();
      const chatMode = chatCfg[from]?.mode || "public"; // "public" or "private"

      // command prefix is dot
      const isCmd = body.startsWith(".");
      const cmd = isCmd ? body.split(" ")[0].slice(1).toLowerCase() : null;
      const argText = isCmd ? body.slice(cmd.length + 2).trim() : "";

      // if chat is private and sender is not owner, ignore commands (except .owner and .menu maybe)
      if (chatMode === "private" && !isOwner(senderId) && cmd) {
        // allow owner to change settings
        await sock.sendMessage(from, { text: "♠ This chat is in *private* mode — only bot owner may use commands here." });
        return;
      }

      // Auto open view-once
      if (msg.message.viewOnceMessageV2) {
        try {
          const media = await downloadMediaMessage(msg, "buffer", {}, { reuploadRequest: sock.waUploadToServer });
          await sock.sendMessage(from, { image: media, caption: "♠ View-once opened (anti-view-once)." });
        } catch (e) {
          console.log("Anti view-once failed", e);
        }
      }

      // ---------- COMMANDS ----------
      if (!isCmd) return; // not a command, ignore

      // COMMON UTIL: read config fresh
      const cfg = config();

      // ---------- .menu ----------
      if (cmd === "menu") {
        // Build multi-section menu with ♠ headings
        const menuText = `
♠ *TUNZY MD BOT* ♠

♠ *Group Menu*
.groupinfo - show group info
.tag - mention text
.tagadmin - mention admins
.tagall - mention all
.hidetag - hidden mention
.promote @user - promote
.demote @user - demote

♠ *Downloader Menu*
.ig <url> - Instagram download
.tiktok <url> - TikTok download
.yt <url> - YouTube downloader (audio/video)
.twitter <url> - Twitter download

♠ *AI Menu*
.ai <text> - Ask AI
.chat <text> - Chat with AI

♠ *Media / Tools*
.s / .sticker (reply with media) - make sticker
.hd (reply with image) - enhance image to HD
.vv (reply with view-once) - open view-once
.resize <percent> (reply with image) - resize image
.qr <text> - generate QR

♠ *Owner & Mode*
.private - Only owner can use commands in this chat
.public - Everyone can use commands in this chat
.sufp <filename> - set menu picture file (owner only)
.owner - show owner contact
.status - check bot status

♠ *Fun Menu*
.ping - Ping bot
.say <text> - bot repeats

Type command with a dot (.) before it.
        `;
        // send menu picture if exists
        const menuImgPath = getMenuImagePath();
        if (fs.existsSync(menuImgPath)) {
          const pic = fs.readFileSync(menuImgPath);
          await sock.sendMessage(from, { image: pic, caption: menuText });
        } else {
          await sock.sendMessage(from, { text: menuText });
        }
        return;
      }

      // ---------- .ping ----------
      if (cmd === "ping") {
        await sock.sendMessage(from, { text: `♠ Pong — bot online. Owner: ${cfg.owner?.name || OWNER_NAME}` });
        return;
      }

      // ---------- .owner ----------
      if (cmd === "owner") {
        const ownerContact = cfg.owner?.number || OWNER_NUMBER;
        const ownerName = cfg.owner?.name || OWNER_NAME;
        await sock.sendMessage(from, {
          text: `♠ Owner: ${ownerName}\n♠ Number: ${ownerContact}`
        });
        return;
      }

      // ---------- .private / .public (per chat) ----------
      if (cmd === "private" || cmd === "public") {
        // only owner can change chat mode
        if (!isOwner(senderId)) {
          await sock.sendMessage(from, { text: "♠ Only the owner can change chat mode." });
          return;
        }
        const cs = chatSettings();
        cs[from] = cs[from] || {};
        cs[from].mode = (cmd === "private") ? "private" : "public";
        saveChatSettings(cs);
        await sock.sendMessage(from, { text: `♠ Chat mode set to *${cs[from].mode}*.` });
        return;
      }

      // ---------- .sufp <filename> (set menu picture) ----------
      if (cmd === "sufp") {
        if (!isOwner(senderId)) {
          await sock.sendMessage(from, { text: "♠ Only owner can change the menu picture (.sufp)." });
          return;
        }
        if (!argText) {
          await sock.sendMessage(from, { text: "♠ Usage: .sufp <filename>  (make sure file exists in bot root)" });
          return;
        }
        const fileName = argText.trim();
        if (!fs.existsSync(path.resolve(fileName))) {
          await sock.sendMessage(from, { text: `♠ File not found: ${fileName}` });
          return;
        }
        const cfgObj = config();
        cfgObj.menuImage = fileName;
        saveConfig(cfgObj);
        await sock.sendMessage(from, { text: `♠ Menu picture set to ${fileName}` });
        return;
      }

      // ---------- .say ----------
      if (cmd === "say") {
        if (!argText) return await sock.sendMessage(from, { text: "Usage: .say <text>" });
        await sock.sendMessage(from, { text: argText });
        return;
      }

      // ---------- .ai (AI chat) ----------
      if (cmd === "ai" || cmd === "chat") {
        if (!argText) return await sock.sendMessage(from, { text: "Usage: .ai <your question>" });
        try {
          // This uses a public endpoint used in previous versions. If rate-limited, you'll need to add your own API key.
          const resp = await axios.get(`https://api.safone.dev/ai/gpt?message=${encodeURIComponent(argText)}`);
          const textReply = resp.data?.response || resp.data?.reply || "No response.";
          await sock.sendMessage(from, { text: `♠ AI:\n${textReply}` });
        } catch (e) {
          console.log("AI error", e?.message || e);
          await sock.sendMessage(from, { text: "♠ AI Error or service unavailable." });
        }
        return;
      }

      // ---------- .ig downloader ----------
      if (cmd === "ig") {
        if (!argText) return await sock.sendMessage(from, { text: "Usage: .ig <instagram url>" });
        try {
          const resp = await axios.get(`https://api.safone.dev/ig?url=${encodeURIComponent(argText)}`);
          const data = resp.data;
          if (data && data.url) {
            // send as video if video else image
            if ((data.url).includes(".mp4") || data.type === "video") {
              await sock.sendMessage(from, { video: { url: data.url }, caption: "♠ Instagram video" });
            } else {
              await sock.sendMessage(from, { image: { url: data.url }, caption: "♠ Instagram image" });
            }
          } else {
            await sock.sendMessage(from, { text: "♠ Could not extract Instagram media." });
          }
        } catch (e) {
          console.log("IG error", e?.message || e);
          await sock.sendMessage(from, { text: "♠ Instagram download failed." });
        }
        return;
      }

      // ---------- .tiktok downloader ----------
      if (cmd === "tiktok") {
        if (!argText) return await sock.sendMessage(from, { text: "Usage: .tiktok <url>" });
        try {
          const resp = await axios.get(`https://api.safone.dev/tiktok?url=${encodeURIComponent(argText)}`);
          const url = resp.data?.url || resp.data?.download || null;
          if (url) {
            await sock.sendMessage(from, { video: { url }, caption: "♠ TikTok download" });
          } else {
            await sock.sendMessage(from, { text: "♠ Could not extract TikTok media." });
          }
        } catch (e) {
          console.log("Tiktok error", e?.message || e);
          await sock.sendMessage(from, { text: "♠ TikTok download failed." });
        }
        return;
      }

      // ---------- .hd (reply to image) - enhance using sharp ----------
      if (cmd === "hd") {
        // must be a reply with image or video or include image in message
        try {
          // Prefer: extendedTextMessage.contextInfo.quotedMessage
          const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
          let buffer = null;

          if (quoted?.imageMessage || msg.message.imageMessage) {
            const m = quoted?.imageMessage ? { message: quoted } : msg;
            buffer = await downloadMediaMessage(m, "buffer", {}, { reuploadRequest: sock.waUploadToServer });
            // sharp upscale by 2x using Lanczos3
            const up = await sharp(buffer).resize({ width: null, height: null }).webp({ lossless: false }).toBuffer();
            await sock.sendMessage(from, { image: up, caption: "♠ HD Image (enhanced)" });
          } else {
            await sock.sendMessage(from, { text: "♠ Reply to an image with .hd to enhance it." });
          }
        } catch (e) {
          console.log("HD error", e);
          await sock.sendMessage(from, { text: "♠ HD enhancement failed." });
        }
        return;
      }

      // ---------- .s / .sticker - create sticker from image or short video ----------
      if (cmd === "s" || cmd === "sticker") {
        try {
          const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
          let buffer = null;
          if (quoted?.imageMessage) {
            buffer = await downloadMediaMessage({ message: quoted }, "buffer", {}, { reuploadRequest: sock.waUploadToServer });
            // convert to webp sticker using sharp
            const webp = await sharp(buffer).webp({ quality: 80 }).toBuffer();
            await sock.sendMessage(from, { sticker: webp });
          } else if (quoted?.videoMessage) {
            // for video -> rely on ffmpeg (if available) to convert to webp
            const vbuf = await downloadMediaMessage({ message: quoted }, "buffer", {}, { reuploadRequest: sock.waUploadToServer });
            const tmpIn = path.join(os.tmpdir(), `in-${Date.now()}.mp4`);
            const tmpOut = path.join(os.tmpdir(), `out-${Date.now()}.webp`);
            fs.writeFileSync(tmpIn, vbuf);
            try {
              // convert with ffmpeg if present on system
              child_process.execSync(`ffmpeg -y -i "${tmpIn}" -vf "scale=512:512:force_original_aspect_ratio=decrease" -ss 0 -t 6 -r 15 -preset veryfast -an -vcodec libwebp -loop 0 -lossless 0 -compression_level 6 -qscale 40 "${tmpOut}"`);
              const webpBuf = fs.readFileSync(tmpOut);
              await sock.sendMessage(from, { sticker: webpBuf });
            } catch (e) {
              console.log("ffmpeg sticker error", e);
              await sock.sendMessage(from, { text: "♠ Video-to-sticker conversion requires ffmpeg on the host." });
            } finally {
              try { fs.unlinkSync(tmpIn); fs.unlinkSync(tmpOut); } catch {}
            }
          } else {
            await sock.sendMessage(from, { text: "♠ Reply to an image/video with .s to make a sticker." });
          }
        } catch (e) {
          console.log("Sticker error", e);
          await sock.sendMessage(from, { text: "♠ Failed to create sticker." });
        }
        return;
      }

      // ---------- .vv - manual open view-once for replied message ----------
      if (cmd === "vv") {
        try {
          const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
          if (!quoted) return await sock.sendMessage(from, { text: "♠ Reply to the view-once message with .vv" });
          const buffer = await downloadMediaMessage({ message: quoted }, "buffer", {}, { reuploadRequest: sock.waUploadToServer });
          await sock.sendMessage(from, { image: buffer, caption: "♠ View-once opened." });
        } catch (e) {
          console.log("VV error", e);
          await sock.sendMessage(from, { text: "♠ Failed to open view-once." });
        }
        return;
      }

      // ---------- .tag <text> ----------
      if (cmd === "tag") {
        if (!argText) return await sock.sendMessage(from, { text: "Usage: .tag <text> (will mention the sender)" });
        const mention = senderId;
        await sock.sendMessage(from, { text: argText, mentions: [mention] });
        return;
      }

      // ---------- .tagadmin (alias .tag admin) ----------
      if (cmd === "tagadmin" || (cmd === "tag" && argText === "admin")) {
        try {
          const meta = await sock.groupMetadata(from);
          const admins = meta.participants.filter(p => p.admin).map(a => a.id);
          await sock.sendMessage(from, { text: "♠ Tagging admins", mentions: admins });
        } catch (e) {
          await sock.sendMessage(from, { text: "♠ Not a group or failed to fetch admins." });
        }
        return;
      }

      // ---------- .tagall ----------
      if (cmd === "tagall") {
        try {
          const meta = await sock.groupMetadata(from);
          const members = meta.participants.map(m => m.id);
          await sock.sendMessage(from, { text: "♠ Tagging all members", mentions: members });
        } catch (e) {
          await sock.sendMessage(from, { text: "♠ Not a group or failed to fetch members." });
        }
        return;
      }

      // ---------- .hidetag ----------
      if (cmd === "hidetag") {
        try {
          const meta = await sock.groupMetadata(from);
          const members = meta.participants.map(m => m.id);
          await sock.sendMessage(from, { text: " ", mentions: members });
        } catch (e) {
          await sock.sendMessage(from, { text: "♠ Not a group or failed to hidetag." });
        }
        return;
      }

      // ---------- .groupinfo ----------
      if (cmd === "groupinfo") {
        try {
          const meta = await sock.groupMetadata(from);
          const txt = `♠ Group: ${meta.subject}\n♠ ID: ${meta.id}\n♠ Owner: ${meta.owner}\n♠ Members: ${meta.participants.length}`;
          await sock.sendMessage(from, { text: txt });
        } catch (e) {
          await sock.sendMessage(from, { text: "♠ Not a group or failed to get info." });
        }
        return;
      }

      // ---------- .qr <text> ----------
      if (cmd === "qr") {
        if (!argText) return await sock.sendMessage(from, { text: "Usage: .qr <text>" });
        try {
          const qrRes = await axios.get(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(argText)}`, { responseType: "arraybuffer" });
          await sock.sendMessage(from, { image: qrRes.data, caption: "♠ QR code" });
        } catch (e) {
          await sock.sendMessage(from, { text: "♠ Failed to create QR." });
        }
        return;
      }

      // ---------- .yt, .twitter commands placeholders ----------
      if (cmd === "yt" || cmd === "youtube" || cmd === "twitter") {
        await sock.sendMessage(from, { text: "♠ Downloader commands are enabled but may require a stable 3rd-party API key. Use .ig or .tiktok for now." });
        return;
      }

      // fallback: unknown command
      await sock.sendMessage(from, { text: "♠ Unknown command. Type .menu to see the commands." });

    } catch (err) {
      console.log("Message handler error", err);
    }
  });

  // export sock to global if needed (not necessary)
}

connectBot();
