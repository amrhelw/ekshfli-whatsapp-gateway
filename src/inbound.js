/**
 * Baileys inbound → Laravel webhook (Phase 1 Conversations).
 * Does not alter outbound sendMessage pipeline.
 */
import pino from "pino";
import {
  normalizeIncomingMessage,
  serializeMessageForWebhook,
} from "./message-content.js";
import {
  DOWNLOADABLE_MEDIA_TYPES,
  attachDownloadedMediaToPayload,
  buildGatewayMediaTraceFields,
  downloadInboundMedia,
  gatewayMediaTrace,
} from "./media-download.js";
import { resolveProfilePictureUrl, resolveProfilePictureUrlCandidates } from "./profile-photo.js";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

/** @type {WeakSet<object>} */
const inboundAttachedSocks = new WeakSet();

let inboundAttachCount = 0;
let lastInboundEventAt = null;
let lastInboundPostAt = null;
let lastInboundPostStatus = null;
let lastInboundPostError = null;

/** Runtime telemetry for /health — filled only by live socket activity. */
let lastAttachAt = null;
let lastAttachClinicId = null;
let lastListenerCounts = null;
let lastEventNamesAtAttach = null;
let lastUpsertListenerCount = null;
let sockEvEventsObserved = 0;
let messagesUpsertObserved = 0;
/** @type {Array<{at:string,event:string,summary:string}>} */
const recentSockEvEvents = [];
const RECENT_EV_MAX = 80;

function inboundLog(step, fields = {}) {
  const payload = { tag: "[INBOUND]", step, ...fields };
  // Dual sink: pino (Railway) + console (always visible in Railway deploy logs)
  logger.info(payload, `[INBOUND] ${step}`);
  try {
    console.log(`[INBOUND] ${step}`, JSON.stringify(fields));
  } catch {
    console.log(`[INBOUND] ${step}`, fields);
  }
}

function inboundError(step, fields = {}) {
  const payload = { tag: "[INBOUND]", step, ...fields };
  logger.error(payload, `[INBOUND] ${step}`);
  try {
    console.error(`[INBOUND] ${step}`, JSON.stringify(fields));
  } catch {
    console.error(`[INBOUND] ${step}`, fields);
  }
}

/** Public config for /health — never includes raw secrets. */
export function getInboundWebhookConfig() {
  const url = String(process.env.LARAVEL_WEBHOOK_URL || "").trim();
  let host = null;
  try {
    if (url) host = new URL(url).host;
  } catch {
    host = "invalid_url";
  }
  const webhookToken = String(process.env.WEBHOOK_TOKEN || "").trim();
  const gatewayToken = String(process.env.GATEWAY_TOKEN || "").trim();
  let tokenSource = "none";
  if (webhookToken) tokenSource = "WEBHOOK_TOKEN";
  else if (gatewayToken) tokenSource = "GATEWAY_TOKEN";

  return {
    webhook_url_configured: url !== "",
    webhook_url: url || null,
    webhook_url_host: host,
    token_configured: tokenSource !== "none",
    token_source: tokenSource,
    listeners_attach_count: inboundAttachCount,
    last_attach_at: lastAttachAt,
    last_attach_clinic_id: lastAttachClinicId,
    last_listener_counts: lastListenerCounts,
    last_event_names_at_attach: lastEventNamesAtAttach,
    last_upsert_listener_count: lastUpsertListenerCount,
    sock_ev_events_observed: sockEvEventsObserved,
    messages_upsert_observed: messagesUpsertObserved,
    recent_sock_ev_events: recentSockEvEvents.slice(-40),
    last_inbound_event_at: lastInboundEventAt,
    last_inbound_post_at: lastInboundPostAt,
    last_inbound_post_status: lastInboundPostStatus,
    last_inbound_post_error: lastInboundPostError,
  };
}

function summarizeEvPayload(event, args) {
  try {
    if (event === "messages.upsert") {
      const upsert = args?.[0] || {};
      const messages = Array.isArray(upsert.messages) ? upsert.messages : [];
      const first = messages[0];
      return JSON.stringify({
        type: upsert.type || null,
        count: messages.length,
        message_id: first?.key?.id || null,
        remote_jid: first?.key?.remoteJid || null,
        from_me: first?.key?.fromMe ?? null,
      });
    }
    if (event === "connection.update") {
      const u = args?.[0] || {};
      return JSON.stringify({
        connection: u.connection || null,
        has_qr: Boolean(u.qr),
        lastDisconnect: u.lastDisconnect?.error?.message || null,
      });
    }
    if (event === "creds.update") return "creds.update";
    if (event === "messages.update") {
      const updates = Array.isArray(args?.[0]) ? args[0] : [];
      return JSON.stringify({ count: updates.length });
    }
    return typeof args?.[0] === "object" ? Object.keys(args[0] || {}).slice(0, 8).join(",") : String(args?.[0] ?? "");
  } catch {
    return "unprintable";
  }
}

function recordSockEvEvent(event, args) {
  sockEvEventsObserved += 1;
  const row = {
    at: new Date().toISOString(),
    event: String(event),
    summary: summarizeEvPayload(event, args),
  };
  recentSockEvEvents.push(row);
  if (recentSockEvEvents.length > RECENT_EV_MAX) {
    recentSockEvEvents.splice(0, recentSockEvEvents.length - RECENT_EV_MAX);
  }
  inboundLog("sock.ev event", row);
}

function countListeners(sock) {
  const ev = sock?.ev;
  if (!ev) return { event_names: [], counts: {}, upsert: 0 };
  const names =
    typeof ev.eventNames === "function"
      ? ev.eventNames().map(String)
      : ["messages.upsert", "messages.update", "connection.update", "creds.update"];
  const counts = {};
  for (const name of names) {
    counts[name] = typeof ev.listenerCount === "function" ? ev.listenerCount(name) : null;
  }
  const upsert =
    typeof ev.listenerCount === "function" ? ev.listenerCount("messages.upsert") : null;
  return { event_names: names, counts, upsert };
}

