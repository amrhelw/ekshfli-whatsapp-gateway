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

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

const STALE_CONNECTING_MS = Number(process.env.WHATSAPP_STALE_CONNECTING_MS || 5 * 60 * 1000);

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
 * @property {number|null} statusSince
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
      statusSince: null,
      sock: null,
      authDir: authDirFor(clinicId),
    };
    sessions.set(clinicId, entry);
  }
  return entry;
}

function setEntryStatus(entry, status) {
  const prev = entry.status;
  entry.status = status;
  if (prev !== status) {
    if (status === "connecting" || status === "reconnecting") {
      entry.statusSince = Date.now();
    } else {
      entry.statusSince = null;
    }
    logger.info(
      { clinic_id: entry.clinicId, from: prev, to: status },
      "whatsapp.gateway.connection.status",
    );
  }
}

function isStalePendingStatus(entry) {
  if (!entry.statusSince) return false;
  if (entry.status !== "connecting" && entry.status !== "reconnecting") return false;
  return Date.now() - entry.statusSince > STALE_CONNECTING_MS;
}

async function forceDisconnectEntry(clinicId, reason = null) {
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
  entry.qr = null;
  entry.pairingCode = null;
  entry.lastError = reason;
  setEntryStatus(entry, "disconnected");
  if (fs.existsSync(entry.authDir)) {
    fs.rmSync(entry.authDir, { recursive: true, force: true });
  }
  sessions.delete(clinicId);
  logger.warn({ clinic_id: clinicId, reason }, "whatsapp.gateway.connection.stale_recovery");
  return statusPayload(entry);
}

function hasPersistedAuth(clinicId) {
  const creds = path.join(authDirFor(clinicId), "creds.json");
  return fs.existsSync(creds);
}

function statusPayload(entry) {
  return {
    clinic_id: entry.clinicId,
    status: entry.status,
    qr: entry.qr,
    pairing_code: entry.pairingCode,
    phone_number: entry.phoneNumber,
    wa_jid: entry.waJid,
    profile_name: entry.profileName,
    last_error: entry.lastError,
    session_id: String(entry.clinicId),
  };
}

function qrLength(qr) {
  return qr ? String(qr).length : 0;
}

/**
 * Baileys emits QR asynchronously after the socket is created.
 */
