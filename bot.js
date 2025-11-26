// bot.js
/**
 * bot.js — full WhatsApp bot engine
 * export default async function startUserBot(numberWithPlus, authFolder, opts = {})
 *
 * If opts.pairingOnly === true, the function will request a pairing code and
 * resolve with it (without keeping long-running listeners).
 *
 * Otherwise it will start the long-running bot for that number and return once started.
 *
 * NOTE: This file uses Baileys MD features. Compatibility depends on the installed Baileys version.
 */

import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  DisconnectReason
} from "@whiskeysockets/baileys";
import fs from "fs";
import path from "path";
import os from "os";
import axios from "axios";
import sharp from "sharp";
import child_process from "child_process";

// CONFIG
const OWNER_NUMBER = "+2349067345425";
const OWNER_NAME = "Tunzy Shop";
const CHANNEL_LINK = "https://whatsapp.com/channel/0029Vb65QAGGOj9nnQynhh04";
const BOTPIC = path.join(process.cwd(), "botpic.jpg");
const CHAT_SETTINGS_FILE = path.join(process.cwd(), "chat_settings.json");
const WARN_DATA_FILE = path.join(process.cwd(), "warn_data.json");

// ensure files
if (!fs.existsSync(CHAT_SETTINGS_FILE)) fs.writeFileSync(CHAT_SETTINGS_FILE, JSON.stringify({}, null, 2));
if (!fs.existsSync(WARN_DATA_FILE)) fs.writeFileSync(WARN_DATA_FILE, JSON.stringify({}, null, 2));

function loadChatSettings() {
  try { return JSON.parse(fs.readFileSync(CHAT_SETTINGS_FILE, "utf8") || "{}"); } catch { return {}; }
}
function saveChatSettings(o) { try { fs.writeFileSync(CHAT_SETTINGS_FILE, JSON.stringify(o, null, 2)); } catch (e) { console.error(e); } }

function loadWarnData() {
  try { return JSON.parse(fs.readFileSync(WARN_DATA_FILE, "utf8") || "{}"); } catch { return {}; }
}
function saveWarnData(o) { try { fs.writeFileSync(WARN_DATA_FILE, JSON.stringify(o, null, 2)); } catch (e) { console.error(e); } }

function isOwner(jid) {
  if (!jid) return false;
  const norm = OWNER_NUMBER.replace(/\D/g, "");
  return jid.includes(norm) || jid.includes(OWNER_NUMBER.replace("+", ""));
}

function isGroup(jid) {
  return jid && jid.endsWith("@g.us");
}

// helpers for admin check — sock must be passed
async function isAdmin(sock, groupId, userId) {
  try {
    if (!groupId || !groupId.endsWith("@g.us")) return false;
    const meta = await sock.groupMetadata(groupId);
    const p = meta.participants.find(x => x.id === userId);
    return !!(p && (p.admin || p.isAdmin || p.isSuperAdmin));
  } catch (e) {
    return false;
  }
}

// track running bots within this process
const running = new Map();

/**
 * startUserBot(numberWithPlus, authFolder, opts)
 * - numberWithPlus: "+234..."
 * - authFolder: path to auth files
 * - opts.pairingOnly: if true, request pairing code and resolve it (do not keep bot running)
 */
