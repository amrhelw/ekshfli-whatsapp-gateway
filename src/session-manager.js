import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import pino from "pino";
import qrcode from "qrcode";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import { buildCloseDiagnostics } from "./disconnect-diagnostics.js";
import {
  buildGatewayDiagnostics,
  clearDiagnostics,
  diagFor,
  noteDiagPath,
  patchDiag,
} from "./session-diagnostics.js";
import {
  nextSocketGenerationId,
  traceLogout,
  traceSessionCleanup,
  traceSocketDestroy,
} from "./session-trace.js";
import {
  logVoiceTrace,
  sanitizePayloadForLog,
  voiceFileInfo,
} from "./voice-trace.js";
import { prepareVoiceNoteAudio } from "./voice-transcode.js";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

/** @type {Map<number, SessionEntry>} */
const sessions = new Map();

/**
 * @typedef {object} SessionEntry
 * @property {number} clinicId
 * @property {string} status
 * @property {string|null} qr
 * @property {string|null} pairingCode
 * @property {string|null} phoneNumber
 * @property {string|null} waJid
 * @property {string|null} profileName
 * @property {string|null} lastError
 * @property {import('@whiskeysockets/baileys').WASocket|null} sock
 * @property {string} authDir
 * @property {number} socketGenerationId
 */

function sessionsRoot() {
  const dir = process.env.SESSIONS_DIR || path.join(process.cwd(), "sessions");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function authDirFor(clinicId) {
  return path.join(sessionsRoot(), String(clinicId));
}

function qrTraceLength(qr) {
  return qr ? String(qr).length : 0;
}

function waitForQr(entry, timeoutMs = 20000) {
  const waitMs = Number(process.env.QR_WAIT_MS || timeoutMs);
  return new Promise((resolve) => {
    if (entry.qr) return resolve(entry.qr);
    const deadline = Date.now() + waitMs;
    const timer = setInterval(() => {
      if (entry.qr) {
        clearInterval(timer);
        resolve(entry.qr);
        return;
      }
      if (entry.status === "connected") {
        clearInterval(timer);
        resolve(null);
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(timer);
        resolve(null);
      }
    }, 250);
  });
}

function entryFor(clinicId) {
  let entry = sessions.get(clinicId);
  if (!entry) {
    entry = {
      clinicId,
      status: "disconnected",
      qr: null,
      pairingCode: null,
      phoneNumber: null,
      waJid: null,
      profileName: null,
      lastError: null,
      sock: null,
      authDir: authDirFor(clinicId),
      socketGenerationId: 0,
    };
    sessions.set(clinicId, entry);
  }
  return entry;
}

function clearReconnectTimer(entry) {
  if (entry._reconnectTimer) {
    clearTimeout(entry._reconnectTimer);
    entry._reconnectTimer = null;
  }
}

function scheduleSessionReconnect(
  clinicId,
  entry,
  { method, phone, code, disconnectMessage },
) {
  clearReconnectTimer(entry);

  const isRestartRequired =
    code === DisconnectReason.restartRequired ||
    code === 515 ||
    /restart required/i.test(String(disconnectMessage || ""));

  if (isRestartRequired) {
    entry.lastError = null;
  }

  const delay = isRestartRequired ? 600 : 3000;

  logger.info(
    {
      clinic_id: clinicId,
      disconnect_code: code ?? null,
      is_restart_required: isRestartRequired,
      delay_ms: delay,
      socket_generation_id: entry.socketGenerationId,
    },
    "whatsapp.connection.reconnect.scheduled",
  );

  patchDiag(clinicId, {
    reconnect_scheduled: true,
    reconnect_scheduled_at: new Date().toISOString(),
    reconnect_delay_ms: delay,
    restart_required_auto_recovery: isRestartRequired,
  });

  entry._reconnectTimer = setTimeout(() => {
    entry._reconnectTimer = null;
    startSession(
      clinicId,
      method,
      phone,
      true,
      "connection.update:scheduled_reconnect",
    ).catch((err) => {
      logger.error(
        { clinic_id: clinicId, err: err?.message || String(err) },
        "whatsapp.connection.reconnect.failed",
      );
      entry.lastError = err?.message || "Reconnect failed";
      entry.status = "disconnected";
      patchDiag(clinicId, {
        last_start_error: entry.lastError,
        status: "disconnected",
      });
    });
  }, delay);
}

/** Read-only session snapshot for status polling — no side effects. */
export function getSessionStatus(clinicId) {
  const entry = entryFor(clinicId);
  const payload = {
    clinic_id: clinicId,
    status: entry.status,
    qr: entry.qr,
    pairing_code: entry.pairingCode,
    phone_number: entry.phoneNumber,
    wa_jid: entry.waJid,
    profile_name: entry.profileName,
    last_error: entry.lastError,
    session_id: String(clinicId),
  };
  logger.info(
    {
      clinic_id: clinicId,
      status: payload.status,
      qr_length: qrTraceLength(payload.qr),
      qr_prefix: payload.qr ? String(payload.qr).slice(0, 30) : null,
    },
    "whatsapp.qr.trace.gateway_status_response",
  );
  return payload;
}

/** Structured gateway snapshot for WhatsApp connection diagnostics (no log dump). */
export function getSessionDiagnostics(clinicId) {
  const entry = entryFor(clinicId);
  const statusPayload = getSessionStatus(clinicId);
  noteDiagPath(clinicId, "GET /internal/sessions/:id/diagnostics");
  return buildGatewayDiagnostics(clinicId, entry, statusPayload);
}

export async function restoreAllSessions() {
  const root = sessionsRoot();
  if (!fs.existsSync(root)) return;

  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory());
  for (const dir of dirs) {
    const clinicId = Number.parseInt(dir.name, 10);
    if (!Number.isFinite(clinicId)) continue;
    const creds = path.join(root, dir.name, "creds.json");
    if (fs.existsSync(creds)) {
      await startSession(clinicId, "qr", null, true, "restoreAllSessions");
    }
  }
}