/**
 * Spy on every sock.ev emit for windowMs after attach/open (runtime audit).
 * Does not alter handler behavior.
 */
function spySockEvForWindow(clinicId, sock, windowMs = 30_000) {
  const ev = sock?.ev;
  if (!ev || typeof ev.emit !== "function") {
    inboundError("sock.ev spy unavailable", { clinic_id: clinicId });
    return;
  }
  if (ev.__ekshfliInboundSpyInstalled) {
    inboundLog("sock.ev spy already installed", { clinic_id: clinicId });
    return;
  }
  const originalEmit = ev.emit.bind(ev);
  const startedAt = Date.now();
  ev.__ekshfliInboundSpyInstalled = true;
  ev.emit = (event, ...args) => {
    if (Date.now() - startedAt <= windowMs) {
      try {
        recordSockEvEvent(event, args);
      } catch {
        /* never break Baileys */
      }
    }
    return originalEmit(event, ...args);
  };
  inboundLog("sock.ev spy active for 30s", {
    clinic_id: clinicId,
    window_ms: windowMs,
  });
  setTimeout(() => {
    inboundLog("sock.ev spy window ended", {
      clinic_id: clinicId,
      sock_ev_events_observed: sockEvEventsObserved,
      messages_upsert_observed: messagesUpsertObserved,
      recent_count: recentSockEvEvents.length,
    });
  }, windowMs + 50);
}

/** In-memory short-term dedupe (Laravel unique constraint is source of truth). */
const recentIds = new Map();
const DEDUPE_TTL_MS = 5 * 60 * 1000;
const DEDUPE_MAX = 5000;

function rememberId(clinicId, messageId) {
  const key = `${clinicId}:${messageId}`;
  const now = Date.now();
  recentIds.set(key, now);
  if (recentIds.size > DEDUPE_MAX) {
    for (const [k, ts] of recentIds) {
      if (now - ts > DEDUPE_TTL_MS) recentIds.delete(k);
      if (recentIds.size <= DEDUPE_MAX * 0.8) break;
    }
  }
}

function seenRecently(clinicId, messageId) {
  const key = `${clinicId}:${messageId}`;
  const ts = recentIds.get(key);
  if (!ts) return false;
  if (Date.now() - ts > DEDUPE_TTL_MS) {
    recentIds.delete(key);
    return false;
  }
  return true;
}

function normalizeJid(jid) {
  if (!jid || typeof jid !== "string") return "";
  const trimmed = jid.trim();
  if (!trimmed.includes("@")) return trimmed;
  const [userPart, server] = trimmed.split("@");
  const user = String(userPart).split(":")[0];
  return `${user}@${server}`;
}

function isSupportedChatJid(jid) {
  const lower = String(jid || "").toLowerCase();
  if (!lower) return false;
  if (lower.endsWith("@g.us")) return false;
  if (lower.includes("status@broadcast") || lower.endsWith("@broadcast")) return false;
  if (lower.endsWith("@newsletter")) return false;
  return lower.endsWith("@s.whatsapp.net") || lower.endsWith("@lid");
}

function isLidJid(jid) {
  return String(jid || "").toLowerCase().endsWith("@lid");
}

function isPhoneJid(jid) {
  return String(jid || "").toLowerCase().endsWith("@s.whatsapp.net");
}

/**
 * Collect every possible phone/LID candidate from a Baileys message key.
 */
function collectIdentityCandidates(msg) {
  const key = msg?.key || {};
  const values = [
    key.remoteJid,
    key.remoteJidAlt,
    key.participant,
    key.participantAlt,
    key.senderPn,
    key.sender_pn,
    msg?.senderPn,
    msg?.remoteJidAlt,
    msg?.participant,
    msg?.participantAlt,
    msg?.author,
    msg?.pushNameSender || null,
  ];
  /** @type {string[]} */
  const out = [];
  for (const v of values) {
    const n = normalizeJid(v ? String(v) : "");
    if (n) out.push(n);
  }
  return out;
}

/**
 * Ask Baileys LID mapping store for the phone JID when remoteJid is @lid.
 * @param {import('@whiskeysockets/baileys').WASocket|null|undefined} sock
 * @param {string} lidJid
 */
async function resolvePhoneJidFromLid(sock, lidJid) {
  if (!sock || !isLidJid(lidJid)) return null;
  try {
    const mapping = sock.signalRepository?.lidMapping;
    if (!mapping) return null;
    if (typeof mapping.getPNForLID === "function") {
      const pn = await mapping.getPNForLID(lidJid);
      const normalized = normalizeJid(pn ? String(pn) : "");
      return isPhoneJid(normalized) ? normalized : null;
    }
    if (typeof mapping.getPNForLIDSync === "function") {
      const pn = mapping.getPNForLIDSync(lidJid);
      const normalized = normalizeJid(pn ? String(pn) : "");
      return isPhoneJid(normalized) ? normalized : null;
    }
  } catch (err) {
    inboundLog("LID→PN mapping failed", {
      lid: lidJid,
      error: err?.message || String(err),
    });
  }
  return null;
}

/**
 * Unwrap common Baileys message wrappers.
 * @param {object|null|undefined} message
 */
function unwrapMessage(message) {
  if (!message || typeof message !== "object") return null;
  if (message.ephemeralMessage?.message) {
    return unwrapMessage(message.ephemeralMessage.message);
  }
  if (message.viewOnceMessage?.message) {
    return unwrapMessage(message.viewOnceMessage.message);
  }
  if (message.viewOnceMessageV2?.message) {
    return unwrapMessage(message.viewOnceMessageV2.message);
  }
  if (message.viewOnceMessageV2Extension?.message) {
    return unwrapMessage(message.viewOnceMessageV2Extension.message);
  }
  if (message.documentWithCaptionMessage?.message) {
    return unwrapMessage(message.documentWithCaptionMessage.message);
  }
  if (message.editedMessage?.message) {
    return unwrapMessage(message.editedMessage.message);
  }
  if (message.deviceSentMessage?.message) {
    return unwrapMessage(message.deviceSentMessage.message);
  }
  return message;
}