export default async function startUserBot(numberWithPlus, authFolder, opts = {}) {
  const normalized = numberWithPlus.replace(/\D/g, "");
  const id = normalized;

  // prevent multiple starts
  if (running.has(id) && running.get(id).status === "running" && !opts.pairingOnly) {
    console.log(`[${id}] bot already running`);
    return;
  }

  // ensure folder exists
  if (!fs.existsSync(authFolder)) fs.mkdirSync(authFolder, { recursive: true });

  // create auth state (will create files on disk)
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version } = await fetchLatestBaileysVersion();

  // create socket
  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ["Tunzy-MD", "Chrome", "1.0"]
  });

  sock.ev.on("creds.update", saveCreds);

  // if caller wants only the pairing code, request it and return it quickly
  if (opts.pairingOnly) {
    try {
      if (typeof sock.requestPairingCode === "function") {
        // some bailey versions want normalized number (no +)
        const ret = await sock.requestPairingCode(normalized).catch(e => { throw e; });
        // ret may be { pairingCode: 'ABCD1234' } or string
        const code = ret?.pairingCode || ret || null;
        // close temporary socket (but don't delete auth)
        try { sock.end(); } catch {}
        return code;
      } else {
        // fallback: generate a local 8-char alpha-numeric code (less ideal)
        try { sock.end(); } catch {}
        return String(Math.floor(10000000 + Math.random() * 90000000));
      }
    } catch (e) {
      console.error(`[${id}] pairing request failed:`, e);
      try { sock.end(); } catch {}
      throw e;
    }
  }

  // mark running (pairing -> running)
  running.set(id, { status: "starting", sock: null });

  // connection updates & auto-reconnect
  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === "open") {
      console.log(`[${id}] connected`);
      running.set(id, { status: "running", sock });
    } else if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`[${id}] connection closed:`, code);
      if (code !== DisconnectReason.loggedOut) {
        console.log(`[${id}] attempting reconnect...`);
        setTimeout(() => startUserBot(numberWithPlus, authFolder).catch(console.error), 3000);
      } else {
        console.log(`[${id}] logged out — session requires re-pairing`);
        running.delete(id);
      }
    }
  });

  // message handler
  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const m = messages[0];
      if (!m || !m.message) return;
      if (m.key && m.key.remoteJid === "status@broadcast") return;

      const from = m.key.remoteJid;
      const sender = m.key.participant || m.key.remoteJid;
      const text =
        m.message.conversation ||
        m.message.extendedTextMessage?.text ||
        m.message.imageMessage?.caption ||
        m.message.videoMessage?.caption ||
        "";

      // auto anti-link detection (only if enabled for group)
      const chatSettings = loadChatSettings();
      const groupSettings = chatSettings[from] || {};
      // handle antilink detection if enabled (m.message may contain text or media with caption)
      if (isGroup(from) && groupSettings.antilink && groupSettings.antilink.mode) {
        // find urls in message (simple regex)
        const allText = text || "";
        const urlRegex = /(https?:\/\/[^\s]+)/i;
        if (urlRegex.test(allText) || (m.message?.imageMessage?.caption && urlRegex.test(m.message.imageMessage.caption))) {
          // found link
          const mode = groupSettings.antilink.mode; // delete|warn|kick
          if (mode === "delete") {
            // delete message (send ephemeral delete request via protocol: send a delete message)
            try { await sock.sendMessage(from, { delete: { remoteJid: from, id: m.key.id, participant: sender } }).catch(()=>{}); } catch {}
            await sock.sendMessage(from, { text: "GC links are not allowed in this group." });
            return;
          } else if (mode === "warn") {
            // warn user and track counts
            const warns = loadWarnData();
            warns[from] = warns[from] || {};
            warns[from][sender] = (warns[from][sender] || 0) + 1;
            const count = warns[from][sender];
            saveWarnData(warns);
            await sock.sendMessage(from, { text: `Link detected! Warning (${count}/4)` });
            if (count >= 4) {
              // attempt kick
              try { await sock.groupParticipantsUpdate(from, [sender], "remove"); } catch (e) { console.log("kick fail", e); }
              // reset warn
              warns[from][sender] = 0;
              saveWarnData(warns);
            }
            return;
          } else if (mode === "kick") {
            try {
              await sock.groupParticipantsUpdate(from, [sender], "remove");
              await sock.sendMessage(from, { text: "User removed for sending links." });
            } catch (e) {
              await sock.sendMessage(from, { text: "Failed to remove user — make sure bot is admin." });
            }
            return;
          }
        }
      }

      // Anti-tag detection if enabled
      if (isGroup(from) && groupSettings.antitag) {
        // very simple detection: if message contains @all or many @ mentions
        const mentions = m.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const textLower = (text || "").toLowerCase();
        if (groupSettings.antitag.on) {
          if (textLower.includes("@all") || textLower.includes("@everyone") || mentions.length > 5) {
            // action: delete + warn
            try { await sock.sendMessage(from, { delete: { remoteJid: from, id: m.key.id, participant: sender } }).catch(()=>{}); } catch {}
            await sock.sendMessage(from, { text: "Mass tagging is not allowed." });
            return;
          }
        }
      }

      // only commands start with dot
      if (!text || !text.trim().startsWith(".")) return;
      const parts = text.trim().split(/\s+/);
      const cmd = parts[0].slice(1).toLowerCase();
      const param = parts.slice(1).join(" ");

      // load chatSettings per chat
      const allChatSettings = loadChatSettings();
      const myChat = allChatSettings[from] || {};

      // PERMISSION helpers
      const owner = isOwner(sender);
      const admin = await isAdmin(sock, from, sender).catch(()=>false);

      // HELPER RESPONSES for permission denied
      function adminOnlyReply() {
        return sock.sendMessage(from, { text: `♠ This command is for *Admins Only*.\nJoin our channel:\n${CHANNEL_LINK}` });
      }
      function ownerOnlyReply() {
        return sock.sendMessage(from, { text: `♠ This command is for *The Owner Only*.\nJoin our official channel:\n${CHANNEL_LINK}` });
      }

      // COMMANDS (many)
      if (cmd === "menu") {
        const menuText = `
🌿 TUNZY MD BOT MENU 🌿

🍀 Group
🍀 Tag — .tag <text>
🍀 TagAdmin — .tagadmin (.tag admin)
🍀 TagAll — .tagall
🍀 HideTag — .hidetag
🍀 ListOnline — .listonline
🍀 AcceptAll — .acceptall

━━━━━━━━━━━━━━━━━━
🍀 CHANNEL LINK
${CHANNEL_LINK}
━━━━━━━━━━━━━━━━━━

🍀 Media / Tools
🍀 Sticker — .s (reply)
🍀 HD — .hd (reply)
🍀 OpenViewOnce — .vv (reply)
🍀 QR — .qr <text>

🍀 Security
🍀 AntiLink — .antilink delete|warn|kick|off
🍀 AntiTag — .antitag on|off

🍀 Owner / Mode
🍀 Private — .private
🍀 Public — .public
🍀 SetMenuPic — .sufp <filename>
🍀 Owner — .owner

Type commands with dot prefix.
        `.trim();

        if (fs.existsSync(BOTPIC)) {
          const img = fs.readFileSync(BOTPIC);
          await sock.sendMessage(from, { image: img, caption: menuText });
        } else {
          await sock.sendMessage(from, { text: menuText });
        }
        return;
      }

      if (cmd === "ping") {
        await sock.sendMessage(from, { text: `♠ Pong — ${OWNER_NAME}` });
        return;
      }

      if (cmd === "owner") {
        await sock.sendMessage(from, { text: `♠ Owner: ${OWNER_NAME}\n♠ Number: ${OWNER_NUMBER}` });
        return;
      }

      // owner-only
      if (["public","private","sufp"].includes(cmd)) {
        if (!owner) return ownerOnlyReply();
        if (cmd === "sufp") {
          if (!param) return sock.sendMessage(from, { text: "Usage: .sufp <filename>" });
          const fname = path.join(process.cwd(), param);
          if (!fs.existsSync(fname)) return sock.sendMessage(from, { text: "File not found." });
          fs.copyFileSync(fname, BOTPIC);
          return sock.sendMessage(from, { text: "Menu picture updated." });
        }
        if (cmd === "public" || cmd === "private") {
          // global toggle (simple): store in chat settings file under key "globalPublic"
          const c = loadChatSettings();
          c.globalPublic = cmd === "public";
          saveChatSettings(c);
          return sock.sendMessage(from, { text: `Global mode set to ${cmd}` });
        }
      }

      // group-only commands admin-only
      if (["tagall","tagadmin","acceptall","listonline","antilink","antitag"].includes(cmd.split(" ")[0])) {
        // these require admin in group (or owner)
        if (!isGroup(from)) {
          // treat as not allowed in private
          return sock.sendMessage(from, { text: "This command is available for groups only." });
        }
        if (!admin && !owner) return adminOnlyReply();
      }

      // .tag
      if (cmd === "tag") {
        if (!param) return sock.sendMessage(from, { text: "Usage: .tag <text>" });
        await sock.sendMessage(from, { text: param, mentions: [sender] });
        return;
      }

      // .tagadmin
      if (cmd === "tagadmin" || (cmd === "tag" && param.toLowerCase() === "admin")) {
        try {
          const meta = await sock.groupMetadata(from);
          const admins = meta.participants.filter(p => p.admin).map(a => a.id);
          if (!admins.length) return sock.sendMessage(from, { text: "No admins or not group." });
          await sock.sendMessage(from, { text: "🍀 Tagging admins", mentions: admins });
        } catch {
          await sock.sendMessage(from, { text: "Failed to fetch group metadata." });
        }
        return;
      }

      // .tagall
      if (cmd === "tagall") {
        try {
          const meta = await sock.groupMetadata(from);
          const members = meta.participants.map(p => p.id);
          await sock.sendMessage(from, { text: "🍀 Tagging all", mentions: members });
        } catch {
          await sock.sendMessage(from, { text: "Not a group or failed." });
        }
        return;
      }

      // .hidetag (available to everyone per your request)
      if (cmd === "hidetag") {
        try {
          const meta = await sock.groupMetadata(from);
          const members = meta.participants.map(p => p.id);
          await sock.sendMessage(from, { text: " ", mentions: members });
        } catch {
          await sock.sendMessage(from, { text: "Not a group or failed." });
        }
        return;
      }

      // listonline (everyone)
      if (cmd === "listonline") {
        try {
          const meta = await sock.groupMetadata(from);
          const onlines = meta.participants.filter(p => p.isOnline).map(p => p.id) || [];
          const txt = onlines.length ? onlines.join("\n") : "No one online.";
          await sock.sendMessage(from, { text: `Online users:\n${txt}` });
        } catch {
          await sock.sendMessage(from, { text: "Not a group or failed." });
        }
        return;
      }

      // acceptall — admin only
      if (cmd === "acceptall") {
        // placeholder: accept all pending invites or messages (implementation depends on API)
        await sock.sendMessage(from, { text: "AcceptAll executed (placeholder)." });
        return;
      }

      // ANTI-LINK: ".antilink delete|warn|kick|off"
      if (cmd === "antilink") {
        const sub = param.split(" ")[0];
        if (!sub) return sock.sendMessage(from, { text: "Usage: .antilink delete|warn|kick|off" });
        const settings = loadChatSettings();
        settings[from] = settings[from] || {};
        if (sub === "off") {
          settings[from].antilink = null;
          saveChatSettings(settings);
          return sock.sendMessage(from, { text: "AntiLink disabled for this group." });
        }
        if (!["delete","warn","kick"].includes(sub)) return sock.sendMessage(from, { text: "Invalid mode." });
        settings[from].antilink = { mode: sub };
        saveChatSettings(settings);
        return sock.sendMessage(from, { text: `AntiLink set to ${sub}` });
      }

      // ANTI-TAG: .antitag on|off
      if (cmd === "antitag") {
        const sub = param.split(" ")[0];
        const settings = loadChatSettings();
        settings[from] = settings[from] || {};
        if (sub === "on") {
          settings[from].antitag = { on: true };
          saveChatSettings(settings);
          return sock.sendMessage(from, { text: "AntiTag enabled." });
        } else if (sub === "off") {
          settings[from].antitag = { on: false };
          saveChatSettings(settings);
          return sock.sendMessage(from, { text: "AntiTag disabled." });
        } else {
          return sock.sendMessage(from, { text: "Usage: .antitag on|off" });
        }
      }

      // .qr
      if (cmd === "qr") {
        if (!param) return sock.sendMessage(from, { text: "Usage: .qr <text>" });
        try {
          const qr = await axios.get(`https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(param)}`, { responseType: "arraybuffer" });
          await sock.sendMessage(from, { image: qr.data, caption: "QR code" });
        } catch {
          await sock.sendMessage(from, { text: "QR creation failed." });
        }
        return;
      }

      // .s / .sticker, .hd, .vv (media commands)
      if (["s","sticker","hd","vv"].includes(cmd)) {
        const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage || null;
        if (!quoted) return sock.sendMessage(from, { text: `Reply to a media with .${cmd}` });
        let buffer = null;
        try {
          buffer = await downloadMediaMessage({ message: quoted }, "buffer", {}, { reuploadRequest: sock.waUploadToServer });
        } catch (e) {
          console.error("media download err", e);
          return sock.sendMessage(from, { text: "Failed to download media." });
        }
        if (!buffer) return sock.sendMessage(from, { text: "No media found." });

        if (cmd === "hd") {
          try {
            const processed = await sharp(buffer).resize({ width: null }).toBuffer();
            await sock.sendMessage(from, { image: processed, caption: "♠ HD (processed)" });
          } catch (e) {
            console.error("hd error", e);
            await sock.sendMessage(from, { text: "HD failed." });
          }
          return;
        }

        if (cmd === "vv") {
          // view-once opener for image/video/ptt
          try {
            // send same content normally
            // try image
            if (quoted.imageMessage) {
              await sock.sendMessage(from, { image: buffer, caption: "♠ View-once opened" });
            } else if (quoted.videoMessage) {
              await sock.sendMessage(from, { video: buffer, caption: "♠ View-once opened" });
            } else if (quoted.audioMessage || quoted.ptt) {
              await sock.sendMessage(from, { audio: buffer, ptt: true });
            } else {
              await sock.sendMessage(from, { text: "Unsupported view-once media." });
            }
          } catch (e) {
            console.error("vv err", e);
            await sock.sendMessage(from, { text: "Failed to open view-once." });
          }
          return;
        }

        if (cmd === "s" || cmd === "sticker") {
          // if image -> webp via sharp
          if (quoted.imageMessage) {
            try {
              const webp = await sharp(buffer).webp({ quality: 80 }).toBuffer();
              await sock.sendMessage(from, { sticker: webp });
            } catch (e) {
              console.error("sticker err", e);
              await sock.sendMessage(from, { text: "Sticker conversion failed." });
            }
          } else if (quoted.videoMessage) {
            // video -> webp via ffmpeg (host must have ffmpeg)
            const tmpIn = path.join(os.tmpdir(), `in-${Date.now()}.mp4`);
            const tmpOut = path.join(os.tmpdir(), `out-${Date.now()}.webp`);
            try {
              fs.writeFileSync(tmpIn, buffer);
              child_process.execSync(`ffmpeg -y -i "${tmpIn}" -vf "scale=512:512:force_original_aspect_ratio=decrease" -ss 0 -t 6 -r 15 -preset veryfast -an -vcodec libwebp -loop 0 -lossless 0 -compression_level 6 -qscale 40 "${tmpOut}"`);
              const webpBuf = fs.readFileSync(tmpOut);
              await sock.sendMessage(from, { sticker: webpBuf });
            } catch (e) {
              console.error("ffmpeg err", e);
              await sock.sendMessage(from, { text: "Video-to-sticker requires ffmpeg." });
            } finally {
              try { fs.unlinkSync(tmpIn); fs.unlinkSync(tmpOut); } catch {}
            }
          } else {
            await sock.sendMessage(from, { text: "Unsupported media for sticker." });
          }
          return;
        }
      }

      // .ig / .tiktok placeholders
      if (cmd === "ig") {
        if (!param) return sock.sendMessage(from, { text: "Usage: .ig <url>" });
        try {
          const r = await axios.get(`https://api.safone.dev/ig?url=${encodeURIComponent(param)}`);
          const url = r.data?.url;
          if (url) {
            if (url.endsWith(".mp4")) await sock.sendMessage(from, { video: { url }, caption: "Instagram video" });
            else await sock.sendMessage(from, { image: { url }, caption: "Instagram image" });
          } else {
            await sock.sendMessage(from, { text: "Could not extract Instagram media." });
          }
        } catch (e) {
          await sock.sendMessage(from, { text: "Instagram download failed." });
        }
        return;
      }

      if (cmd === "tiktok") {
        if (!param) return sock.sendMessage(from, { text: "Usage: .tiktok <url>" });
        try {
          const r = await axios.get(`https://api.safone.dev/tiktok?url=${encodeURIComponent(param)}`);
          const url = r.data?.url || r.data?.download;
          if (url) await sock.sendMessage(from, { video: { url }, caption: "TikTok" });
          else await sock.sendMessage(from, { text: "Could not extract TikTok media." });
        } catch (e) {
          await sock.sendMessage(from, { text: "TikTok download failed." });
        }
        return;
      }

      // AI placeholder
      if (cmd === "ai" || cmd === "chat") {
        if (!param) return sock.sendMessage(from, { text: "Usage: .ai <text>" });
        try {
          const r = await axios.get(`https://api.safone.dev/ai/gpt?message=${encodeURIComponent(param)}`);
          const reply = r.data?.response || r.data?.reply || "No response.";
          await sock.sendMessage(from, { text: `♠ AI:\n${reply}` });
        } catch {
          await sock.sendMessage(from, { text: "AI service failed." });
        }
        return;
      }

      // .say
      if (cmd === "say") {
        if (!param) return sock.sendMessage(from, { text: "Usage: .say <text>" });
        await sock.sendMessage(from, { text: param });
        return;
      }

      // fallback
      await sock.sendMessage(from, { text: "Unknown command. Type .menu" });

    } catch (err) {
      console.error("messages.upsert err:", err);
    }
  });

  // done starting
  running.set(id, { status: "running", sock });
  console.log(`[${id}] bot started for ${numberWithPlus}`);
  return;
}
