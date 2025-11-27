// index.js
import express from "express";
import bodyParser from "body-parser";
import cors from "cors";
import { handleIncomingWebhook } from "./commands.js";
import dotenv from "dotenv";
import path from "path";

dotenv.config();
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "10mb" }));
app.use(express.static(path.join(process.cwd(), "public")));

// Health / simple status page
app.get("/", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "pair.html"));
});

// Webhook endpoint — configure this URL in your 360dialog dashboard
// 360dialog will POST incoming messages to this endpoint.
app.post("/webhook", async (req, res) => {
  try {
    // 360dialog POST body contains message data
    const body = req.body;
    // quick 200 to provider
    res.status(200).send({ status: "received" });
    // handle async
    await handleIncomingWebhook(body);
  } catch (e) {
    console.error("webhook handler error", e);
    res.status(500).send("error");
  }
});

// optional route to check sessions & settings
app.get("/admin/status", (req, res) => {
  res.json({ ok: true, owner: process.env.OWNER_NUMBER || null });
});

app.listen(PORT, () => {
  console.log(`tunzy-md-bot listening on port ${PORT}`);
});