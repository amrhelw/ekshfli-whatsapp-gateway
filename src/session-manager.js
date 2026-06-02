import fs from "fs";
import path from "path";
import pino from "pino";
import qrcode from "qrcode";
import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

const logger = pino({ level: process.env.LOG_LEVEL || "warn" });

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

export function getSessionStatus(clinicId) {
  const entry = entryFor(clinicId);
  return {
    clinic_id: clinicId,
    status: entry.status,
    qr: entry.qr,
    pairing_code: entry.pairingCode,
    phone_number: entry.phoneNumber,
    wa_jid: entry.waJid,
    profile_name: entry.profileName,
    last_error: entry.lastError,
  };
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

export async function startSession(clinicId, method = "qr", phone = null, isRestore = false) {
  const entry = entryFor(clinicId);
  entry.status = "connecting";
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

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        entry.qr = await qrcode.toDataURL(qr);
      } catch {
        entry.qr = qr;
      }
      entry.status = "connecting";
    }

    if (connection === "open") {
      entry.status = "connected";
      entry.qr = null;
      entry.pairingCode = null;
      const user = sock.user;
      entry.waJid = user?.id || null;
      entry.phoneNumber = user?.id?.split(":")[0]?.replace(/\D/g, "") || entry.phoneNumber;
      entry.profileName = user?.name || user?.verifiedName || entry.profileName;
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      entry.status = shouldReconnect ? "reconnecting" : "disconnected";
      entry.lastError = lastDisconnect?.error?.message || "Connection closed";

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
    }
  }

  return getSessionStatus(clinicId);
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

  if (fs.existsSync(entry.authDir)) {
    fs.rmSync(entry.authDir, { recursive: true, force: true });
  }

  return getSessionStatus(clinicId);
}

function phoneToJid(phone) {
  const digits = String(phone).replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
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
      const mediaPath = payload.media_path;
      if (!mediaPath || !fs.existsSync(mediaPath)) {
        return { success: false, message: "Image file not found on gateway host." };
      }
      result = await entry.sock.sendMessage(jid, {
        image: fs.readFileSync(mediaPath),
        caption: payload.text ? String(payload.text) : undefined,
      });
    } else if (type === "document") {
      const mediaPath = payload.media_path;
      if (!mediaPath || !fs.existsSync(mediaPath)) {
        return { success: false, message: "Document file not found on gateway host." };
      }
      result = await entry.sock.sendMessage(jid, {
        document: fs.readFileSync(mediaPath),
        mimetype: "application/pdf",
        fileName: payload.file_name || path.basename(mediaPath),
        caption: payload.text ? String(payload.text) : undefined,
      });
    } else {
      return { success: false, message: "Unsupported message type." };
    }

    const messageId = result?.key?.id || null;

    return {
      success: true,
      data: {
        message_id: messageId,
        status: "sent",
        jid,
      },
    };
  } catch (err) {
    return { success: false, message: err?.message || "Send failed" };
  }
}
