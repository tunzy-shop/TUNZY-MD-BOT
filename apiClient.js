// apiClient.js
import axios from "axios";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
dotenv.config();

const API_TOKEN = process.env.API_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

if (!API_TOKEN || !PHONE_NUMBER_ID) {
  console.warn("Warning: API_TOKEN or PHONE_NUMBER_ID not set in environment.");
}

const BASE = "https://waba.360dialog.io/v1";

async function sendRequest(pathUrl, body, headers = {}) {
  const url = `${BASE}${pathUrl}`;
  const res = await axios.post(url, body, {
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      ...headers
    },
    timeout: 30_000
  });
  return res.data;
}

export async function sendText(to, text) {
  const body = {
    to,
    type: "text",
    text: { body: text }
  };
  return sendRequest(`/messages`, body);
}

// send image from local file buffer or url
export async function sendImage(to, bufferOrUrl, caption = "") {
  if (Buffer.isBuffer(bufferOrUrl)) {
    // upload media first
    const mediaId = await uploadMedia(bufferOrUrl, "image/jpeg");
    return sendRequest(`/messages`, {
      to,
      type: "image",
      image: { id: mediaId, caption }
    });
  } else {
    // external url
    return sendRequest(`/messages`, {
      to,
      type: "image",
      image: { link: bufferOrUrl, caption }
    });
  }
}

export async function sendVideo(to, bufferOrUrl, caption = "") {
  if (Buffer.isBuffer(bufferOrUrl)) {
    const mediaId = await uploadMedia(bufferOrUrl, "video/mp4");
    return sendRequest(`/messages`, {
      to,
      type: "video",
      video: { id: mediaId, caption }
    });
  } else {
    return sendRequest(`/messages`, {
      to,
      type: "video",
      video: { link: bufferOrUrl, caption }
    });
  }
}

export async function sendAudio(to, bufferOrUrl, isPtt = false) {
  if (Buffer.isBuffer(bufferOrUrl)) {
    const mediaId = await uploadMedia(bufferOrUrl, "audio/ogg");
    return sendRequest(`/messages`, {
      to,
      type: "audio",
      audio: { id: mediaId, ptt: isPtt }
    });
  } else {
    return sendRequest(`/messages`, {
      to,
      type: "audio",
      audio: { link: bufferOrUrl, ptt: isPtt }
    });
  }
}

export async function sendSticker(to, buffer) {
  const mediaId = await uploadMedia(buffer, "image/webp");
  return sendRequest(`/messages`, {
    to,
    type: "sticker",
    sticker: { id: mediaId }
  });
}

export async function uploadMedia(buffer, mimeType = "image/jpeg") {
  // 360dialog media upload endpoint
  const url = `${BASE}/media`;
  const form = new FormData();
  form.append("file", buffer, { filename: "file", contentType: mimeType });

  const res = await axios.post(url, form, {
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      ...form.getHeaders()
    },
    timeout: 30_000
  });
  // returns id
  return res.data?.id;
}