export async function startSession(
  clinicId,
  method = "qr",
  phone = null,
  isRestore = false,
  caller = "startSession",
) {
  const entry = entryFor(clinicId);
  clearReconnectTimer(entry);
  noteDiagPath(clinicId, "POST /internal/sessions/:id/start", {
    method,
    is_restore: isRestore,
    caller,
  });
  patchDiag(clinicId, {
    start_called_at: new Date().toISOString(),
    socket_created: false,
    qr_generated: false,
    connection_update_received: false,
    last_start_error: null,
  });
  entry.status = "connecting";
  patchDiag(clinicId, { status: "connecting" });
  entry.qr = null;
  entry.pairingCode = null;
  entry.lastError = null;

  if (entry.sock) {
    traceSocketDestroy(logger, {
      clinicId,
      caller: `${caller}:replace_existing_socket`,
      entry,
      extra: { method: "sock.end", is_restore: isRestore },
    });
    try {
      entry.sock.end(undefined);
    } catch {
      /* ignore */
    }
    entry.sock = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(entry.authDir);
  const { version } = await fetchLatestBaileysVersion();

  const socketGenerationId = nextSocketGenerationId(entry);
  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
  });

  entry.sock = sock;
  patchDiag(clinicId, {
    socket_created: true,
    socket_created_at: new Date().toISOString(),
    socket_generation_id: socketGenerationId,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;
    const d = diagFor(clinicId);
    d.connection_update_count = (d.connection_update_count || 0) + 1;
    patchDiag(clinicId, { connection_update_received: true });

    if (qr) {
      try {
        entry.qr = await qrcode.toDataURL(qr);
      } catch {
        entry.qr = qr;
      }
      entry.status = "connecting";
      patchDiag(clinicId, {
        qr_generated: true,
        qr_generated_at: new Date().toISOString(),
        status: "connecting",
      });
      logger.info(
        {
          clinic_id: clinicId,
          qr_length: qrTraceLength(entry.qr),
          qr_prefix: entry.qr ? String(entry.qr).slice(0, 30) : null,
        },
        "whatsapp.qr.trace.gateway_generated",
      );
    }

    if (connection === "open") {
      patchDiag(clinicId, {
        connection_ever_open: true,
        connection_reached_open_at: new Date().toISOString(),
      });
      entry.status = "connected";
      entry.qr = null;
      entry.pairingCode = null;
      const user = sock.user;
      entry.waJid = user?.id || null;
      entry.phoneNumber =
        user?.id?.split(":")[0]?.replace(/\D/g, "") || entry.phoneNumber;
      entry.profileName =
        user?.name || user?.verifiedName || entry.profileName;
    }

    if (connection === "close") {
      const closeDiagnostics = buildCloseDiagnostics({
        sock,
        authDir: entry.authDir,
        diagState: d,
        lastDisconnect,
      });
      const intentionalLogout =
        closeDiagnostics.disconnect_reason_name === "loggedOut" ||
        closeDiagnostics.last_disconnect_error_message === "Intentional Logout";
      logger.info(
        {
          clinic_id: clinicId,
          socket_generation_id: entry.socketGenerationId,
          disconnect_reason_name: closeDiagnostics.disconnect_reason_name,
          status_code: closeDiagnostics.last_disconnect_error_output_status_code,
          is_boom: closeDiagnostics.error_is_boom,
          logged_out: closeDiagnostics.disconnect_reason_name === "loggedOut",
          intentional_logout: intentionalLogout,
          last_disconnect_error_message:
            closeDiagnostics.last_disconnect_error_message,
          close: closeDiagnostics,
        },
        "whatsapp.connection.close.diagnostics",
      );

      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      entry.status = shouldReconnect ? "reconnecting" : "disconnected";
      entry.lastError = lastDisconnect?.error?.message || "Connection closed";
      patchDiag(clinicId, {
        last_close_diagnostics: closeDiagnostics,
        last_disconnect_reason: entry.lastError,
        last_disconnect_status_code: code ?? null,
        restart_required_detected:
          code === DisconnectReason.restartRequired || code === 515,
        logged_out_detected:
          code === DisconnectReason.loggedOut || code === 401,
        status: entry.status,
      });

      if (shouldReconnect) {
        scheduleSessionReconnect(clinicId, entry, {
          method,
          phone,
          code,
          disconnectMessage: entry.lastError,
        });
      } else {
        clearReconnectTimer(entry);
      }
    }
  });

  if (method === "pairing" && phone) {
    const digits = String(phone).replace(/\D/g, "");
    entry.phoneNumber = digits;
    try {
      const code = await sock.requestPairingCode(digits);
      entry.pairingCode = code;
      entry.status = "connecting";
    } catch (err) {
      entry.lastError = err?.message || "Pairing code failed";
      entry.status = "disconnected";
      patchDiag(clinicId, {
        last_start_error: entry.lastError,
        status: "disconnected",
      });
    }
  }

  if (method === "qr") {
    await waitForQr(entry);
  }

  const out = getSessionStatus(clinicId);
  if (out.qr) {
    patchDiag(clinicId, { qr_delivered_in_start_response: true });
  }
  logger.info(
    {
      clinic_id: clinicId,
      method,
      is_restore: isRestore,
      qr_length: qrTraceLength(out.qr),
    },
    "whatsapp.qr.trace.gateway_start_response",
  );
  return out;
}

