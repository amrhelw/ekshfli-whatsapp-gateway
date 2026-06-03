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

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const STALE_CONNECTING_MS = Number(
  process.env.WHATSAPP_STALE_CONNECTING_MS || 5 * 60 * 1000,
);
const QR_LOCK_MS = Number(process.env.WHATSAPP_QR_LOCK_MS || 60 * 1000);
const PAIRING_RESTART_DELAY_MS = Number(
  process.env.WHATSAPP_PAIRING_RESTART_DELAY_MS || 2000,
);

function autoRestoreEnabled() {
  const v = String(process.env.WHATSAPP_AUTO_RESTORE ?? "0").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

/** @type {Map<number, SessionEntry>} */
const sessions = new Map();

/** @type {Map<number, Promise<unknown>>} */
const clinicStartLocks = new Map();

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
 * @property {number} socketGeneration
 * @property {number|null} qrGeneratedAt
 * @property {number|null} qrExpiresAt
 * @property {import('@whiskeysockets/baileys').WASocket|null} sock
 * @property {string} authDir
 * @property {boolean} pairingInProgress
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

function iso(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

function qrLength(qr) {
  return qr ? String(qr).length : 0;
}

function listAuthFiles(clinicId) {
  const dir = authDirFor(clinicId);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (base) => {
    for (const name of fs.readdirSync(base)) {
      const full = path.join(base, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

function destroyAuthDir(clinicId, reason) {
  const dir = authDirFor(clinicId);
  const filesBefore = listAuthFiles(clinicId);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  logger.info(
    {
      clinic_id: clinicId,
      auth_dir: dir,
      files_removed: filesBefore.length,
      had_creds: filesBefore.some((f) => f.endsWith("creds.json")),
      reason,
    },
    "whatsapp.session.destroy",
  );
}

function hasPersistedAuth(clinicId) {
  return fs.existsSync(path.join(authDirFor(clinicId), "creds.json"));
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
      socketGeneration: 0,
      qrGeneratedAt: null,
      qrExpiresAt: null,
      sock: null,
      authDir: authDirFor(clinicId),
      pairingInProgress: false,
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
      {
        clinic_id: entry.clinicId,
        from: prev,
        to: status,
        at: iso(Date.now()),
      },
      "whatsapp.gateway.connection.status",
    );
  }
}

function isStalePendingStatus(entry) {
  if (!entry.statusSince) return false;
  if (entry.status !== "connecting" && entry.status !== "reconnecting") {
    return false;
  }
  return Date.now() - entry.statusSince > STALE_CONNECTING_MS;
}

function statusPayload(entry) {
  const now = Date.now();
  const qrAgeMs =
    entry.qrGeneratedAt != null ? now - entry.qrGeneratedAt : null;

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
    socket_generation: entry.socketGeneration,
    qr_generated_at: iso(entry.qrGeneratedAt),
    qr_expires_at: iso(entry.qrExpiresAt),
    qr_age_ms: qrAgeMs,
    qr_expired: entry.qrExpiresAt != null ? now > entry.qrExpiresAt : false,
    pairing_in_progress: entry.pairingInProgress,
    has_persisted_auth: hasPersistedAuth(entry.clinicId),
  };
}

async function endSocket(entry) {
  if (!entry.sock) return;
  try {
    entry.sock.end(undefined);
  } catch {
    /* ignore */
  }
  entry.sock = null;
}

async function forceDisconnectEntry(clinicId, reason = null) {
  const entry = entryFor(clinicId);
  entry.pairingInProgress = false;
  await endSocket(entry);
  entry.qr = null;
  entry.qrGeneratedAt = null;
  entry.qrExpiresAt = null;
  entry.pairingCode = null;
  entry.phoneNumber = null;
  entry.waJid = null;
  entry.profileName = null;
  entry.lastError = reason;
  setEntryStatus(entry, "disconnected");
  destroyAuthDir(clinicId, reason || "force_disconnect");
  sessions.delete(clinicId);
  logger.warn(
    { clinic_id: clinicId, reason, at: iso(Date.now()) },
    "whatsapp.session.reset",
  );
  return statusPayload(entryFor(clinicId));
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

function bindSocketEvents(entry, sock, clinicId, method, phone, isRestore, generation) {
  sock.ev.on("creds.update", async () => {
    if (entry.socketGeneration !== generation) return;
    logger.info(
      {
        clinic_id: clinicId,
        generation,
        files: listAuthFiles(clinicId).length,
        at: iso(Date.now()),
      },
      "whatsapp.auth.saved",
    );
  });

  sock.ev.on("connection.update", async (update) => {
    if (entry.socketGeneration !== generation) {
      logger.warn(
        {
          clinic_id: clinicId,
          event_generation: generation,
          active_generation: entry.socketGeneration,
        },
        "whatsapp.connection.update.stale_socket_ignored",
      );
      return;
    }

    const { connection, lastDisconnect, qr, receivedPendingNotifications } =
      update;

    if (qr) {
      const now = Date.now();
      const locked = entry.qrExpiresAt && now < entry.qrExpiresAt && entry.qr;
      if (!locked) {
        try {
          entry.qr = await qrcode.toDataURL(qr);
        } catch {
          entry.qr = qr;
        }
        entry.qrGeneratedAt = now;
        entry.qrExpiresAt = now + QR_LOCK_MS;
        setEntryStatus(entry, "connecting");
        logger.info(
          {
            clinic_id: clinicId,
            generation,
            qr_length: qrLength(entry.qr),
            qr_generated_at: iso(entry.qrGeneratedAt),
            qr_expires_at: iso(entry.qrExpiresAt),
            at: iso(now),
          },
          "whatsapp.qr.generated",
        );
      } else {
        logger.info(
          {
            clinic_id: clinicId,
            qr_age_ms: now - (entry.qrGeneratedAt || now),
            qr_expires_at: iso(entry.qrExpiresAt),
          },
          "whatsapp.qr.stale_refresh_ignored",
        );
      }
    }

    if (receivedPendingNotifications) {
      logger.info({ clinic_id: clinicId, generation }, "whatsapp.qr.scanned");
    }

    if (connection === "open") {
      entry.pairingInProgress = false;
      setEntryStatus(entry, "connected");
      entry.qr = null;
      entry.qrGeneratedAt = null;
      entry.qrExpiresAt = null;
      entry.pairingCode = null;
      const user = sock.user;
      entry.waJid = user?.id || null;
      entry.phoneNumber =
        user?.id?.split(":")[0]?.replace(/\D/g, "") || entry.phoneNumber;
      entry.profileName =
        user?.name || user?.verifiedName || entry.profileName;
      logger.info(
        {
          clinic_id: clinicId,
          generation,
          wa_jid: entry.waJid,
          phone_number: entry.phoneNumber,
          at: iso(Date.now()),
        },
        "whatsapp.session.open",
      );
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const errMsg = lastDisconnect?.error?.message || "Connection closed";
      const loggedOut = code === DisconnectReason.loggedOut;
      const restartRequired = code === DisconnectReason.restartRequired;
      const wasConnecting =
        entry.status === "connecting" || entry.status === "reconnecting";

      logger.error(
        {
          clinic_id: clinicId,
          generation,
          status_code: code,
          disconnect_reason: disconnectReasonLabel(code),
          message: errMsg,
          logged_out: loggedOut,
          restart_required: restartRequired,
          is_restore: isRestore,
          was_connecting: wasConnecting,
          pairing_in_progress: entry.pairingInProgress,
          had_phone: Boolean(entry.phoneNumber),
          has_persisted_auth: hasPersistedAuth(clinicId),
          at: iso(Date.now()),
        },
        "whatsapp.session.close",
      );

      await endSocket(entry);

      if (restartRequired && hasPersistedAuth(clinicId)) {
        logger.info(
          { clinic_id: clinicId, generation, delay_ms: PAIRING_RESTART_DELAY_MS },
          "whatsapp.session.restart_required",
        );
        setEntryStatus(entry, "connecting");
        entry.pairingInProgress = true;
        setTimeout(() => {
          startSession(clinicId, method, phone, true, {
            forceNewSocket: true,
            afterRestartRequired: true,
          }).catch((err) => {
            logger.error(
              { clinic_id: clinicId, err: err?.message },
              "whatsapp.session.restart_failed",
            );
          });
        }, PAIRING_RESTART_DELAY_MS);
        return;
      }

      if (loggedOut || code === 401 || code === 403) {
        destroyAuthDir(clinicId, `logged_out_${code}`);
      } else if (wasConnecting && !entry.phoneNumber && !hasPersistedAuth(clinicId)) {
        destroyAuthDir(clinicId, "pairing_failed_no_auth");
      } else if (wasConnecting && !entry.phoneNumber && hasPersistedAuth(clinicId)) {
        logger.info(
          { clinic_id: clinicId },
          "whatsapp.auth.loaded_partial_retry",
        );
        setEntryStatus(entry, "connecting");
        setTimeout(() => {
          startSession(clinicId, method, phone, true, { forceNewSocket: true });
        }, PAIRING_RESTART_DELAY_MS);
        return;
      }

      entry.pairingInProgress = false;
      setEntryStatus(entry, "disconnected");
      entry.qr = null;
      entry.qrGeneratedAt = null;
      entry.qrExpiresAt = null;
      entry.lastError = `${disconnectReasonLabel(code)}: ${errMsg}`;

      if (isRestore && !loggedOut && !restartRequired) {
        setEntryStatus(entry, "reconnecting");
        setTimeout(() => {
          startSession(clinicId, method, phone, true, { forceNewSocket: true });
        }, 3000);
      }
    }
  });
}

function disconnectReasonLabel(code) {
  if (code === DisconnectReason.loggedOut) return "loggedOut";
  if (code === DisconnectReason.restartRequired) return "restartRequired";
  if (code === DisconnectReason.timedOut) return "timedOut";
  if (code === DisconnectReason.connectionClosed) return "connectionClosed";
  if (code === DisconnectReason.connectionLost) return "connectionLost";
  if (code === DisconnectReason.connectionReplaced) return "connectionReplaced";
  if (code === DisconnectReason.multideviceMismatch) return "multideviceMismatch";
  if (code === DisconnectReason.forbidden) return "forbidden";
  if (code === DisconnectReason.unavailableService) return "unavailableService";
  return code != null ? `code_${code}` : "unknown";
}

async function startSessionImpl(
  clinicId,
  method = "qr",
  phone = null,
  isRestore = false,
  options = {},
) {
  const {
    staleAuthRetry = false,
    forceNewSocket = false,
    afterRestartRequired = false,
  } = options;

  const existingLive = sessions.get(clinicId);
  if (
    !forceNewSocket &&
    !staleAuthRetry &&
    !afterRestartRequired &&
    !isRestore &&
    existingLive?.pairingInProgress &&
    existingLive?.sock
  ) {
    logger.info(
      {
        clinic_id: clinicId,
        generation: existingLive.socketGeneration,
        qr_age_ms:
          existingLive.qrGeneratedAt != null
            ? Date.now() - existingLive.qrGeneratedAt
            : null,
      },
      "whatsapp.connect.reuse_active_pairing",
    );
    return statusPayload(existingLive);
  }

  if (isStalePendingStatus(entryFor(clinicId))) {
    await forceDisconnectEntry(
      clinicId,
      "Previous connection attempt timed out. Starting fresh.",
    );
  }

  const entry = entryFor(clinicId);

  if (method === "qr" && !isRestore && !afterRestartRequired && !staleAuthRetry) {
    destroyAuthDir(clinicId, "fresh_qr_connect");
    await endSocket(entry);
  }

  if (forceNewSocket || staleAuthRetry || afterRestartRequired) {
    await endSocket(entry);
  }

  const generation = entry.socketGeneration + 1;
  entry.socketGeneration = generation;
  entry.pairingInProgress = method === "qr";
  setEntryStatus(entry, "connecting");
  entry.qr = null;
  entry.qrGeneratedAt = null;
  entry.qrExpiresAt = null;
  entry.pairingCode = null;
  if (!afterRestartRequired && !isRestore) {
    entry.phoneNumber = null;
    entry.waJid = null;
    entry.profileName = null;
  }
  entry.lastError = null;

  logger.info(
    {
      clinic_id: clinicId,
      method,
      is_restore: isRestore,
      generation,
      after_restart_required: afterRestartRequired,
      has_persisted_auth: hasPersistedAuth(clinicId),
      auth_files: listAuthFiles(clinicId).length,
      at: iso(Date.now()),
    },
    "whatsapp.connect.start",
  );

  if (hasPersistedAuth(clinicId)) {
    logger.info(
      { clinic_id: clinicId, auth_dir: entry.authDir },
      "whatsapp.auth.loaded",
    );
  }

  const { state, saveCreds } = await useMultiFileAuthState(entry.authDir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    generateHighQualityLinkPreview: false,
    browser: ["Ekshfli", "Chrome", "122.0.0"],
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  entry.sock = sock;
  sock.ev.on("creds.update", saveCreds);
  bindSocketEvents(entry, sock, clinicId, method, phone, isRestore, generation);

  if (method === "pairing" && phone) {
    const digits = String(phone).replace(/\D/g, "");
    entry.phoneNumber = digits;
    try {
      const code = await sock.requestPairingCode(digits);
      entry.pairingCode = code;
      setEntryStatus(entry, "connecting");
    } catch (err) {
      entry.lastError = err?.message || "Pairing code failed";
      entry.pairingInProgress = false;
      setEntryStatus(entry, "disconnected");
    }
  }

  if (method === "qr" && !isRestore && !afterRestartRequired) {
    logger.info({ clinic_id: clinicId, generation }, "whatsapp.qr.request");
    await waitForQr(entry);
  }

  let data = statusPayload(entry);
  logger.info(
    {
      clinic_id: clinicId,
      status: data.status,
      qr_length: qrLength(data.qr),
      qr_generated_at: data.qr_generated_at,
      qr_expires_at: data.qr_expires_at,
      generation,
      at: iso(Date.now()),
    },
    "whatsapp.connect.response",
  );

  if (data.qr) {
    logger.info(
      {
        clinic_id: clinicId,
        qr_generated_at: data.qr_generated_at,
        qr_expires_at: data.qr_expires_at,
      },
      "whatsapp.qr.delivered",
    );
  }

  if (
    method === "qr" &&
    !isRestore &&
    !afterRestartRequired &&
    !data.qr &&
    data.status === "disconnected" &&
    !staleAuthRetry
  ) {
    logger.warn({ clinic_id: clinicId }, "whatsapp.connect.retry_after_fail");
    await forceDisconnectEntry(clinicId, "connect_failed_retry");
    return startSession(clinicId, method, phone, false, {
      staleAuthRetry: true,
      forceNewSocket: true,
    });
  }

  return data;
}

export async function startSession(
  clinicId,
  method = "qr",
  phone = null,
  isRestore = false,
  options = {},
) {
  const prev = clinicStartLocks.get(clinicId) || Promise.resolve();
  const run = prev
    .catch(() => {})
    .then(() => startSessionImpl(clinicId, method, phone, isRestore, options));
  clinicStartLocks.set(clinicId, run);
  try {
    return await run;
  } finally {
    if (clinicStartLocks.get(clinicId) === run) {
      clinicStartLocks.delete(clinicId);
    }
  }
}

export async function getSessionStatus(clinicId) {
  const entry = entryFor(clinicId);

  logger.info(
    {
      clinic_id: clinicId,
      status: entry.status,
      qr_length: qrLength(entry.qr),
      qr_age_ms:
        entry.qrGeneratedAt != null ? Date.now() - entry.qrGeneratedAt : null,
      qr_expires_at: iso(entry.qrExpiresAt),
      has_sock: Boolean(entry.sock),
      generation: entry.socketGeneration,
      pairing_in_progress: entry.pairingInProgress,
      at: iso(Date.now()),
    },
    "whatsapp.status.request",
  );

  if (isStalePendingStatus(entry)) {
    const data = await forceDisconnectEntry(
      clinicId,
      "Connection timed out while connecting. Please scan QR again.",
    );
    logger.info({ clinic_id: clinicId }, "whatsapp.status.response");
    return data;
  }

  if (
    entry.status === "connecting" &&
    !entry.qr &&
    entry.sock &&
    entry.pairingInProgress
  ) {
    await waitForQr(entry, 8000);
  }

  const data = statusPayload(entry);
  logger.info(
    {
      clinic_id: clinicId,
      status: data.status,
      qr_length: qrLength(data.qr),
      qr_age_ms: data.qr_age_ms,
      qr_expired: data.qr_expired,
      at: iso(Date.now()),
    },
    "whatsapp.status.response",
  );

  return data;
}

export async function restoreAllSessions() {
  if (!autoRestoreEnabled()) {
    logger.info("whatsapp.session.restore_skipped");
    return;
  }

  const root = sessionsRoot();
  if (!fs.existsSync(root)) return;

  logger.info("whatsapp.session.restore.start");

  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory());
  for (const dir of dirs) {
    const clinicId = Number.parseInt(dir.name, 10);
    if (!Number.isFinite(clinicId)) continue;
    const creds = path.join(root, dir.name, "creds.json");
    if (fs.existsSync(creds)) {
      logger.info({ clinic_id: clinicId }, "whatsapp.session.restore.clinic");
      await startSession(clinicId, "qr", null, true, { forceNewSocket: true });
    }
  }

  logger.info("whatsapp.session.restore.done");
}

export async function reconnectSession(clinicId) {
  logger.info({ clinic_id: clinicId }, "whatsapp.gateway.connection.reconnect");
  const live = sessions.get(clinicId);
  if (live?.pairingInProgress && live.qr) {
    return statusPayload(live);
  }
  return startSession(clinicId, "qr", null, false, { forceNewSocket: true });
}

export async function resetSession(clinicId) {
  logger.info({ clinic_id: clinicId, at: iso(Date.now()) }, "whatsapp.session.reset");
  clinicStartLocks.delete(clinicId);

  try {
    const data = await forceDisconnectEntry(
      clinicId,
      "Session reset. Use Connect WhatsApp to scan a new QR.",
    );
    logger.info(
      { clinic_id: clinicId, auth_files: listAuthFiles(clinicId).length },
      "whatsapp.session.reset.success",
    );
    return { success: true, data };
  } catch (err) {
    logger.warn(
      { clinic_id: clinicId, err: err?.message },
      "whatsapp.session.reset.failed",
    );
    return {
      success: false,
      message: err?.message || "Session reset failed",
      data: statusPayload(entryFor(clinicId)),
    };
  }
}

export async function disconnectSession(clinicId) {
  logger.info({ clinic_id: clinicId }, "whatsapp.gateway.connection.disconnect");
  clinicStartLocks.delete(clinicId);
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

async function resolveMediaFile(payload) {
  const mediaUrl = payload.media_url;
  if (mediaUrl) {
    const headers = {};
    const token = process.env.GATEWAY_TOKEN || "";
    if (token) headers["X-Gateway-Token"] = token;
    if (payload.media_fetch_authorization) {
      headers.Authorization = String(payload.media_fetch_authorization);
    }
    if (payload.media_fetch_x_api_key) {
      headers["x-api-key"] = String(payload.media_fetch_x_api_key);
    }
    try {
      const res = await fetch(String(mediaUrl), { headers });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      const defaultExt = payload.type === "audio" ? ".webm" : ".pdf";
      const ext =
        path.extname(String(payload.file_name || defaultExt)) || defaultExt;
      const tmpPath = path.join(
        os.tmpdir(),
        `wa-${crypto.randomBytes(8).toString("hex")}${ext}`,
      );
      fs.writeFileSync(tmpPath, buf);
      return { path: tmpPath, cleanup: true };
    } catch {
      return null;
    }
  }

  const mediaPath = payload.media_path;
  if (mediaPath && fs.existsSync(mediaPath)) {
    return { path: mediaPath, cleanup: false };
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
      result = await entry.sock.sendMessage(jid, {
        text: String(payload.text || ""),
      });
    } else if (type === "image") {
      const media = await resolveMediaFile(payload);
      if (!media) {
        return { success: false, message: "Image file not found on gateway host." };
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
        return { success: false, message: "Audio file not found on gateway host." };
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
        return { success: false, message: "Document file not found on gateway host." };
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
        message: "WhatsApp did not return a message id (delivery not confirmed).",
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
