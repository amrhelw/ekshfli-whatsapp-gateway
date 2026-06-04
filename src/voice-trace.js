import fs from "fs";
import path from "path";

/**
 * @param {Record<string, unknown>} payload
 * @param {Record<string, unknown>} [extra]
 */
export function voiceTraceBase(payload, extra = {}) {
  const fileName = String(payload.file_name || "");
  const ext = path.extname(fileName).toLowerCase() || null;

  return {
    clinic_id: Number(payload.clinic_id) || null,
    message_id: payload.log_id ?? payload.message_id ?? null,
    mime_type: payload.mimetype ?? null,
    file_extension: ext,
    ptt: extra.ptt ?? payload.ptt ?? null,
    audio_seconds: extra.audio_seconds ?? null,
    ...extra,
  };
}

/**
 * @param {import('pino').Logger} logger
 * @param {string} event
 * @param {Record<string, unknown>} payload
 * @param {Record<string, unknown>} [extra]
 */
export function logVoiceTrace(logger, event, payload, extra = {}) {
  logger.info(voiceTraceBase(payload, extra), event);
}

/**
 * @param {string|null|undefined} filePath
 * @param {string|null|undefined} mimeType
 */
export function voiceFileInfo(filePath, mimeType) {
  if (!filePath) {
    return {
      file_path: null,
      file_exists: false,
      file_size: 0,
      file_extension: null,
      mime_type: mimeType ?? null,
    };
  }

  let size = 0;
  let exists = false;
  try {
    exists = fs.existsSync(filePath);
    if (exists) {
      size = fs.statSync(filePath).size;
    }
  } catch {
    exists = false;
  }

  const ext = path.extname(filePath).toLowerCase() || null;

  return {
    file_path: filePath,
    file_exists: exists,
    file_size: size,
    file_extension: ext,
    mime_type: mimeType ?? null,
  };
}

/**
 * @param {Record<string, unknown>} payload
 */
export function sanitizePayloadForLog(payload) {
  const copy = { ...payload };
  delete copy.media_fetch_authorization;
  delete copy.media_fetch_x_api_key;
  return copy;
}
