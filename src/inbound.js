/**
 * Baileys inbound → Laravel webhook (Phase 1 Conversations).
 * Does not alter outbound sendMessage pipeline.
 */
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

/** @type {WeakSet<object>} */
const inboundAttachedSocks = new WeakSet();

let inboundAttachCount = 0;
let lastInboundEventAt = null;
let lastInboundPostAt = null;
let lastInboundPostStatus = null;
let lastInboundPostError = null;

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
    last_inbound_event_at: lastInboundEventAt,
    last_inbound_post_at: lastInboundPostAt,
    last_inbound_post_status: lastInboundPostStatus,
    last_inbound_post_error: lastInboundPostError,
  };
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
 * @returns {object|null}
 */
export function buildInboundPayload(clinicId, msg, upsertType) {
  const key = msg?.key || {};
  const remoteJid = normalizeJid(key.remoteJid || "");
  // Baileys often provides phone JID here when remoteJid is @lid
  const remoteJidAlt = normalizeJid(
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
      },
      "whatsapp.inbound.dropped_unsupported_jid",
    );
    return null;
  }

  const fromMe = Boolean(key.fromMe);
  const inner = unwrapMessage(msg.message);
  const classified = classifyMessage(inner);

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

  const phoneJid =
    remoteJidAlt && String(remoteJidAlt).toLowerCase().endsWith("@s.whatsapp.net")
      ? remoteJidAlt
      : null;
  const remotePhoneDigits = phoneJid
    ? String(phoneJid).split("@")[0].replace(/\D/g, "") || null
    : remoteJid.toLowerCase().endsWith("@s.whatsapp.net")
      ? String(remoteJid).split("@")[0].replace(/\D/g, "") || null
      : null;

  return {
    event: "inbound_message",
    clinic_id: Number(clinicId),
    session_id: String(clinicId),
    remote_jid: remoteJid,
    remote_jid_alt: remoteJidAlt || null,
    phone_jid: phoneJid,
    remote_phone: remotePhoneDigits,
    participant: key.participant ? normalizeJid(String(key.participant)) : null,
    message_id: messageId,
    timestamp: toUnixSeconds(msg.messageTimestamp),
    from_me: fromMe,
    message_type: classified.message_type,
    text: classified.text,
    caption: classified.caption,
    media: classified.media,
    quoted_message_id: classified.quoted_message_id,
    push_name: msg.pushName || null,
    sender_jid: fromMe ? null : remoteJid,
    recipient_jid: fromMe ? remoteJid : null,
    upsert_type: upsertType || "notify",
    session_phone: null,
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

  return {
    event: "message_status",
    clinic_id: Number(clinicId),
    session_id: String(clinicId),
    message_id: messageId,
    remote_jid: key.remoteJid ? normalizeJid(String(key.remoteJid)) : null,
    status,
    from_me: Boolean(key.fromMe),
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
    "Content-Type": "application/json",
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
    content_type: headers["Content-Type"],
    accept: headers.Accept,
    x_webhook_token: token ? "[set]" : "[missing]",
    x_gateway_token: token ? "[set]" : "[missing]",
    token_source: tokenSource,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const started = Date.now();

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
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
    return;
  }

  if (inboundAttachedSocks.has(sock)) {
    inboundLog("Listeners already attached on this socket — skip", { clinic_id: clinicId });
    return;
  }
  inboundAttachedSocks.add(sock);
  inboundAttachCount += 1;

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

  sock.ev.on("messages.upsert", async (upsert) => {
    try {
      lastInboundEventAt = new Date().toISOString();
      const type = upsert?.type || "notify";
      const messages = Array.isArray(upsert?.messages) ? upsert.messages : [];
      inboundLog("messages.upsert fired", {
        clinic_id: clinicId,
        upsert_type: type,
        message_count: messages.length,
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
        const payload = buildInboundPayload(clinicId, msg, type);
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
        });

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
        await postToLaravel(payload);
      }
    } catch (err) {
      inboundError("Exception in messages.update handler", {
        clinic_id: clinicId,
        error: err?.message || String(err),
      });
    }
  });

  inboundLog("Listeners attached", {
    clinic_id: clinicId,
    events: ["messages.upsert", "messages.update"],
  });
}
