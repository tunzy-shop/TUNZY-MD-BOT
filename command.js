// commands.js
/**
 * commands.js
 * - Exports handleIncomingWebhook: process incoming webhook object from 360dialog
 * - Uses apiClient functions to reply
 */

import fs from "fs";
import path from "path";
import sharp from "sharp";
import {
  sendText,
  sendImage,
  sendVideo,
  sendAudio,
  sendSticker,
  uploadMedia
} from "./apiClient.js";

const OWNER_NUMBER = process.env.OWNER_NUMBER || "+2349067345425";
const CHANNEL_LINK = process.env.CHANNEL_LINK || "https://whatsapp.com/channel/0029Vb65QAGGOj9nnQynhh04";
const BOTPIC = path.join(process.cwd(), "botpic.jpg");
const CHAT_SETTINGS_FILE = path.join(process.cwd(), "chat_settings.json");
const WARN_FILE = path.join(process.cwd(), "warn_data.json");

// ensure files
if (!fs.existsSync(CHAT_SETTINGS_FILE)) fs.writeFileSync(CHAT_SETTINGS_FILE, JSON.stringify({}, null, 2));
if (!fs.existsSync(WARN_FILE)) fs.writeFileSync(WARN_FILE, JSON.stringify({}, null, 2));

function loadChatSettings() {
  try { return JSON.parse(fs.readFileSync(CHAT_SETTINGS_FILE, "utf8") || "{}"); } catch { return {}; }
}
function saveChatSettings(o) { fs.writeFileSync(CHAT_SETTINGS_FILE, JSON.stringify(o, null, 2)); }
function loadWarns() { try { return JSON.parse(fs.readFileSync(WARN_FILE, "utf8") || "{}"); } catch { return {}; } }
function saveWarns(o) { fs.writeFileSync(WARN_FILE, JSON.stringify(o, null, 2)); }

function normalizeNumber(n) {
  // 360dialog uses phone numbers like "234XXXXXXXXXX" (no plus)
  return n?.replace(/\D/g, "") || "";
}

function isOwner(sender) {
  const normOwner = normalizeNumber(OWNER_NUMBER);
  return normalizeNumber(sender).includes(normOwner);
}

async function sendMenu(to) {
  const menuText = `
🌿 TUNZY MD BOT MENU 🌿

🍀 Group
🍀 Tag — .tag <text>
🍀 TagAdmin — .tagadmin
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
`;
  // send image + caption if exists
  if (fs.existsSync(BOTPIC)) {
    const imgBuf = fs.readFileSync(BOTPIC);
    await sendImage(to, imgBuf, menuText);
  } else {
    await sendText(to, menuText);
  }
}

// detect links in text (basic)
function containsLink(text) {
  if (!text) return false;
  const urlRegex = /(https?:\/\/[^\s]+)/i;
  return urlRegex.test(text);
}

