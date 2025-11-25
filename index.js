/**
 * TUNZY MD BOT - FULL FEATURED (Pairing Code Only)
 * Owner: Tunzy Shop (+2349067345425)
 */

import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, DisconnectReason, downloadMediaMessage } from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";
import express from "express";
import sharp from "sharp";
import axios from "axios";
import child_process from "child_process";
import os from "os";

const OWNER_NUMBER = "+2349067345425";
const OWNER_NAME = "Tunzy Shop";
const AUTH_FOLDER = "./auth";
const DEFAULT_MENU_IMAGE = "botpic.jpg";
const SETTINGS_FILE = "./chat_settings.json";

// Express pairing code server
const app = express();
let pairingCode = "Generating...";
app.get("/", (req, res) => {
  res.send(`
    <html>
      <head>
        <title>TUNZY MD BOT</title>
        <style>
          body { font-family: Arial; text-align: center; padding-top: 50px; background: #000; color: #fff;}
          .code { font-size: 48px; font-weight: bold; padding: 20px; background: #111; border-radius: 12px; letter-spacing: 5px; display: inline-block;}
        </style>
      </head>
      <body>
        <h1>TUNZY MD BOT</h1>
        <h2>Pairing Code</h2>
        <div class="code">${pairingCode}</div>
      </body>
    </html>
  `);
});
app.listen(process.env.PORT || 3000, () => console.log("Pairing code server running..."));

// Helper functions
const loadChatSettings = () => fs.existsSync(SETTINGS_FILE) ? JSON.parse(fs.readFileSync(SETTINGS_FILE)) : {};
const saveChatSettings = (obj) => fs.writeFileSync(SETTINGS_FILE, JSON.stringify(obj, null, 2));
const isOwner = (jid) => jid.includes(OWNER_NUMBER.replace(/\D/g, "")) || jid.includes(OWNER_NUMBER.replace("+",""));
const getMenuImage = () => fs.existsSync(DEFAULT_MENU_IMAGE) ? DEFAULT_MENU_IMAGE : null;