export async function reconnectSession(clinicId, caller = "reconnectSession") {
  return startSession(clinicId, "qr", null, true, caller);
}

export async function disconnectSession(clinicId, caller = "disconnectSession") {
  const entry = entryFor(clinicId);
  clearReconnectTimer(entry);
  if (entry.sock) {
    traceLogout(logger, {
      clinicId,
      caller,
      entry,
      extra: { method: "sock.logout" },
    });
    try {
      await entry.sock.logout();
    } catch (err) {
      traceSocketDestroy(logger, {
        clinicId,
        caller: `${caller}:logout_failed_fallback_end`,
        entry,
        extra: {
          method: "sock.end",
          logout_error: err?.message || String(err),
        },
      });
      try {
        entry.sock.end(undefined);
      } catch {
        /* ignore */
      }
    }
    traceSocketDestroy(logger, {
      clinicId,
      caller: `${caller}:after_logout_clear_sock`,
      entry,
      extra: { method: "entry.sock=null" },
    });
    entry.sock = null;
  }

  entry.status = "disconnected";
  entry.qr = null;
  entry.pairingCode = null;
  entry.phoneNumber = null;
  entry.waJid = null;
  entry.profileName = null;
  entry.lastError = null;

  if (fs.existsSync(entry.authDir)) {
    traceSessionCleanup(logger, {
      clinicId,
      caller,
      entry,
      extra: {
        action: "auth_directory_removed",
        auth_dir: entry.authDir,
      },
    });
    fs.rmSync(entry.authDir, { recursive: true, force: true });
  }

  return getSessionStatus(clinicId);
}