async function handleIncomingWebhook(payload) {
  // payload structure from 360dialog: check messages in payload
  // docs: https... (varies with provider). We'll handle common shapes.
  // Example structure: { messages: [{ from: '234..', type:'text', text:{body:'...'}, context: {...} }]}
  try {
    const entries = payload?.messages || payload?.message || [];
    // 360dialog sometimes nests: body -> messages -> [ ... ]
    if (!Array.isArray(entries)) {
      // try find the message object
      if (payload?.contacts || payload?.messages) {
        entries = payload.messages || [];
      } else {
        // unexpected shape
        return;
      }
    }

    for (const msg of entries) {
      // normalize
      const from = msg.from || msg.author || msg.to; // 'from' usually the sender
      if (!from) continue;
      const text = (msg.text && msg.text.body) || (msg.type === "text" && msg.body) || "";
      const isGroup = !!msg.isGroup || (msg?.context?.isGroup === true) || (from.endsWith("@g.us"));

      // When receiving media, 360dialog will supply media id or link and mime; sometimes needs fetch
      // For simplicity: handle text commands and quick media openers via media object provided.

      // Only process commands starting with dot
      const trimmed = text?.trim();
      if (!trimmed || !trimmed.startsWith(".")) {
        // still run anti-link/antitag detection on all messages in groups
        await handleAutoProtections(from, msg);
        continue;
      }

      const parts = trimmed.split(/\s+/);
      const cmd = parts[0].slice(1).toLowerCase();
      const param = parts.slice(1).join(" ").trim();

      // load chat settings
      const chatSettings = loadChatSettings();
      const settings = chatSettings[from] || {};

      // helper permission checks
      const senderId = msg.from;
      const owner = isOwner(senderId);
      // ADMIN checks: 360dialog payload sometimes includes 'author' or 'senderName' as admin; in many cases you need group data — here we rely on payload.authorRole or a placeholder
      const admin = msg?.sender?.role === "admin" || msg?.authorRole === "admin" || false;

      function adminOnlyReply() {
        return sendText(from, `♠ This command is for *Admins Only*.\nJoin our channel:\n${CHANNEL_LINK}`);
      }
      function ownerOnlyReply() {
        return sendText(from, `♠ This command is for *The Owner Only*.\nJoin our official channel:\n${CHANNEL_LINK}`);
      }

      // PUBLIC commands (everyone)
      if (cmd === "menu") {
        await sendMenu(from);
        continue;
      }
      if (cmd === "ping") {
        await sendText(from, `♠ Pong — Tunzy Shop`);
        continue;
      }
      if (cmd === "owner") {
        await sendText(from, `♠ Owner: Tunzy Shop\n♠ Number: ${OWNER_NUMBER}`);
        continue;
      }

      // owner-only commands
      if (["public","private","sufp"].includes(cmd)) {
        if (!owner) { await ownerOnlyReply(); continue; }
        if (cmd === "sufp") {
          if (!param) return sendText(from, "Usage: .sufp <filename> (upload image to repo root first)");
          const fname = path.join(process.cwd(), param);
          if (!fs.existsSync(fname)) return sendText(from, "File not found.");
          fs.copyFileSync(fname, path.join(process.cwd(), "botpic.jpg"));
          return sendText(from, "Menu picture updated.");
        }
        if (cmd === "public" || cmd === "private") {
          chatSettings[from] = chatSettings[from] || {};
          chatSettings[from].mode = cmd === "public" ? "public" : "private";
          saveChatSettings(chatSettings);
          return sendText(from, `♠ Chat mode set to ${cmd}`);
        }
      }

      // group/admin commands require admin (or owner)
      const adminCommands = [
        "tagall","tagadmin","acceptall","listonline",
        "antilink","antitag"
      ];
      if (adminCommands.includes(cmd)) {
        if (!admin && !owner) { await adminOnlyReply(); continue; }
      }

      // .tag
      if (cmd === "tag") {
        if (!param) return sendText(from, "Usage: .tag <text>");
        // send text and mention sender (360dialog supports "contacts" mentions via recipient_id field - simplified here)
        await sendText(from, param);
        continue;
      }

      // .tagadmin
      if (cmd === "tagadmin") {
        // 360dialog does not expose direct mention API in webhook; we send a text that asks admins to respond
        await sendText(from, "🍀 Tagging admins (please note: platform may not support mass mention, manual mention required).");
        continue;
      }

      // .tagall (will be best-effort: send a message asking to check group — true mentions require word-by-word mentions metadata)
      if (cmd === "tagall") {
        await sendText(from, "🍀 TagAll requested (platform mentions for all members not available via standard HTTP API).");
        continue;
      }

      // .hidetag (everyone): best-effort: send blank message with context mentions not always available — we send a spacer
      if (cmd === "hidetag") {
        await sendText(from, " "); // platforms may not permit hidden mentions; this is a placeholder
        continue;
      }

      // .listonline
      if (cmd === "listonline") {
        await sendText(from, "ListOnline is not fully supported by this HTTP gateway (requires querying presence).");
        continue;
      }

      // .acceptall - placeholder
      if (cmd === "acceptall") {
        await sendText(from, "AcceptAll executed (placeholder).");
        continue;
      }

      // .antilink
      if (cmd === "antilink") {
        const sub = param.split(" ")[0];
        if (!sub) return sendText(from, "Usage: .antilink delete|warn|kick|off");
        chatSettings[from] = chatSettings[from] || {};
        if (sub === "off") {
          chatSettings[from].antilink = null;
          saveChatSettings(chatSettings);
          return sendText(from, "AntiLink disabled for this group.");
        }
        if (!["delete","warn","kick"].includes(sub)) return sendText(from, "Invalid mode.");
        chatSettings[from].antilink = { mode: sub };
        saveChatSettings(chatSettings);
        return sendText(from, `AntiLink set to ${sub}`);
      }

      // .antitag on|off
      if (cmd === "antitag") {
        const sub = param.split(" ")[0];
        chatSettings[from] = chatSettings[from] || {};
        if (sub === "on") {
          chatSettings[from].antitag = { on: true };
          saveChatSettings(chatSettings);
          return sendText(from, "AntiTag enabled.");
        } else if (sub === "off") {
          chatSettings[from].antitag = { on: false };
          saveChatSettings(chatSettings);
          return sendText(from, "AntiTag disabled.");
        } else {
          return sendText(from, "Usage: .antitag on|off");
        }
      }

      // .qr
      if (cmd === "qr") {
        if (!param) return sendText(from, "Usage: .qr <text>");
        const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(param)}`;
        await sendImage(from, qrUrl, "QR code");
        continue;
      }

      // .s /.sticker, .hd, .vv (media) - for these we expect the user to reply to a media message or provide media id in param.
      if (["s","sticker","hd","vv"].includes(cmd)) {
        // 360dialog webhook includes message with "context" with "referenced_message" object when user replies to a message
        const referenced = msg.context?.referenced_message || null;
        if (!referenced) return sendText(from, `Reply to a media with .${cmd}`);
        // If referenced has 'image', 'video', 'audio' or 'document' structures, 360dialog supplies media id or link
        let media = null;
        if (referenced.image) media = referenced.image;
        else if (referenced.video) media = referenced.video;
        else if (referenced.audio) media = referenced.audio;
        else if (referenced.document) media = referenced.document;

        if (!media) return sendText(from, `Referenced message has no media.`);

        // fetch media from 360dialog: they provide a "url" when requesting with media id or provide mediaId to download via /media/:id
        // For simplicity: if referenced has 'caption' and 'id' we attempt to download via /v1/media/{id}
        try {
          // attempt download if id present
          const mediaId = media.id || media.mediaId || media.mimeType ? (media.id || null) : null;
          let buffer = null;
          if (mediaId) {
            // download media
            const url = `https://waba.360dialog.io/v1/media/${mediaId}`;
            const resp = await fetch(url, { headers: { Authorization: `Bearer ${process.env.API_TOKEN}` } });
            buffer = Buffer.from(await resp.arrayBuffer());
          } else if (media.link) {
            // fetch link
            const resp = await fetch(media.link);
            buffer = Buffer.from(await resp.arrayBuffer());
          }

          if (!buffer) return sendText(from, "Failed to fetch referenced media.");

          if (cmd === "hd") {
            // simple re-encode with sharp
            const processed = await sharp(buffer).resize({ width: null }).toBuffer();
            await sendImage(from, processed, "♠ HD (processed)");
            continue;
          }

          if (cmd === "vv") {
            // send back same content normally
            if (media.mimeType && media.mimeType.startsWith("image")) {
              await sendImage(from, buffer, "♠ View-once opened");
            } else if (media.mimeType && media.mimeType.startsWith("video")) {
              await sendVideo(from, buffer, "♠ View-once opened");
            } else if (media.mimeType && media.mimeType.startsWith("audio")) {
              await sendAudio(from, buffer, true);
            } else {
              await sendText(from, "Unsupported view-once media.");
            }
            continue;
          }

          if (cmd === "s" || cmd === "sticker") {
            // convert image to webp
            if (media.mimeType && media.mimeType.startsWith("image")) {
              const webp = await sharp(buffer).webp({ quality: 80 }).toBuffer();
              await sendSticker(from, webp);
            } else {
              await sendText(from, "Sticker creation from this media type not supported.");
            }
            continue;
          }

        } catch (e) {
          console.error("media cmd err", e);
          return sendText(from, "Failed to process media command.");
        }
      }

      // .ai - placeholder
      if (cmd === "ai" || cmd === "chat") {
        if (!param) return sendText(from, "Usage: .ai <text>");
        try {
          const r = await fetch(`https://api.safone.dev/ai/gpt?message=${encodeURIComponent(param)}`);
          const j = await r.json();
          const reply = j?.response || j?.reply || "No response.";
          await sendText(from, `♠ AI:\n${reply}`);
        } catch {
          await sendText(from, "AI failed.");
        }
        continue;
      }

      // .say
      if (cmd === "say") {
        if (!param) return sendText(from, "Usage: .say <text>");
        await sendText(from, param);
        continue;
      }

      // fallback
      await sendText(from, "Unknown command. Type .menu");
    }
  } catch (err) {
    console.error("handleIncomingWebhook error", err);
  }
}