/**
 * @param {object} inner
 * @returns {{ message_type: string, text: string|null, caption: string|null, media: object|null, quoted_message_id: string|null }}
 */
function classifyMessage(inner) {
  if (!inner) {
    return {
      message_type: "unknown",
      text: null,
      caption: null,
      media: null,
      quoted_message_id: null,
    };
  }

  const contextInfo =
    inner.extendedTextMessage?.contextInfo ||
    inner.imageMessage?.contextInfo ||
    inner.videoMessage?.contextInfo ||
    inner.audioMessage?.contextInfo ||
    inner.documentMessage?.contextInfo ||
    inner.stickerMessage?.contextInfo ||
    null;
  const quotedMessageId = contextInfo?.stanzaId || null;

  if (inner.conversation) {
    return {
      message_type: "text",
      text: String(inner.conversation),
      caption: null,
      media: null,
      quoted_message_id: quotedMessageId,
    };
  }

  if (inner.extendedTextMessage?.text != null) {
    return {
      message_type: "text",
      text: String(inner.extendedTextMessage.text),
      caption: null,
      media: null,
      quoted_message_id: quotedMessageId,
    };
  }

  if (inner.imageMessage) {
    const m = inner.imageMessage;
    return {
      message_type: "image",
      text: null,
      caption: m.caption ? String(m.caption) : null,
      media: mediaMetaFromProto(m),
      quoted_message_id: quotedMessageId,
    };
  }

  if (inner.videoMessage) {
    const m = inner.videoMessage;
    return {
      message_type: "video",
      text: null,
      caption: m.caption ? String(m.caption) : null,
      media: mediaMetaFromProto(m),
      quoted_message_id: quotedMessageId,
    };
  }

  if (inner.audioMessage) {
    return {
      message_type: "audio",
      text: null,
      caption: null,
      media: mediaMetaFromProto(inner.audioMessage),
      quoted_message_id: quotedMessageId,
    };
  }

  if (inner.documentMessage) {
    const m = inner.documentMessage;
    return {
      message_type: "document",
      text: null,
      caption: m.caption ? String(m.caption) : null,
      media: {
        ...mediaMetaFromProto(m),
        filename: m.fileName || m.title || null,
      },
      quoted_message_id: quotedMessageId,
    };
  }

  if (inner.stickerMessage) {
    return {
      message_type: "sticker",
      text: null,
      caption: null,
      media: mediaMetaFromProto(inner.stickerMessage),
      quoted_message_id: quotedMessageId,
    };
  }

  if (inner.locationMessage || inner.liveLocationMessage) {
    return {
      message_type: "location",
      text: null,
      caption: null,
      media: null,
      quoted_message_id: quotedMessageId,
    };
  }

  if (inner.contactMessage || inner.contactsArrayMessage) {
    return {
      message_type: inner.contactsArrayMessage ? "contacts" : "contact",
      text: null,
      caption: null,
      media: null,
      quoted_message_id: quotedMessageId,
    };
  }

  if (inner.reactionMessage) {
    return {
      message_type: "reaction",
      text: inner.reactionMessage.text ? String(inner.reactionMessage.text) : null,
      caption: null,
      media: null,
      quoted_message_id: inner.reactionMessage.key?.id || quotedMessageId,
    };
  }

  // Protocol / stubs / edits without body — only when no real content keys exist.
  // Baileys often attaches messageContextInfo alongside conversation/media; that must not drop the message.
  const hasUserContent = Boolean(
    inner.conversation ||
      inner.extendedTextMessage ||
      inner.imageMessage ||
      inner.videoMessage ||
      inner.audioMessage ||
      inner.documentMessage ||
      inner.stickerMessage ||
      inner.locationMessage ||
      inner.liveLocationMessage ||
      inner.contactMessage ||
      inner.contactsArrayMessage ||
      inner.reactionMessage ||
      inner.buttonsResponseMessage ||
      inner.templateButtonReplyMessage ||
      inner.listResponseMessage ||
      inner.interactiveResponseMessage,
  );
  if (
    !hasUserContent &&
    (inner.protocolMessage ||
      inner.senderKeyDistributionMessage ||
      inner.messageContextInfo ||
      Object.keys(inner).length === 0)
  ) {
    return {
      message_type: "system",
      text: null,
      caption: null,
      media: null,
      quoted_message_id: null,
    };
  }

  return {
    message_type: "unknown",
    text: null,
    caption: null,
    media: null,
    quoted_message_id: quotedMessageId,
  };
}

function mediaMetaFromProto(m) {
  if (!m || typeof m !== "object") return null;
  return {
    mime_type: m.mimetype || null,
    filename: m.fileName || null,
    size_bytes: m.fileLength != null ? Number(m.fileLength) : null,
    sha256: bufferToHex(m.fileSha256),
    file_enc_sha256: bufferToHex(m.fileEncSha256),
    direct_path: m.directPath || null,
    media_key: bufferToBase64(m.mediaKey),
    height: m.height != null ? Number(m.height) : null,
    width: m.width != null ? Number(m.width) : null,
    seconds: m.seconds != null ? Number(m.seconds) : null,
  };
}

function bufferToHex(value) {
  if (!value) return null;
  try {
    if (Buffer.isBuffer(value)) return value.toString("hex");
    if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
    if (typeof value === "string") return value;
  } catch {
    /* ignore */
  }
  return null;
}