function buildResetVerification(clinicId, entry) {
  const authDir = entry.authDir;
  const authExists = fs.existsSync(authDir);
  let hasCreds = false;
  if (authExists) {
    try {
      hasCreds = fs.existsSync(path.join(authDir, "creds.json"));
    } catch {
      hasCreds = false;
    }
  }
  const fullyCleared =
    !authExists &&
    !hasCreds &&
    !entry.sock &&
    !entry.qr &&
    entry.status === "disconnected";

  return {
    clinic_id: clinicId,
    gateway_endpoint: `POST /internal/sessions/${clinicId}/reset`,
    auth_directory: authDir,
    auth_directory_exists: authExists,
    has_creds_json: hasCreds,
    has_socket: Boolean(entry.sock),
    qr_in_memory: Boolean(entry.qr),
    session_status: entry.status,
    fully_cleared: fullyCleared,
  };
}

/** Admin reset — same as disconnect (clears auth); does not auto-start QR. */
export async function resetSession(clinicId, caller = "resetSession") {
  logger.info({ clinic_id: clinicId, caller }, "whatsapp.session.reset");
  noteDiagPath(clinicId, `POST /internal/sessions/${clinicId}/reset`, { caller });
  try {
    const data = await disconnectSession(clinicId, `${caller}->disconnectSession`);
    const entry = entryFor(clinicId);
    clearDiagnostics(clinicId);
    patchDiag(clinicId, {
      status: "disconnected",
      qr_generated: false,
      socket_created: false,
      connection_update_received: false,
      last_reset_at: new Date().toISOString(),
    });
    const verification = buildResetVerification(clinicId, entry);
    logger.info(
      { clinic_id: clinicId, verification },
      "whatsapp.session.reset.verification",
    );
    return { success: verification.fully_cleared, data, verification };
  } catch (err) {
    logger.warn(
      { clinic_id: clinicId, err: err?.message },
      "whatsapp.session.reset.failed",
    );
    const entry = entryFor(clinicId);
    return {
      success: false,
      message: err?.message || "Session reset failed",
      data: getSessionStatus(clinicId),
      verification: buildResetVerification(clinicId, entry),
    };
  }
}

function phoneToJid(phone) {
  const digits = String(phone).replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}

function mimeFromFileName(fileName, fallback = "application/octet-stream") {
  const ext = path.extname(String(fileName || "")).toLowerCase();
  const map = {
    ".pdf": "application/pdf",
    ".webm": "audio/webm",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".m4a": "audio/mp4",
    ".mp4": "audio/mp4",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
  };
  return map[ext] || fallback;
}

/**
 * Resolve media from gateway-local path or download from media_url (API-hosted fetch).
 * @returns {Promise<{ path: string, cleanup: boolean }|null>}
 */
/**
 * @param {Record<string, unknown>} payload
 * @returns {Promise<{ path: string, cleanup: boolean, bytes: number, source: string }|null>}
 */
