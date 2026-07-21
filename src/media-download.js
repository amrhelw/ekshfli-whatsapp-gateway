/**
 * Download inbound WhatsApp media via Baileys downloadMediaMessage.
 * Retries once on failure. Never throws — returns structured result.
 */
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

/** Media message types that carry downloadable binary content. */
export const DOWNLOADABLE_MEDIA_TYPES = new Set([
  "image",
  "video",
  "audio",
  "document",
  "sticker",
]);

/** Soft cap before base64 (~20MB raw ≈ 27MB JSON). Oversized → failed placeholder. */
const MAX_BYTES = Number(process.env.WHATSAPP_INBOUND_MEDIA_MAX_BYTES || 20 * 1024 * 1024);

/** TEMP: dual-sink media download probe — do not change behavior. */
export function gatewayMediaTrace(step, fields = {}) {
  const body = { step, ...fields };
  logger.info(body, `[GATEWAY_MEDIA_TRACE] ${step}`);
  try {
    console.log("[GATEWAY_MEDIA_TRACE]", step, JSON.stringify(body));
  } catch {
    console.log("[GATEWAY_MEDIA_TRACE]", step, body);
  }
}

/**
 * TEMP: shared probe payload shape for gateway media download.
 * @param {{
 *   message_type?: string|null,
 *   should_download?: boolean|null,
 *   download_called?: boolean|null,
 *   download?: object|null,
 *   payload?: object|null,
 *   message_id?: string|null,
 *   attempt?: number|null,
 * }} opts
 */
export function buildGatewayMediaTraceFields(opts = {}) {
  const download = opts.download ?? null;
  const payload = opts.payload ?? null;
  return {
    message_id: opts.message_id ?? payload?.message_id ?? null,
    message_type: opts.message_type ?? payload?.message_type ?? null,
    should_download: opts.should_download ?? null,
    download_called: opts.download_called ?? null,
    download_result: {
      ok: download?.ok ?? null,
      status: download?.status ?? null,
      error: download?.error ?? null,
      buffer_exists: !!download?.buffer,
      buffer_is_buffer: Buffer.isBuffer(download?.buffer),
      buffer_length: download?.buffer?.length ?? null,
      mime_type: download?.mime_type ?? null,
      size_bytes: download?.size_bytes ?? null,
    },
    payload_media: payload?.media ?? null,
    payload_has_buffer: !!payload?._mediaBuffer,
    payload_buffer_is_buffer: Buffer.isBuffer(payload?._mediaBuffer),
    payload_buffer_length: payload?._mediaBuffer?.length ?? null,
    ...(opts.attempt != null ? { attempt: opts.attempt } : {}),
  };
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket} sock
 * @param {import('@whiskeysockets/baileys').WAMessage} msg
 * @param {string} messageType
 * @returns {Promise<{
 *   ok: boolean,
 *   status: 'ready'|'failed'|'skipped'|'too_large',
 *   buffer?: Buffer,
 *   mime_type?: string|null,
 *   size_bytes?: number,
 *   error?: string|null,
 *   attempts?: number
 * }>}
 */