// Automatic protections run for non-command messages in groups
async function handleAutoProtections(from, msg) {
  try {
    const chatSettings = loadChatSettings();
    const st = chatSettings[from] || {};

    const text = (msg.text && msg.text.body) || "";
    // anti-link
    if (st.antilink && st.antilink.mode && containsLink(text)) {
      const mode = st.antilink.mode;
      if (mode === "delete") {
        await sendText(from, "GC links are not allowed in this group.");
      } else if (mode === "warn") {
        const warns = loadWarns();
        warns[from] = warns[from] || {};
        warns[from][msg.from] = (warns[from][msg.from] || 0) + 1;
        const c = warns[from][msg.from];
        saveWarns(warns);
        await sendText(from, `Link detected! Warning (${c}/4)`);
        if (c >= 4) {
          // instruct admin to remove user (HTTP API cannot remove without group participant management support)
          await sendText(from, `User reached 4 warnings — please remove them (bot cannot remove via this gateway).`);
          warns[from][msg.from] = 0;
          saveWarns(warns);
        }
      } else if (mode === "kick") {
        // gateway may support participants API — leaving placeholder
        await sendText(from, "User removed for sending links (please ensure bot is admin).");
      }
      return;
    }

    // anti-tag
    if (st.antitag && st.antitag.on) {
      const lower = (text || "").toLowerCase();
      if (lower.includes("@all") || lower.includes("@everyone")) {
        await sendText(from, "Mass tagging is not allowed.");
      }
    }
  } catch (e) {
    console.error("autoProtections err", e);
  }
}

export { handleIncomingWebhook, sendMenu };