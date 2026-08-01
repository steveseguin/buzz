"use strict";

const crypto = require("node:crypto");

const MAX_BUZZ_CONTENT_LENGTH = 6000;

function decodeHtmlEntities(value) {
  function numeric(match, code, radix) {
    const codePoint = Number.parseInt(code, radix);
    return Number.isInteger(codePoint) &&
      codePoint >= 0 &&
      codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : match;
  }

  return String(value || "")
    .replace(/&#(\d+);/g, (match, code) => numeric(match, code, 10))
    .replace(/&#x([0-9a-f]+);/gi, (match, code) => numeric(match, code, 16))
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}

function plainText(value) {
  return decodeHtmlEntities(
    String(value || "")
      .replace(/<img\b[^>]*\balt=(['"])(.*?)\1[^>]*>/gi, " $2 ")
      .replace(/<br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

function unwrapMessage(packet) {
  if (!packet || typeof packet !== "object") return null;
  if (packet.overlayNinja && typeof packet.overlayNinja === "object")
    return packet.overlayNinja;
  if (packet.dataReceived && typeof packet.dataReceived === "object")
    return unwrapMessage(packet.dataReceived);
  if (packet.detail && typeof packet.detail === "object")
    return unwrapMessage(packet.detail.data);
  return packet;
}

function makeMessageId(message) {
  const stable = {
    type: message.type || "",
    id: message.mid || message.messageId || message.id || "",
    timestamp: message.timestamp || "",
    sourceId: message.sourceId || message.tid || "",
    chatname: message.chatname || "",
    chatmessage: message.chatmessage || "",
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stable))
    .digest("hex");
}

function normalizeSocialStreamMessage(packet) {
  const message = unwrapMessage(packet);
  if (!message || typeof message !== "object") return null;
  const text = plainText(message.chatmessage || message.textContent);
  if (!text) return null;
  const platform =
    String(message.type || message.platform || "unknown")
      .trim()
      .toLowerCase() || "unknown";
  return {
    version: 1,
    messageId: makeMessageId(message),
    capturedAt: Number(message.timestamp) || Date.now(),
    platform,
    author:
      plainText(message.chatname || message.username || "Anonymous") ||
      "Anonymous",
    text,
    donation: plainText(message.hasDonation || message.donation || ""),
    sourceId: message.sourceId || message.tid || null,
  };
}

function escapeExternalMentions(value) {
  return String(value || "").replace(/@/g, "＠");
}

function formatBuzzContent(envelope) {
  const platform =
    envelope.platform === "unknown"
      ? "Social Stream"
      : envelope.platform.charAt(0).toUpperCase() + envelope.platform.slice(1);
  const donation = envelope.donation
    ? ` (${escapeExternalMentions(envelope.donation)})`
    : "";
  const content = `[${platform}] ${escapeExternalMentions(envelope.author)}${donation}: ${escapeExternalMentions(envelope.text)}`;
  return content.length > MAX_BUZZ_CONTENT_LENGTH
    ? `${content.slice(0, MAX_BUZZ_CONTENT_LENGTH - 1)}…`
    : content;
}

class RecentMessageIds {
  constructor(limit = 2000) {
    this.limit = limit;
    this.ids = new Map();
  }

  add(id) {
    if (this.ids.has(id)) return false;
    this.ids.set(id, true);
    while (this.ids.size > this.limit)
      this.ids.delete(this.ids.keys().next().value);
    return true;
  }

  delete(id) {
    return this.ids.delete(id);
  }
}

module.exports = {
  RecentMessageIds,
  formatBuzzContent,
  makeMessageId,
  normalizeSocialStreamMessage,
  plainText,
};