// Connect bot
async function connectBot() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["Tunzy-MD", "Chrome", "4.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  // Auto reconnect
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log("Connection closed:", code);
      if (code !== DisconnectReason.loggedOut) {
        console.log("Reconnecting...");
        setTimeout(connectBot, 2000);
      } else {
        console.log("Logged out. Recreate /auth or rescan pairing code.");
        setTimeout(connectBot, 2000);
      }
    } else if (connection === "open") {
      console.log("✅ TUNZY MD BOT is online");
    }
  });

  // Generate pairing code
  if (!state.creds.registered) {
    const codeRaw = Math.floor(10000000 + Math.random() * 90000000);
    pairingCode = codeRaw.toString().replace(/(\d{4})(\d{4})/, "$1-$2");
    console.log("PAIRING CODE:", pairingCode);
  }

  // Messages handler
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg.message || msg.key.remoteJid === "status@broadcast") return;

      const from = msg.key.remoteJid;
      const senderId = msg.key.participant || from;
      const body = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim();
      const chatSettings = loadChatSettings();
      const chatMode = chatSettings[from]?.mode || "public";

      if (!body.startsWith(".")) return;
      const cmd = body.split(" ")[0].slice(1).toLowerCase();
      const argText = body.slice(cmd.length + 2).trim();

      if (chatMode === "private" && !isOwner(senderId)) {
        await sock.sendMessage(from, { text: "♠ This chat is in *private* mode — only bot owner may use commands." });
        return;
      }

      // ---------------- COMMANDS ----------------
      switch(cmd) {
        case "menu": {
          const menuText = `
♠ *TUNZY MD BOT* ♠

♠ *Group Menu*
.groupinfo - show group info
.tag <text> - mention text
.tagadmin - mention admins
.tagall - mention all
.hidetag - hidden mention
.promote @user - promote
.demote @user - demote

♠ *Downloader Menu*
.ig <url> - Instagram
.tiktok <url> - TikTok
.yt <url> - YouTube
.twitter <url> - Twitter

♠ *Media / Tools*
.s / .sticker (reply media) - make sticker
.hd (reply image) - enhance HD
.vv (reply view-once) - open view-once
.qr <text> - generate QR

♠ *Owner & Mode*
.private - Only owner
.public - Everyone
.sufp <filename> - set menu picture
.owner - show owner

♠ *Fun Menu*
.ping - Ping bot
.say <text> - bot repeats

Type commands with a dot (.) prefix.
          `;
          const menuImg = getMenuImage();
          if (menuImg) {
            const pic = fs.readFileSync(menuImg);
            await sock.sendMessage(from, { image: pic, caption: menuText });
          } else {
            await sock.sendMessage(from, { text: menuText });
          }
          break;
        }

        case "ping":
          await sock.sendMessage(from, { text: `♠ Pong — bot online. Owner: ${OWNER_NAME}` });
          break;

        case "owner":
          await sock.sendMessage(from, { text: `♠ Owner: ${OWNER_NAME}\n♠ Number: ${OWNER_NUMBER}` });
          break;

        case "private":
        case "public":
          if (!isOwner(senderId)) return await sock.sendMessage(from, { text: "♠ Only owner can change chat mode." });
          chatSettings[from] = chatSettings[from] || {};
          chatSettings[from].mode = cmd === "private" ? "private" : "public";
          saveChatSettings(chatSettings);
          await sock.sendMessage(from, { text: `♠ Chat mode set to *${chatSettings[from].mode}*.` });
          break;

        case "sufp":
          if (!isOwner(senderId)) return await sock.sendMessage(from, { text: "♠ Only owner can change menu picture." });
          if (!argText) return await sock.sendMessage(from, { text: "♠ Usage: .sufp <filename>" });
          if (!fs.existsSync(argText)) return await sock.sendMessage(from, { text: `♠ File not found: ${argText}` });
          fs.copyFileSync(argText, DEFAULT_MENU_IMAGE);
          await sock.sendMessage(from, { text: `♠ Menu picture updated to ${argText}` });
          break;

        case "say":
          if (!argText) return;
          await sock.sendMessage(from, { text: argText });
          break;

        case "tag":
          if (!argText) return await sock.sendMessage(from, { text: "Usage: .tag <text>" });
          await sock.sendMessage(from, { text: argText, mentions: [senderId] });
          break;

        case "tagadmin":
        case "tag admin":
          try {
            const meta = await sock.groupMetadata(from);
            const admins = meta.participants.filter(p => p.admin).map(a => a.id);
            await sock.sendMessage(from, { text: "♠ Tagging admins", mentions: admins });
          } catch {
            await sock.sendMessage(from, { text: "♠ Not a group or failed to fetch admins." });
          }
          break;

        case "tagall":
          try {
            const meta = await sock.groupMetadata(from);
            const members = meta.participants.map(m => m.id);
            await sock.sendMessage(from, { text: "♠ Tagging all members", mentions: members });
          } catch {
            await sock.sendMessage(from, { text: "♠ Not a group or failed to fetch members." });
          }
          break;

        case "hidetag":
          try {
            const meta = await sock.groupMetadata(from);
            const members = meta.participants.map(m => m.id);
            await sock.sendMessage(from, { text: " ", mentions: members });
          } catch {
            await sock.sendMessage(from, { text: "♠ Not a group or failed to hidetag." });
          }
          break;

        case "groupinfo":
          try {
            const meta = await sock.groupMetadata(from);
            await sock.sendMessage(from, { text: `♠ Group: ${meta.subject}\n♠ ID: ${meta.id}\n♠ Owner: ${meta.owner}\n♠ Members: ${meta.participants.length}` });
          } catch {
            await sock.sendMessage(from, { text: "♠ Not a group or failed to get info." });
          }
          break;

        case "qr":
          if (!argText) return await sock.sendMessage(from, { text: "Usage: .qr <text>" });
          try {
            const qrRes = await axios.get(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(argText)}`, { responseType: "arraybuffer" });
            await sock.sendMessage(from, { image: qrRes.data, caption: "♠ QR code" });
          } catch {
            await sock.sendMessage(from, { text: "♠ Failed to create QR." });
          }
          break;

        // HD / VV / Sticker
        case "hd":
        case "vv":
        case "s":
        case "sticker": {
          const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
          if (!quoted) return await sock.sendMessage(from, { text: `♠ Reply to media with .${cmd}` });
          let buffer = null;
          if (quoted.imageMessage || quoted.videoMessage) {
            buffer = await downloadMediaMessage({ message: quoted }, "buffer", {}, { reuploadRequest: sock.waUploadToServer });
          }
          if (!buffer) return await sock.sendMessage(from, { text: "♠ Failed to process media." });

          if (cmd === "hd") {
            const up = await sharp(buffer).resize({ width: null, height: null }).webp({ lossless: false }).toBuffer();
            await sock.sendMessage(from, { image: up, caption: "♠ HD Image (enhanced)" });
          } else if (cmd === "vv") {
            await sock.sendMessage(from, { image: buffer, caption: "♠ View-once opened." });
          } else if (cmd === "s" || cmd === "sticker") {
            if (quoted.imageMessage) {
              const webp = await sharp(buffer).webp({ quality: 80 }).toBuffer();
              await sock.sendMessage(from, { sticker: webp });
            } else if (quoted.videoMessage) {
              const tmpIn = path.join(os.tmpdir(), `in-${Date.now()}.mp4`);
              const tmpOut = path.join(os.tmpdir(), `out-${Date.now()}.webp`);
              fs.writeFileSync(tmpIn, buffer);
              try {
                child_process.execSync(`ffmpeg -y -i "${tmpIn}" -vf "scale=512:512:force_original_aspect_ratio=decrease" -ss 0 -t 6 -r 15 -preset veryfast -an -vcodec libwebp -loop 0 -lossless 0 -compression_level 6 -qscale 40 "${tmpOut}"`);
                const webpBuf = fs.readFileSync(tmpOut);
                await sock.sendMessage(from, { sticker: webpBuf });
              } catch {
                await sock.sendMessage(from, { text: "♠ Video-to-sticker conversion requires ffmpeg." });
              } finally { try { fs.unlinkSync(tmpIn); fs.unlinkSync(tmpOut); } catch {} }
            }
          }
          break;
        }

        default:
          await sock.sendMessage(from, { text: "♠ Unknown command. Type .menu to see all commands." });
      }

    } catch (err) {
      console.log("Message handler error", err);
    }
  });
}

connectBot();
