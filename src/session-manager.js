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
    };
    sessions.set(clinicId, entry);
  }
  return entry;
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
      await startSession(clinicId, "qr", null, true);
    }
  }
}

export async function startSession(
  clinicId,
  method = "qr",
  phone = null,
  isRestore = false,
) {
  const entry = entryFor(clinicId);
  noteDiagPath(clinicId, "POST /internal/sessions/:id/start", {
    method,
    is_restore: isRestore,
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
    try {
      entry.sock.end(undefined);
    } catch {
      /* ignore */
    }
    entry.sock = null;
  }

  const { state, saveCreds } = await useMultiFileAuthState(entry.authDir);
  const { version } = await fetchLatestBaileysVersion();

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
      logger.info(
        {
          clinic_id: clinicId,
          disconnect_reason_name: closeDiagnostics.disconnect_reason_name,
          status_code: closeDiagnostics.last_disconnect_error_output_status_code,
          is_boom: closeDiagnostics.error_is_boom,
          logged_out: closeDiagnostics.disconnect_reason_name === "loggedOut",
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

      if (shouldReconnect && !isRestore) {
        setTimeout(() => startSession(clinicId, method, phone, true), 3000);
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

export async function reconnectSession(clinicId) {
  return startSession(clinicId, "qr", null, true);
}

export async function disconnectSession(clinicId) {
  const entry = entryFor(clinicId);
  if (entry.sock) {
    try {
      await entry.sock.logout();
    } catch {
      try {
        entry.sock.end(undefined);
      } catch {
        /* ignore */
      }
    }
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
export async function resetSession(clinicId) {
  logger.info({ clinic_id: clinicId }, "whatsapp.session.reset");
  noteDiagPath(clinicId, `POST /internal/sessions/${clinicId}/reset`);
  try {
    const data = await disconnectSession(clinicId);
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
      logger.info(
        { media_url: mediaUrl, tmp_path: tmpPath, bytes: buf.length },
        "whatsapp.gateway.media_url_fetched",
      );
      return { path: tmpPath, cleanup: true };
    } catch (err) {
      logger.warn(
        { media_url: mediaUrl, err: err?.message },
        "whatsapp.gateway.media_url_fetch_error",
      );
      return null;
    }
  }

  const mediaPath = payload.media_path;
  if (mediaPath && fs.existsSync(mediaPath)) {
    return { path: mediaPath, cleanup: false };
  }

  if (mediaPath) {
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
      const media = await resolveMediaFile(payload);
      if (!media) {
        return {
          success: false,
          message: "Audio file not found on gateway host.",
        };
      }
      const fileName = payload.file_name || path.basename(media.path);
      const mimetype =
        payload.mimetype ||
        mimeFromFileName(fileName, "audio/ogg; codecs=opus");
      const isWebm =
        String(mimetype).toLowerCase().includes("webm") ||
        String(fileName).toLowerCase().endsWith(".webm");
      const usePtt =
        payload.ptt !== false && !isWebm && payload.ptt !== "0";
      logger.info(
        {
          clinic_id: clinicId,
          to: payload.to,
          file_name: fileName,
          mimetype,
          ptt: usePtt,
        },
        "whatsapp.audio.send.start",
      );
      try {
        result = await entry.sock.sendMessage(jid, {
          audio: fs.readFileSync(media.path),
          mimetype,
          ptt: usePtt,
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
    return { success: false, message: err?.message || "Send failed" };
  }
}