function waitForQr(entry, timeoutMs = 15000) {
  const waitMs = Number(process.env.QR_WAIT_MS || timeoutMs);
  return new Promise((resolve) => {
    if (entry.qr) {
      return resolve(entry.qr);
    }
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
      if (entry.status === "disconnected" && Date.now() > deadline - 1000) {
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

/** Report live session state only — no implicit reconnect on status polls. */
export async function getSessionStatus(clinicId) {
  const entry = entryFor(clinicId);

  logger.info(
    {
      clinic_id: clinicId,
      status: entry.status,
      qr_length: qrLength(entry.qr),
      has_sock: Boolean(entry.sock),
      has_persisted_auth: hasPersistedAuth(clinicId),
    },
    "whatsapp.status.request",
  );

  if (isStalePendingStatus(entry)) {
    const data = await forceDisconnectEntry(
      clinicId,
      "Connection timed out while connecting. Please scan QR again.",
    );
    logger.info(
      { clinic_id: clinicId, status: data.status, qr_length: qrLength(data.qr) },
      "whatsapp.status.response",
    );
    return data;
  }

  if (
    entry.status === "connecting" &&
    !entry.qr &&
    entry.sock &&
    !hasPersistedAuth(clinicId)
  ) {
    await waitForQr(entry, 5000);
  }

  const data = statusPayload(entry);
  logger.info(
    {
      clinic_id: clinicId,
      status: data.status,
      qr_length: qrLength(data.qr),
      session_id: data.session_id,
    },
    "whatsapp.status.response",
  );

  return data;
}

export async function restoreAllSessions() {
  const root = sessionsRoot();
  if (!fs.existsSync(root)) return;

  const dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
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
  options = {},
) {
  const { staleAuthRetry = false } = options;

  if (isStalePendingStatus(entryFor(clinicId))) {
    await forceDisconnectEntry(
      clinicId,
      "Previous connection attempt timed out. Starting fresh.",
    );
  }

  const entry = entryFor(clinicId);
  setEntryStatus(entry, "connecting");
  entry.qr = null;
  entry.pairingCode = null;
  entry.lastError = null;

  logger.info(
    {
      clinic_id: clinicId,
      method,
      is_restore: isRestore,
      stale_auth_retry: staleAuthRetry,
      has_persisted_auth: hasPersistedAuth(clinicId),
    },
    "whatsapp.connect.start",
  );

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

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        entry.qr = await qrcode.toDataURL(qr);
      } catch {
        entry.qr = qr;
      }
      setEntryStatus(entry, "connecting");
      logger.info(
        { clinic_id: clinicId, qr_length: qrLength(entry.qr) },
        "whatsapp.qr.response",
      );
    }

    if (connection === "open") {
      setEntryStatus(entry, "connected");
      entry.qr = null;
      entry.pairingCode = null;
      const user = sock.user;
      entry.waJid = user?.id || null;
      entry.phoneNumber = user?.id?.split(":")[0]?.replace(/\D/g, "") || entry.phoneNumber;
      entry.profileName = user?.name || user?.verifiedName || entry.profileName;
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;
      const shouldReconnect = !loggedOut && isRestore;
      setEntryStatus(entry, shouldReconnect ? "reconnecting" : "disconnected");
      entry.lastError = lastDisconnect?.error?.message || "Connection closed";

      if (loggedOut && fs.existsSync(entry.authDir)) {
        try {
          fs.rmSync(entry.authDir, { recursive: true, force: true });
        } catch {
          /* ignore */
        }
      }

      if (shouldReconnect) {
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
      setEntryStatus(entry, "connecting");
    } catch (err) {
      entry.lastError = err?.message || "Pairing code failed";
      setEntryStatus(entry, "disconnected");
    }
  }

  if (method === "qr" && !isRestore) {
    logger.info({ clinic_id: clinicId }, "whatsapp.qr.request");
    await waitForQr(entry);
  }

  let data = statusPayload(entry);
  logger.info(
    {
      clinic_id: clinicId,
      status: data.status,
      qr_length: qrLength(data.qr),
      session_id: data.session_id,
    },
    "whatsapp.connect.response",
  );

  if (
    method === "qr" &&
    !isRestore &&
    !data.qr &&
    data.status === "disconnected" &&
    hasPersistedAuth(clinicId) &&
    !staleAuthRetry
  ) {
    logger.warn(
      { clinic_id: clinicId },
      "whatsapp.connect.clear_stale_auth",
    );
    await forceDisconnectEntry(clinicId, "Cleared invalid session; scan a new QR.");
    return startSession(clinicId, method, phone, false, { staleAuthRetry: true });
  }

  return data;
}

export async function reconnectSession(clinicId) {
  logger.info({ clinic_id: clinicId }, "whatsapp.gateway.connection.reconnect");
  return startSession(clinicId, "qr", null, false);
}

/**
 * Full clinic-scoped reset: memory session, auth files on disk, QR state.
 * Does not auto-start — admin uses Connect WhatsApp for a fresh QR.
 */
export async function resetSession(clinicId) {
  logger.info({ clinic_id: clinicId }, "whatsapp.session.reset");

  try {
    const data = await forceDisconnectEntry(
      clinicId,
      "Session reset. Use Connect WhatsApp to scan a new QR.",
    );
    logger.info(
      { clinic_id: clinicId, status: data.status, had_auth_cleared: true },
      "whatsapp.session.reset.success",
    );

    return { success: true, data };
  } catch (err) {
    logger.warn(
      { clinic_id: clinicId, err: err?.message },
      "whatsapp.session.reset.failed",
    );
    const entry = entryFor(clinicId);
    setEntryStatus(entry, "disconnected");
    entry.lastError = err?.message || "Session reset failed";

    return {
      success: false,
      message: entry.lastError,
      data: statusPayload(entry),
    };
  }
}

export async function disconnectSession(clinicId) {
  logger.info({ clinic_id: clinicId }, "whatsapp.gateway.connection.disconnect");
  return forceDisconnectEntry(clinicId, null);
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
      const ext = path.extname(String(payload.file_name || defaultExt)) || defaultExt;
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
    return { success: false, message: "WhatsApp session not connected for this clinic." };
  }

  const jid = phoneToJid(payload.to);
  const type = payload.type || "text";

  try {
    let result;
    if (type === "text") {
      result = await entry.sock.sendMessage(jid, { text: String(payload.text || "") });
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
        logger.error(
          { clinic_id: clinicId, to: payload.to, type },
          "whatsapp.audio.send.error",
        );
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
      const fileStat = fs.existsSync(media.path)
        ? fs.statSync(media.path)
        : null;
      logger.info(
        {
          clinic_id: clinicId,
          to: payload.to,
          jid,
          file_name: fileName,
          mimetype,
          media_path: media.path,
          file_size: fileStat?.size ?? null,
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
      } catch (audioErr) {
        logger.error(
          {
            clinic_id: clinicId,
            to: payload.to,
            error: audioErr?.message || String(audioErr),
          },
          "whatsapp.audio.send.error",
        );
        throw audioErr;
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
      logger.error(
        { clinic_id: clinicId, to: payload.to, type, jid },
        type === "audio" ? "whatsapp.audio.send.error" : "whatsapp.gateway.send_no_message_id",
      );
      return {
        success: false,
        message: "WhatsApp did not return a message id (delivery not confirmed).",
      };
    }

    if (type === "audio") {
      logger.info(
        {
          clinic_id: clinicId,
          to: payload.to,
          message_id: messageId,
          jid,
        },
        "whatsapp.audio.send.success",
      );
    }

    return {
      success: true,
      data: {
        message_id: messageId,
        status: "sent",
        jid,
      },
    };
  } catch (err) {
    if ((payload.type || "text") === "audio") {
      logger.error(
        { clinic_id: clinicId, to: payload.to, error: err?.message || String(err) },
        "whatsapp.audio.send.error",
      );
    }
    return { success: false, message: err?.message || "Send failed" };
  }
}