async function resolveMediaFile(payload) {
  const mediaUrl = payload.media_url;
  if (mediaUrl) {
    const headers = {};
    const token = process.env.GATEWAY_TOKEN || "";
    if (token) {
      headers["X-Gateway-Token"] = token;
    }
    if (payload.media_fetch_authorization) {
      headers["Authorization"] = String(payload.media_fetch_authorization);
    }
    if (payload.media_fetch_x_api_key) {
      headers["x-api-key"] = String(payload.media_fetch_x_api_key);
    }
    try {
      const res = await fetch(String(mediaUrl), { headers });
      if (!res.ok) {
        if (payload.type === "audio") {
          logVoiceTrace(logger, "whatsapp.voice.trace.error", payload, {
            stage: "media_url_fetch",
            error: `HTTP ${res.status}`,
            media_url: mediaUrl,
          });
        }
        logger.warn(
          { media_url: mediaUrl, status: res.status },
          "whatsapp.gateway.media_url_fetch_failed",
        );
        return null;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const defaultExt = payload.type === "audio" ? ".webm" : ".pdf";
      const ext =
        path.extname(String(payload.file_name || defaultExt)) || defaultExt;
      const tmpPath = path.join(
        os.tmpdir(),
        `wa-${crypto.randomBytes(8).toString("hex")}${ext}`,
      );
      fs.writeFileSync(tmpPath, buf);
      if (payload.type === "audio") {
        logVoiceTrace(logger, "whatsapp.voice.trace.downloaded", payload, {
          media_url: mediaUrl,
          downloaded_path: tmpPath,
          file_size: buf.length,
          http_status: res.status,
        });
      }
      logger.info(
        { media_url: mediaUrl, tmp_path: tmpPath, bytes: buf.length },
        "whatsapp.gateway.media_url_fetched",
      );
      return { path: tmpPath, cleanup: true, bytes: buf.length, source: "media_url" };
    } catch (err) {
      if (payload.type === "audio") {
        logVoiceTrace(logger, "whatsapp.voice.trace.error", payload, {
          stage: "media_url_fetch_exception",
          error: err?.message || String(err),
          media_url: mediaUrl,
        });
      }
      logger.warn(
        { media_url: mediaUrl, err: err?.message },
        "whatsapp.gateway.media_url_fetch_error",
      );
      return null;
    }
  }

  const mediaPath = payload.media_path;
  if (mediaPath && fs.existsSync(mediaPath)) {
    const bytes = fs.statSync(mediaPath).size;
    if (payload.type === "audio") {
      logVoiceTrace(logger, "whatsapp.voice.trace.downloaded", payload, {
        downloaded_path: mediaPath,
        file_size: bytes,
        source: "media_path",
      });
    }
    return { path: mediaPath, cleanup: false, bytes, source: "media_path" };
  }

  if (mediaPath) {
    if (payload.type === "audio") {
      logVoiceTrace(logger, "whatsapp.voice.trace.error", payload, {
        stage: "media_path_missing",
        error: "media_path not found on gateway host",
        media_path: mediaPath,
      });
    }
    logger.warn({ media_path: mediaPath }, "whatsapp.gateway.media_path_missing");
  }

  return null;
}

export async function sendMessage(payload) {
  const clinicId = Number(payload.clinic_id);
  const entry = entryFor(clinicId);

  if (entry.status !== "connected" || !entry.sock) {
    return {
      success: false,
      message: "WhatsApp session not connected for this clinic.",
    };
  }

  const jid = phoneToJid(payload.to);
  const type = payload.type || "text";

  try {
    let result;
    if (type === "text") {
      result = await entry.sock.sendMessage(jid, {
        text: String(payload.text || ""),
      });
    } else if (type === "image") {
      const media = await resolveMediaFile(payload);
      if (!media) {
        return {
          success: false,
          message: "Image file not found on gateway host.",
        };
      }
      try {
        result = await entry.sock.sendMessage(jid, {
          image: fs.readFileSync(media.path),
          caption: payload.text ? String(payload.text) : undefined,
        });
      } finally {
        if (media.cleanup) {
          try {
            fs.unlinkSync(media.path);
          } catch {
            /* ignore */
          }
        }
      }
    } else if (type === "audio") {
      logVoiceTrace(logger, "whatsapp.voice.trace.start", payload, {
        stage: "gateway_send",
        received_payload: sanitizePayloadForLog(payload),
        jid,
      });

      const media = await resolveMediaFile(payload);
      if (!media) {
        logVoiceTrace(logger, "whatsapp.voice.trace.error", payload, {
          stage: "resolve_media",
          error: "Audio file not found on gateway host.",
        });
        return {
          success: false,
          message: "Audio file not found on gateway host.",
        };
      }

      const fileName = payload.file_name || path.basename(media.path);
      const originalMimetype =
        payload.mimetype ||
        mimeFromFileName(fileName, "audio/ogg; codecs=opus");

      const fileInfo = voiceFileInfo(media.path, originalMimetype);
      logVoiceTrace(logger, "whatsapp.voice.trace.file_info", payload, {
        ...fileInfo,
        media_source: media.source,
        resolved_path: media.path,
      });

      const voicePrep = await prepareVoiceNoteAudio(
        logger,
        payload,
        media.path,
        originalMimetype,
        fileName,
      );

      const sendPath = voicePrep.sendPath;
      const sendMimetype = voicePrep.mimetype;
      const sendPtt = voicePrep.ptt;
      const sendFileInfo = voiceFileInfo(sendPath, sendMimetype);

      logVoiceTrace(logger, "whatsapp.voice.trace.payload", payload, {
        ...voicePrep.diagnostics,
        baileys_content: {
          mimetype: sendMimetype,
          ptt: sendPtt,
          audio_bytes: sendFileInfo.file_size ?? 0,
        },
      });

      logVoiceTrace(logger, "whatsapp.voice.trace.baileys_send", payload, {
        jid,
        ptt: sendPtt,
        file_size: sendFileInfo.file_size ?? 0,
        send_message_called: true,
        ...voicePrep.diagnostics,
      });

      logger.info(
        {
          clinic_id: clinicId,
          to: payload.to,
          file_name: fileName,
          mimetype: sendMimetype,
          ptt: sendPtt,
          transcoding_success: voicePrep.diagnostics.transcoding_success,
        },
        "whatsapp.audio.send.start",
      );
      try {
        result = await entry.sock.sendMessage(jid, {
          audio: fs.readFileSync(sendPath),
          mimetype: sendMimetype,
          ptt: sendPtt,
        });
      } finally {
        const pathsToCleanup = new Set();
        if (media.cleanup) {
          pathsToCleanup.add(media.path);
        }
        if (voicePrep.cleanupOutput && sendPath !== media.path) {
          pathsToCleanup.add(sendPath);
        }
        for (const p of pathsToCleanup) {
          try {
            fs.unlinkSync(p);
          } catch {
            /* ignore */
          }
        }
      }

      logVoiceTrace(logger, "whatsapp.voice.trace.baileys_result", payload, {
        baileys_message_id: result?.key?.id ?? null,
        baileys_key: result?.key ?? null,
        baileys_status: result?.status ?? null,
        send_message_succeeded: Boolean(result?.key?.id),
        final_ptt: sendPtt,
        ...voicePrep.diagnostics,
      });
    } else if (type === "document") {
      const media = await resolveMediaFile(payload);
      if (!media) {
        return {
          success: false,
          message: "Document file not found on gateway host.",
        };
      }
      const fileName = payload.file_name || path.basename(media.path);
      const mimetype =
        payload.mimetype || mimeFromFileName(fileName, "application/pdf");
      try {
        result = await entry.sock.sendMessage(jid, {
          document: fs.readFileSync(media.path),
          mimetype,
          fileName,
          caption: payload.text ? String(payload.text) : undefined,
        });
      } finally {
        if (media.cleanup) {
          try {
            fs.unlinkSync(media.path);
          } catch {
            /* ignore */
          }
        }
      }
    } else {
      return { success: false, message: "Unsupported message type." };
    }

    const messageId = result?.key?.id || null;
    if (!messageId) {
      if (type === "audio") {
        logVoiceTrace(logger, "whatsapp.voice.trace.error", payload, {
          stage: "baileys_no_message_id",
          error: "WhatsApp did not return a message id",
          baileys_result_keys: result ? Object.keys(result) : [],
        });
      }
      return {
        success: false,
        message:
          "WhatsApp did not return a message id (delivery not confirmed).",
      };
    }

    return {
      success: true,
      data: { message_id: messageId, status: "sent", jid },
    };
  } catch (err) {
    if ((payload.type || "") === "audio") {
      logVoiceTrace(logger, "whatsapp.voice.trace.error", payload, {
        stage: "send_message_outer",
        error: err?.message || String(err),
        stack: err?.stack || null,
      });
    }
    return { success: false, message: err?.message || "Send failed" };
  }
}