export async function downloadInboundMedia(sock, msg, messageType) {
  // TEMP probe — first line inside downloadInboundMedia
  gatewayMediaTrace(
    "downloadInboundMedia:entered",
    buildGatewayMediaTraceFields({
      message_type: messageType,
      should_download: true,
      download_called: true,
      download: null,
      payload: null,
      message_id: msg?.key?.id || null,
    }),
  );

  if (!DOWNLOADABLE_MEDIA_TYPES.has(String(messageType || ""))) {
    return { ok: false, status: "skipped", error: "not_media_type" };
  }
  if (!sock || !msg?.message) {
    return { ok: false, status: "failed", error: "missing_sock_or_message", attempts: 0 };
  }

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const attemptStarted = Date.now();
    try {
      logger.info(
        {
          message_id: msg?.key?.id || null,
          message_type: messageType,
          attempt,
        },
        "whatsapp.inbound.media_download.start",
      );

      // TEMP probe — immediately before downloadMediaMessage
      gatewayMediaTrace(
        "downloadMediaMessage:before",
        buildGatewayMediaTraceFields({
          message_type: messageType,
          should_download: true,
          download_called: true,
          download: null,
          payload: null,
          message_id: msg?.key?.id || null,
          attempt,
        }),
      );

      const buffer = await downloadMediaMessage(
        msg,
        "buffer",
        {},
        {
          logger,
          reuploadRequest: sock.updateMediaMessage
            ? sock.updateMediaMessage.bind(sock)
            : undefined,
        },
      );

      // TEMP probe — immediately after downloadMediaMessage returns
      gatewayMediaTrace(
        "downloadMediaMessage:after",
        buildGatewayMediaTraceFields({
          message_type: messageType,
          should_download: true,
          download_called: true,
          download: {
            ok: Boolean(buffer && Buffer.isBuffer(buffer) && buffer.length > 0),
            status: null,
            error: null,
            buffer,
            mime_type:
              msg.message?.imageMessage?.mimetype ||
              msg.message?.videoMessage?.mimetype ||
              msg.message?.ptvMessage?.mimetype ||
              msg.message?.audioMessage?.mimetype ||
              msg.message?.documentMessage?.mimetype ||
              msg.message?.stickerMessage?.mimetype ||
              null,
            size_bytes: buffer && typeof buffer.length === "number" ? buffer.length : null,
          },
          payload: null,
          message_id: msg?.key?.id || null,
          attempt,
        }),
      );

      if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) {
        lastError = "empty_buffer";
        logger.warn(
          { message_id: msg?.key?.id, attempt, error: lastError },
          "whatsapp.inbound.media_download.empty",
        );
        continue;
      }

      if (buffer.length > MAX_BYTES) {
        logger.warn(
          {
            message_id: msg?.key?.id,
            size_bytes: buffer.length,
            max_bytes: MAX_BYTES,
          },
          "whatsapp.inbound.media_download.too_large",
        );
        return {
          ok: false,
          status: "too_large",
          size_bytes: buffer.length,
          error: `media_too_large:${buffer.length}>${MAX_BYTES}`,
          attempts: attempt,
          elapsed_ms: Date.now() - attemptStarted,
        };
      }

      const mime =
        msg.message?.imageMessage?.mimetype ||
        msg.message?.videoMessage?.mimetype ||
        msg.message?.ptvMessage?.mimetype ||
        msg.message?.audioMessage?.mimetype ||
        msg.message?.documentMessage?.mimetype ||
        msg.message?.stickerMessage?.mimetype ||
        null;

      logger.info(
        {
          message_id: msg?.key?.id,
          message_type: messageType,
          size_bytes: buffer.length,
          mime_type: mime,
          attempt,
        },
        "whatsapp.inbound.media_download.ok",
      );

      return {
        ok: true,
        status: "ready",
        buffer,
        mime_type: mime,
        size_bytes: buffer.length,
        attempts: attempt,
        elapsed_ms: Date.now() - attemptStarted,
      };
    } catch (err) {
      lastError = err?.message || String(err);
      logger.warn(
        {
          message_id: msg?.key?.id,
          message_type: messageType,
          attempt,
          error: lastError,
          stack: err?.stack ? String(err.stack).slice(0, 800) : null,
        },
        "whatsapp.inbound.media_download.failed",
      );
      gatewayMediaTrace(
        "downloadMediaMessage:exception",
        buildGatewayMediaTraceFields({
          message_type: messageType,
          should_download: true,
          download_called: true,
          download: {
            ok: false,
            status: "failed",
            error: lastError,
            buffer: null,
            mime_type: null,
            size_bytes: null,
          },
          payload: null,
          message_id: msg?.key?.id || null,
          attempt,
        }),
      );
    }
  }

  return {
    ok: false,
    status: "failed",
    error: lastError || "download_failed",
    attempts: 2,
    elapsed_ms: null,
  };
}

/**
 * Attach downloaded media to inbound Laravel payload.
 * Prefers raw Buffer handoff (multipart) — does NOT base64 by default.
 * Mutates payload.media and sets media_download_* / _mediaBuffer.
 *
 * @param {object} payload
 * @param {Awaited<ReturnType<typeof downloadInboundMedia>>} download
 * @returns {object} payload
 */
export function attachDownloadedMediaToPayload(payload, download) {
  if (!payload || typeof payload !== "object") return payload;

  const media = payload.media && typeof payload.media === "object" ? { ...payload.media } : {};

  payload.media_download_status = download?.status || "failed";
  payload.media_download_error = download?.error || null;
  payload.media_download_attempts = download?.attempts ?? null;

  // Clear legacy base64 unless explicitly re-enabled (compat only).
  const forceBase64 = String(process.env.WHATSAPP_INBOUND_MEDIA_BASE64 || "").trim() === "1";
  delete payload.media_base64;
  delete payload._mediaBuffer;

  if (download?.ok && download.buffer) {
    payload._mediaBuffer = download.buffer;
    media.size_bytes = download.size_bytes ?? media.size_bytes ?? download.buffer.length;
    if (download.mime_type && !media.mime_type) {
      media.mime_type = download.mime_type;
    }
    media.download_status = "ready";
    payload.media_status = "ready";
    if (forceBase64) {
      payload.media_base64 = download.buffer.toString("base64");
    }
  } else if (download?.status === "skipped") {
    payload.media_status = null;
  } else {
    media.download_status = download?.status || "failed";
    media.download_error = download?.error || "download_failed";
    payload.media_status = "failed";
  }

  payload.media = Object.keys(media).length ? media : payload.media;
  return payload;
}