function bufferToBase64(value) {
  if (!value) return null;
  try {
    if (Buffer.isBuffer(value)) return value.toString("base64");
    if (value instanceof Uint8Array) return Buffer.from(value).toString("base64");
    if (typeof value === "string") return value;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * Structured pipeline stages for Laravel Super Admin diagnostics.
 * @param {object} msg
 * @param {object} payload
 * @param {Awaited<ReturnType<typeof downloadInboundMedia>>|null} download
 * @param {{ normalized_at?: string, download_started_at?: string }} timings
 */
function buildGatewayPipelineStages(msg, payload, download, timings = {}) {
  const at = new Date().toISOString();
  const messageType = String(payload?.message_type || "");
  const isMedia = DOWNLOADABLE_MEDIA_TYPES.has(messageType);
  const stages = [];

  stages.push({
    key: "baileys_received",
    ok: true,
    at: timings.received_at || at,
    detail: `messages.upsert message_id=${payload?.message_id || msg?.key?.id || "?"}`,
    elapsed_ms: 0,
  });

  stages.push({
    key: "message_normalized",
    ok: Boolean(payload?.message_id && payload?.remote_jid),
    at: timings.normalized_at || at,
    detail: `type=${messageType || "unknown"}`,
    elapsed_ms: timings.normalize_ms ?? null,
  });

  stages.push({
    key: "media_detected",
    ok: isMedia,
    at,
    detail: isMedia ? "yes" : "no",
  });

  stages.push({
    key: "media_type",
    ok: true,
    at,
    detail: messageType || "—",
  });

  if (isMedia) {
    stages.push({
      key: "media_download_started",
      ok: true,
      at: timings.download_started_at || at,
      detail: "downloadMediaMessage invoked",
      elapsed_ms: timings.download_start_ms ?? null,
    });

    const dlOk = download?.ok === true;
    stages.push({
      key: "media_download_completed",
      ok: dlOk,
      at,
      detail: dlOk
        ? "Download OK"
        : String(download?.error || download?.status || "download_failed"),
      elapsed_ms: download?.elapsed_ms ?? null,
      retry_count: download?.attempts ?? null,
      file: dlOk ? null : "media-download.js",
      line: dlOk ? null : 138,
      error: dlOk ? null : String(download?.error || "download_failed"),
      exception: dlOk
        ? null
        : {
            class: "MediaDownloadError",
            message: String(download?.error || "download_failed"),
            summary: String(download?.error || "download_failed"),
            file: "media-download.js",
            line: 138,
          },
    });

    stages.push({
      key: "buffer_size",
      ok: dlOk && (download?.size_bytes ?? 0) > 0,
      at,
      detail: dlOk && download?.size_bytes ? `${download.size_bytes} bytes` : "—",
      buffer_size: download?.size_bytes ?? null,
    });

    stages.push({
      key: "mime_type",
      ok: Boolean(download?.mime_type || payload?.media?.mime_type),
      at,
      detail: String(download?.mime_type || payload?.media?.mime_type || "—"),
      mime_type: download?.mime_type || payload?.media?.mime_type || null,
    });
  }

  return stages;
}

function toUnixSeconds(ts) {
  if (ts == null) return Math.floor(Date.now() / 1000);
  const n = typeof ts === "object" && ts.toNumber ? ts.toNumber() : Number(ts);
  if (!Number.isFinite(n) || n <= 0) return Math.floor(Date.now() / 1000);
  if (n > 9_999_999_999) return Math.floor(n / 1000);
  return Math.floor(n);
}

/**
 * @param {number} clinicId
 * @param {import('@whiskeysockets/baileys').WAMessage} msg
 * @param {string} upsertType
 * @param {{ phone_jid_from_lid?: string|null, profile_picture_url?: string|null, profile_picture_unavailable?: boolean }} [opts]
 * @returns {object|null}
 */
export function buildInboundPayload(clinicId, msg, upsertType, opts = {}) {
  const key = msg?.key || {};
  const candidates = collectIdentityCandidates(msg);
  const rawRemoteJid = normalizeJid(key.remoteJid || "");
  let phoneJid = null;
  let lidJid = null;
  for (const c of candidates) {
    if (!phoneJid && isPhoneJid(c)) phoneJid = c;
    if (!lidJid && isLidJid(c)) lidJid = c;
  }
  if (!phoneJid && opts.phone_jid_from_lid && isPhoneJid(opts.phone_jid_from_lid)) {
    phoneJid = normalizeJid(String(opts.phone_jid_from_lid));
  }
  if (!lidJid && isLidJid(rawRemoteJid)) {
    lidJid = rawRemoteJid;
  }

  // Canonical primary identity: phone JID when known — never prefer @lid.
  const remoteJid = phoneJid || rawRemoteJid;
  const remoteJidAlt = phoneJid && lidJid ? phoneJid : normalizeJid(
    key.remoteJidAlt || key.participantAlt || msg?.remoteJidAlt || "",
  );
  const messageId = key.id ? String(key.id) : "";

  if (!messageId) {
    logger.info(
      { clinic_id: clinicId, remote_jid: remoteJid || null },
      "whatsapp.inbound.dropped_missing_message_id",
    );
    return null;
  }
  if (!remoteJid || !isSupportedChatJid(remoteJid)) {
    logger.info(
      {
        clinic_id: clinicId,
        message_id: messageId,
        remote_jid: remoteJid || null,
        remote_jid_alt: remoteJidAlt || null,
        candidates,
      },
      "whatsapp.inbound.dropped_unsupported_jid",
    );
    return null;
  }

  const fromMe = Boolean(key.fromMe);
  const classified = normalizeIncomingMessage(msg.message);

  if (classified.message_type === "system") {
    logger.info(
      {
        clinic_id: clinicId,
        message_id: messageId,
        remote_jid: remoteJid,
        from_me: fromMe,
      },
      "whatsapp.inbound.dropped_system_stub",
    );
    return null;
  }

  const remotePhoneDigits = phoneJid
    ? String(phoneJid).split("@")[0].replace(/\D/g, "") || null
    : isPhoneJid(remoteJid)
      ? String(remoteJid).split("@")[0].replace(/\D/g, "") || null
      : null;

  const displayText =
    classified.display_text || classified.text || classified.caption || null;
  const bodyText = classified.text || classified.caption || null;
  const rawMessage = serializeMessageForWebhook(msg.message);

  // When text is missing for a text/unknown message, keep raw proto for Laravel recovery.
  if (!bodyText && (classified.message_type === "text" || classified.message_type === "unknown")) {
    logger.warn(
      {
        clinic_id: clinicId,
        message_id: messageId,
        message_type: classified.message_type,
        message_keys: msg.message && typeof msg.message === "object"
          ? Object.keys(msg.message).slice(0, 40)
          : [],
        raw_message: rawMessage,
      },
      "whatsapp.inbound.empty_text_payload",
    );
  }

  return {
    event: "inbound_message",
    clinic_id: Number(clinicId),
    session_id: String(clinicId),
    // Primary identity for Laravel — phone@s.whatsapp.net whenever available
    remote_jid: remoteJid,
    remote_jid_raw: rawRemoteJid || null,
    remote_jid_alt: remoteJidAlt || phoneJid || null,
    phone_jid: phoneJid || (isPhoneJid(remoteJid) ? remoteJid : null),
    remote_phone: remotePhoneDigits,
    remote_lid: lidJid ? String(lidJid).split("@")[0].replace(/\D/g, "") || null : null,
    remote_lid_jid: lidJid || null,
    participant: key.participant ? normalizeJid(String(key.participant)) : null,
    message_id: messageId,
    timestamp: toUnixSeconds(msg.messageTimestamp),
    from_me: fromMe,
    message_type: classified.message_type,
    text: classified.text,
    caption: classified.caption,
    display_text: displayText,
    body: bodyText,
    media: classified.media,
    quoted_message_id: classified.quoted_message_id,
    // Laravel fallback: re-parse if top-level text was dropped
    raw_message: rawMessage,
    message: rawMessage,
    push_name: msg.pushName || null,
    profile_picture_url: opts.profile_picture_url ?? null,
    profile_picture_unavailable: Boolean(opts.profile_picture_unavailable),
    sender_jid: fromMe ? null : remoteJid,
    recipient_jid: fromMe ? remoteJid : null,
    upsert_type: upsertType || "notify",
    session_phone: null,
    identity_candidates: candidates,
  };
}

/**
 * Map Baileys messages.update receipt statuses.
 * @param {number} clinicId
 * @param {object} update
 * @returns {object|null}
 */
export function buildStatusPayload(clinicId, update) {
  const key = update?.key || {};
  const messageId = key.id ? String(key.id) : "";
  if (!messageId) return null;

  // Delivery ticks are for outbound messages we sent.
  if (key.fromMe === false) return null;

  let status = null;
  if (update.update?.status != null) {
    const code = Number(update.update.status);
    // Baileys WAMessageStatus: ERROR=0, PENDING=1, SERVER_ACK=2, DELIVERY_ACK=3, READ=4, PLAYED=5
    const map = {
      0: "failed",
      1: "pending",
      2: "sent",
      3: "delivered",
      4: "read",
      5: "read",
    };
    status = map[code] || null;
  }

  if (!status) return null;

  const statusAt =
    update.update?.messageTimestamp != null
      ? Number(update.update.messageTimestamp)
      : Math.floor(Date.now() / 1000);

  return {
    event: "message_status",
    clinic_id: Number(clinicId),
    session_id: String(clinicId),
    message_id: messageId,
    remote_jid: key.remoteJid ? normalizeJid(String(key.remoteJid)) : null,
    status,
    status_at: statusAt,
    from_me: key.fromMe !== false,
  };
}

async function postToLaravel(payload, attempt = 1) {
  const url = String(process.env.LARAVEL_WEBHOOK_URL || "").trim();
  // FIRST HARD STOP: empty env → Laravel never receives anything.
  if (!url) {
    lastInboundPostError = "webhook_url_missing";
    inboundError("LARAVEL_WEBHOOK_URL empty — POST skipped", {
      clinic_id: payload.clinic_id,
      event: payload.event,
      message_id: payload.message_id,
      file: "inbound.js",
      function: "postToLaravel",
      line: 437,
    });
    return { ok: false, reason: "webhook_url_missing" };
  }

  const webhookToken = String(process.env.WEBHOOK_TOKEN || "").trim();
  const gatewayToken = String(process.env.GATEWAY_TOKEN || "").trim();
  const token = webhookToken || gatewayToken;
  const tokenSource = webhookToken ? "WEBHOOK_TOKEN" : gatewayToken ? "GATEWAY_TOKEN" : "none";

  const headers = {
    Accept: "application/json",
  };
  if (token) {
    headers["X-Webhook-Token"] = token;
    headers["X-Gateway-Token"] = token;
  }

  inboundLog("Posting to Laravel", {
    clinic_id: payload.clinic_id,
    event: payload.event,
    message_id: payload.message_id,
    attempt,
  });
  inboundLog("POST URL", { url, method: "POST" });
  inboundLog("POST headers", {
    content_type: "auto",
    accept: headers.Accept,
    x_webhook_token: token ? "[set]" : "[missing]",
    x_gateway_token: token ? "[set]" : "[missing]",
    token_source: tokenSource,
  });

  const controller = new AbortController();
  const mediaBuffer = payload?._mediaBuffer && Buffer.isBuffer(payload._mediaBuffer)
    ? payload._mediaBuffer
    : null;
  const hasMediaBinary = Boolean(mediaBuffer) || Boolean(payload?.media_base64);
  const timeoutMs = hasMediaBinary ? 90_000 : 15_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  // TEMP runtime probe (inbound image multipart) — do not change behavior.
  const isBuffer = Buffer.isBuffer(payload?._mediaBuffer);
  const bufferLength =
    payload?._mediaBuffer && typeof payload._mediaBuffer.length === "number"
      ? payload._mediaBuffer.length
      : null;
  inboundLog("TEMP media POST probe — buffer", {
    message_id: payload.message_id || null,
    message_type: payload.message_type || null,
    "Buffer.isBuffer(payload._mediaBuffer)": isBuffer,
    "payload._mediaBuffer?.length": bufferLength,
    branch_will_be: mediaBuffer ? "FormData" : "JSON",
  });

  try {
    /** @type {BodyInit} */
    let body;
    /** @type {"FormData"|"JSON"} */
    let bodyBranch;
    if (mediaBuffer) {
      // Multipart: raw downloaded buffer — do not re-encode to base64.
      const meta = { ...payload };
      delete meta._mediaBuffer;
      delete meta.media_base64;
      const form = new FormData();
      form.append("payload_json", JSON.stringify(meta));
      const mime =
        (payload.media && payload.media.mime_type) ||
        "application/octet-stream";
      const filename =
        (payload.media && payload.media.filename) ||
        `${payload.message_type || "media"}_${payload.message_id || "bin"}`;
      const mediaBlob = new Blob([new Uint8Array(mediaBuffer)], { type: mime });
      form.append(
        "media_file",
        mediaBlob,
        String(filename),
      );
      body = form;
      bodyBranch = "FormData";
      // Let fetch set multipart boundary Content-Type.
      inboundLog("TEMP media POST probe — FormData", {
        message_id: payload.message_id || null,
        branch: "FormData",
        media_file_appended: true,
        blob_size: mediaBlob.size,
        filename: String(filename),
        mime: String(mime),
      });
    } else {
      headers["Content-Type"] = "application/json; charset=utf-8";
      const meta = { ...payload };
      delete meta._mediaBuffer;
      body = JSON.stringify(meta);
      bodyBranch = "JSON";
      inboundLog("TEMP media POST probe — JSON", {
        message_id: payload.message_id || null,
        branch: "JSON",
        media_file_appended: false,
        reason: "_mediaBuffer missing or not a Buffer",
      });
    }

    let outgoingContentType = headers["Content-Type"] || null;
    try {
      const probe = new Request(url, { method: "POST", headers, body });
      outgoingContentType = probe.headers.get("content-type") || outgoingContentType;
    } catch {
      /* probe optional */
    }
    inboundLog("TEMP media POST probe — outgoing Content-Type", {
      message_id: payload.message_id || null,
      branch: bodyBranch,
      "Content-Type": outgoingContentType,
    });

    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    const durationMs = Date.now() - started;
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    lastInboundPostAt = new Date().toISOString();
    lastInboundPostStatus = res.status;

    const action = json?.data?.action || json?.action || null;
    const laravelSuccess = json?.success === true;
    const storedActions = new Set([
      "message_stored",
      "thread_created_message_stored",
      "outbound_mirrored",
      "thread_created_outbound_mirrored",
      "duplicate_ignored",
      "status_updated",
      "status_noop",
      "ignored",
    ]);

    inboundLog("Response status", {
      status: res.status,
      duration_ms: durationMs,
      attempt,
      message_id: payload.message_id,
    });
    inboundLog("Response body", {
      body: String(text || "").slice(0, 800),
      laravel_success: laravelSuccess,
      action,
    });

    if (!res.ok) {
      lastInboundPostError = `http_${res.status}`;
      inboundError("HTTP error from Laravel", {
        status: res.status,
        body: text?.slice(0, 500),
        auth_header_sent: Boolean(token),
        token_source: tokenSource,
      });
      if (attempt < 3 && (res.status === 403 || res.status === 401 || res.status >= 500)) {
        await new Promise((r) => setTimeout(r, attempt * 750));
        return postToLaravel(payload, attempt + 1);
      }
      return { ok: false, reason: "http_error", status: res.status, duration_ms: durationMs };
    }

    if (payload.event === "inbound_message") {
      if (!laravelSuccess || !action || !storedActions.has(String(action))) {
        lastInboundPostError = "not_ingested";
        inboundError("Laravel HTTP 200 but message not ingested", {
          laravel_success: laravelSuccess,
          action,
          body: text?.slice(0, 500),
          url,
        });
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, attempt * 750));
          return postToLaravel(payload, attempt + 1);
        }
        return {
          ok: false,
          reason: "not_ingested",
          status: res.status,
          action,
          duration_ms: durationMs,
        };
      }
    }

    lastInboundPostError = null;
    inboundLog("POST success", {
      status: res.status,
      action,
      message_id: payload.message_id,
      duration_ms: durationMs,
    });
    return { ok: true, json, status: res.status, duration_ms: durationMs, action };
  } catch (err) {
    const durationMs = Date.now() - started;
    lastInboundPostError = err?.message || String(err);
    inboundError("Exception", {
      error: err?.message || String(err),
      name: err?.name || null,
      stack: err?.stack ? String(err.stack).slice(0, 1200) : null,
      duration_ms: durationMs,
      attempt,
      url,
      message_id: payload.message_id,
    });
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, attempt * 750));
      return postToLaravel(payload, attempt + 1);
    }
    return { ok: false, reason: "network_error", duration_ms: durationMs };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Register Baileys inbound listeners on a live socket.
 * Idempotent per socket instance.
 * @param {number} clinicId
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 */
export function attachInboundListeners(clinicId, sock) {
  if (!sock?.ev) {
    inboundError("listeners_attach_failed_no_ev", {
      clinic_id: clinicId,
      file: "inbound.js",
      function: "attachInboundListeners",
    });
    return { attached: false, reason: "no_ev" };
  }

  if (inboundAttachedSocks.has(sock)) {
    const counts = countListeners(sock);
    lastListenerCounts = counts.counts;
    lastEventNamesAtAttach = counts.event_names;
    lastUpsertListenerCount = counts.upsert;
    inboundLog("Listeners already attached on this socket — skip", {
      clinic_id: clinicId,
      upsert_listener_count: counts.upsert,
      event_names: counts.event_names,
      listener_counts: counts.counts,
    });
    return { attached: false, reason: "already_attached", ...counts };
  }
  inboundAttachedSocks.add(sock);
  inboundAttachCount += 1;
  lastAttachAt = new Date().toISOString();
  lastAttachClinicId = clinicId;

  const cfg = getInboundWebhookConfig();
  inboundLog("Registering messages.upsert listener", {
    clinic_id: clinicId,
    attach_count: inboundAttachCount,
    webhook_url_configured: cfg.webhook_url_configured,
    webhook_url: cfg.webhook_url,
    token_source: cfg.token_source,
  });
  if (!cfg.webhook_url_configured) {
    inboundError("LARAVEL_WEBHOOK_URL is empty at attach time — inbound POST will never run", {
      clinic_id: clinicId,
      file: "inbound.js",
      function: "attachInboundListeners",
      first_failing_line: "postToLaravel: empty LARAVEL_WEBHOOK_URL",
    });
  }

  // Spy BEFORE registering so we also see our own attach-window traffic.
  spySockEvForWindow(clinicId, sock, 30_000);

  sock.ev.on("messages.upsert", async (upsert) => {
    try {
      lastInboundEventAt = new Date().toISOString();
      messagesUpsertObserved += 1;
      const type = upsert?.type || "notify";
      const messages = Array.isArray(upsert?.messages) ? upsert.messages : [];
      const first = messages[0];
      inboundLog("messages.upsert fired", {
        clinic_id: clinicId,
        upsert_type: type,
        message_count: messages.length,
        message_id: first?.key?.id || null,
        remote_jid: first?.key?.remoteJid || null,
        from_me: first?.key?.fromMe ?? null,
      });

      if (type !== "notify" && type !== "append") {
        inboundLog("Early return — upsert type skipped", {
          clinic_id: clinicId,
          upsert_type: type,
          file: "inbound.js",
          function: "messages.upsert handler",
        });
        return;
      }

      inboundLog("Message received", {
        clinic_id: clinicId,
        upsert_type: type,
        message_count: messages.length,
      });

      for (const msg of messages) {
        let phoneFromLid = null;
        const rawJid = normalizeJid(msg?.key?.remoteJid || "");
        if (isLidJid(rawJid)) {
          phoneFromLid = await resolvePhoneJidFromLid(sock, rawJid);
          if (phoneFromLid) {
            inboundLog("Resolved LID to phone JID", {
              clinic_id: clinicId,
              lid: rawJid,
              phone_jid: phoneFromLid,
            });
          }
        }
        const receivedAt = new Date().toISOString();
        const normalizeStarted = Date.now();
        const payload = buildInboundPayload(clinicId, msg, type, {
          phone_jid_from_lid: phoneFromLid,
        });
        const normalizeMs = Date.now() - normalizeStarted;
        if (!payload) {
          inboundLog("Early return — payload builder returned null", {
            clinic_id: clinicId,
            remote_jid: msg?.key?.remoteJid || null,
            message_id: msg?.key?.id || null,
            from_me: msg?.key?.fromMe ?? null,
            file: "inbound.js",
            function: "buildInboundPayload",
          });
          continue;
        }

        // Download media bytes (image/video/audio/document/sticker) before POST.
        let download = null;
        const downloadStartedAt = new Date().toISOString();
        const shouldDownload = DOWNLOADABLE_MEDIA_TYPES.has(String(payload.message_type || ""));

        // TEMP probe — immediately before downloadInboundMedia() is called (or skipped)
        gatewayMediaTrace(
          "before_downloadInboundMedia",
          buildGatewayMediaTraceFields({
            message_type: payload.message_type,
            should_download: shouldDownload,
            download_called: false,
            download: null,
            payload,
            message_id: payload.message_id,
          }),
        );

        if (shouldDownload) {
          inboundLog("Media download start", {
            clinic_id: clinicId,
            message_id: payload.message_id,
            message_type: payload.message_type,
          });
          download = await downloadInboundMedia(sock, msg, payload.message_type);

          // TEMP probe — immediately before attachDownloadedMediaToPayload
          gatewayMediaTrace(
            "before_attachDownloadedMediaToPayload",
            buildGatewayMediaTraceFields({
              message_type: payload.message_type,
              should_download: true,
              download_called: true,
              download,
              payload,
              message_id: payload.message_id,
            }),
          );

          attachDownloadedMediaToPayload(payload, download);

          // TEMP probe — immediately after attachDownloadedMediaToPayload
          gatewayMediaTrace(
            "after_attachDownloadedMediaToPayload",
            buildGatewayMediaTraceFields({
              message_type: payload.message_type,
              should_download: true,
              download_called: true,
              download,
              payload,
              message_id: payload.message_id,
            }),
          );

          inboundLog("Media download result", {
            clinic_id: clinicId,
            message_id: payload.message_id,
            message_type: payload.message_type,
            status: download.status,
            size_bytes: download.size_bytes || null,
            error: download.error || null,
            attempts: download.attempts ?? null,
            elapsed_ms: download.elapsed_ms ?? null,
            has_base64: Boolean(payload.media_base64),
            has_media_buffer: Boolean(payload._mediaBuffer),
          });
        }

        payload._pipeline_stages = buildGatewayPipelineStages(msg, payload, download, {
          received_at: receivedAt,
          normalized_at: new Date().toISOString(),
          normalize_ms: normalizeMs,
          download_started_at: downloadStartedAt,
        });

        // Best-effort profile photo (cached); never block / fail inbound on privacy errors.
        try {
          const pic = await resolveProfilePictureUrlCandidates(
            sock,
            [payload.phone_jid, payload.remote_jid, payload.remote_jid_alt, payload.remote_lid_jid],
            { clinicId, force: false },
          );
          payload.profile_picture_url = pic.url;
          payload.profile_photo_url = pic.url;
          payload.profile_picture_unavailable = Boolean(pic.unavailable);
          payload.profile_photo_unavailable = Boolean(pic.unavailable);
          inboundLog("Profile picture resolve", {
            clinic_id: clinicId,
            message_id: payload.message_id,
            jid_tried: payload.phone_jid || payload.remote_jid,
            url: pic.url ? String(pic.url).slice(0, 120) : null,
            unavailable: pic.unavailable,
            from_cache: pic.from_cache,
            reason: pic.reason || null,
            file: "inbound.js",
            function: "resolveProfilePictureUrlCandidates",
          });
        } catch (picErr) {
          payload.profile_picture_url = null;
          payload.profile_picture_unavailable = false; // allow Laravel/Admin soft retry
          inboundLog("Profile picture resolve failed", {
            clinic_id: clinicId,
            message_id: payload.message_id,
            error: String(picErr?.message || picErr || "unknown"),
            file: "inbound.js",
            function: "resolveProfilePictureUrlCandidates",
          });
        }

        if (seenRecently(clinicId, payload.message_id)) {
          inboundLog("Early return — local dedupe", {
            clinic_id: clinicId,
            message_id: payload.message_id,
            file: "inbound.js",
            function: "seenRecently",
          });
          continue;
        }

        inboundLog("Payload built — calling postToLaravel", {
          clinic_id: clinicId,
          message_id: payload.message_id,
          remote_jid: payload.remote_jid,
          message_type: payload.message_type,
          from_me: payload.from_me,
          text_len: payload.text ? String(payload.text).length : 0,
          text_preview: payload.text
            ? String(payload.text).slice(0, 80)
            : payload.caption
              ? String(payload.caption).slice(0, 80)
              : null,
          has_arabic: /[\u0600-\u06FF]/.test(String(payload.text || payload.caption || "")),
          media_status: payload.media_status || null,
          media_download_status: payload.media_download_status || null,
          has_media_base64: Boolean(payload.media_base64),
          has_media_buffer: Boolean(payload._mediaBuffer),
          media_buffer_bytes: payload._mediaBuffer?.length || null,
        });

        // TEMP probe — immediately before postToLaravel
        gatewayMediaTrace(
          "before_postToLaravel",
          buildGatewayMediaTraceFields({
            message_type: payload.message_type,
            should_download: shouldDownload,
            download_called: shouldDownload,
            download,
            payload,
            message_id: payload.message_id,
          }),
        );

        const postResult = await postToLaravel(payload);
        if (postResult?.ok) {
          rememberId(clinicId, payload.message_id);
          inboundLog("Stored / acknowledged by Laravel", {
            clinic_id: clinicId,
            message_id: payload.message_id,
            status: postResult.status || 200,
            action: postResult.action || null,
          });
        } else {
          inboundError("POST failed — will retry on next upsert only", {
            clinic_id: clinicId,
            message_id: payload.message_id,
            reason: postResult?.reason || "post_failed",
            status: postResult?.status || null,
          });
        }
      }
    } catch (err) {
      inboundError("Exception in messages.upsert handler", {
        clinic_id: clinicId,
        error: err?.message || String(err),
        stack: err?.stack ? String(err.stack).slice(0, 1200) : null,
      });
    }
  });

  sock.ev.on("messages.update", async (updates) => {
    try {
      if (!Array.isArray(updates)) return;
      for (const update of updates) {
        const payload = buildStatusPayload(clinicId, update);
        if (!payload) continue;
        inboundLog("message status receipt", {
          clinic_id: clinicId,
          message_id: payload.message_id,
          status: payload.status,
          from_me: payload.from_me,
        });
        await postToLaravel(payload);
      }
    } catch (err) {
      inboundError("Exception in messages.update handler", {
        clinic_id: clinicId,
        error: err?.message || String(err),
      });
    }
  });

  // Profile picture / contact metadata changes from WhatsApp.
  sock.ev.on("contacts.update", async (updates) => {
    try {
      if (!Array.isArray(updates)) return;
      for (const contact of updates) {
        const jid = normalizeJid(contact?.id || contact?.jid || "");
        if (!jid || !isSupportedChatJid(jid)) continue;
        // Baileys often signals a change with imgUrl === "changed" — always re-fetch.
        const pic = await resolveProfilePictureUrl(sock, jid, {
          clinicId,
          force: true,
        });
        const phoneDigits = isPhoneJid(jid)
          ? String(jid).split("@")[0].replace(/\D/g, "") || null
          : null;
        await postToLaravel({
          event: "profile_picture_update",
          clinic_id: Number(clinicId),
          session_id: String(clinicId),
          remote_jid: jid,
          phone_jid: isPhoneJid(jid) ? jid : null,
          remote_phone: phoneDigits,
          profile_picture_url: pic.url,
          profile_photo_url: pic.url,
          profile_picture_unavailable: pic.unavailable,
          profile_photo_unavailable: pic.unavailable,
          push_name: contact?.notify || contact?.name || null,
          display_name: contact?.name || contact?.notify || null,
        });
      }
    } catch (err) {
      inboundError("Exception in contacts.update handler", {
        clinic_id: clinicId,
        error: err?.message || String(err),
      });
    }
  });

  // After reconnect, Baileys re-emits pending acks via messages.update — no polling.
  inboundLog("receipt listeners ready (reconnect-safe)", {
    clinic_id: clinicId,
    events: ["messages.update", "contacts.update"],
  });

  const counts = countListeners(sock);
  lastListenerCounts = counts.counts;
  lastEventNamesAtAttach = counts.event_names;
  lastUpsertListenerCount = counts.upsert;

  console.log("[INBOUND] Listener attached successfully", {
    clinic_id: clinicId,
    upsert_listener_count: counts.upsert,
    total_event_names: counts.event_names.length,
    event_names: counts.event_names,
    listener_counts: counts.counts,
  });
  inboundLog("Listener attached successfully", {
    clinic_id: clinicId,
    upsert_listener_count: counts.upsert,
    total_listener_count: Object.values(counts.counts).reduce(
      (a, b) => a + (typeof b === "number" ? b : 0),
      0,
    ),
    event_names: counts.event_names,
    listener_counts: counts.counts,
  });
  inboundLog("Listeners attached", {
    clinic_id: clinicId,
    events: ["messages.upsert", "messages.update"],
    upsert_listener_count: counts.upsert,
  });
  return { attached: true, ...counts };
}
