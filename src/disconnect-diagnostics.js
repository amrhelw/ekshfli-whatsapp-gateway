import fs from "fs";
import path from "path";
import { DisconnectReason } from "@whiskeysockets/baileys";

function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

/**
 * @param {unknown} code
 * @returns {string|null}
 */
export function resolveDisconnectReasonName(code) {
  if (code === undefined || code === null) return null;
  const numeric = Number(code);
  if (!Number.isFinite(numeric)) return null;
  for (const [name, value] of Object.entries(DisconnectReason)) {
    if (typeof value === "number" && value === numeric) return name;
  }
  return `unknown_status_code_${numeric}`;
}

/**
 * @param {unknown} err
 * @returns {boolean|null}
 */
export function boomIsBoom(err) {
  if (!err || typeof err !== "object") return null;
  return err.isBoom === true;
}

/**
 * @param {unknown} err
 * @param {number} depth
 * @returns {unknown}
 */
export function serializeError(err, depth = 0) {
  if (err == null) return null;
  if (depth > 5) return "[max_depth]";
  if (typeof err !== "object") return err;

  const e = /** @type {Record<string, unknown>} */ (err);
  const out = {
    name: typeof e.name === "string" ? e.name : null,
    message: typeof e.message === "string" ? e.message : null,
    stack: typeof e.stack === "string" ? e.stack : null,
    isBoom: boomIsBoom(err),
    output: null,
  };

  if (e.output && typeof e.output === "object") {
    const output = /** @type {Record<string, unknown>} */ (e.output);
    out.output = {
      statusCode: output.statusCode ?? null,
      payload: output.payload ?? null,
      headers: output.headers ?? null,
    };
  }

  return out;
}

/**
 * @param {unknown} lastDisconnect
 * @returns {Record<string, unknown>|null}
 */
export function serializeLastDisconnect(lastDisconnect) {
  if (lastDisconnect == null) return null;
  if (typeof lastDisconnect !== "object") {
    return { raw_type: typeof lastDisconnect, raw_value: String(lastDisconnect) };
  }
  const ld = /** @type {Record<string, unknown>} */ (lastDisconnect);
  return {
    date: ld.date ?? null,
    error: serializeError(ld.error),
    raw_keys: Object.keys(ld),
  };
}

/**
 * Best-effort JSON-safe clone of Baileys lastDisconnect (including Error subtree).
 *
 * @param {unknown} lastDisconnect
 * @returns {unknown}
 */
export function cloneLastDisconnectRaw(lastDisconnect) {
  if (lastDisconnect == null) return null;
  try {
    return JSON.parse(
      JSON.stringify(lastDisconnect, (_key, value) => {
        if (value instanceof Error) {
          return serializeError(value);
        }
        return value;
      }),
    );
  } catch (err) {
    return {
      clone_failed: err instanceof Error ? err.message : String(err),
      typeof_value: typeof lastDisconnect,
      keys:
        typeof lastDisconnect === "object" && lastDisconnect !== null
          ? Object.keys(lastDisconnect)
          : [],
    };
  }
}

/**
 * @param {import('@whiskeysockets/baileys').WASocket|null|undefined} sock
 * @returns {number|null}
 */
export function readWsCloseCode(sock) {
  if (!sock) return null;
  const ws = sock.ws;
  if (!ws || typeof ws !== "object") return null;
  const w = /** @type {Record<string, unknown>} */ (ws);
  const candidates = [
    w.closeCode,
    w._closeCode,
    w.socket && typeof w.socket === "object"
      ? /** @type {Record<string, unknown>} */ (w.socket).closeCode
      : null,
    w.socket && typeof w.socket === "object"
      ? /** @type {Record<string, unknown>} */ (w.socket)._closeCode
      : null,
  ];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
  }
  return null;
}

/**
 * @param {string} authDir
 * @returns {{ auth_directory_existed: boolean, creds_json_existed: boolean }}
 */
export function authSnapshotBeforeClose(authDir) {
  const auth_directory_existed = fs.existsSync(authDir);
  let creds_json_existed = false;
  if (auth_directory_existed) {
    try {
      creds_json_existed = fs.existsSync(path.join(authDir, "creds.json"));
    } catch {
      creds_json_existed = false;
    }
  }
  return { auth_directory_existed, creds_json_existed };
}

/**
 * Record Baileys connection.close diagnostics (no session behavior changes).
 *
 * @param {number} clinicId
 * @param {object} params
 * @param {import('@whiskeysockets/baileys').WASocket|null} params.sock
 * @param {string} params.authDir
 * @param {Record<string, unknown>} params.diagState
 * @param {unknown} params.lastDisconnect
 */
export function buildCloseDiagnostics({ sock, authDir, diagState, lastDisconnect }) {
  const closedAt = iso();
  const closedAtMs = Date.now();
  const err = lastDisconnect?.error;
  const statusCode = err?.output?.statusCode ?? null;
  const authSnap = authSnapshotBeforeClose(authDir);
  const firstQrAt = diagState.qr_generated_at
    ? Date.parse(String(diagState.qr_generated_at))
    : NaN;
  const socketCreatedAt = diagState.socket_created_at
    ? Date.parse(String(diagState.socket_created_at))
    : NaN;
  const qrToCloseMs =
    Number.isFinite(firstQrAt) && Number.isFinite(closedAtMs)
      ? closedAtMs - firstQrAt
      : null;

  const serializedError = serializeError(err);
  const serializedLd = serializeLastDisconnect(lastDisconnect);
  const rawLastDisconnect = cloneLastDisconnectRaw(lastDisconnect);

  return {
    last_disconnect_object_raw: rawLastDisconnect,
    last_disconnect_raw: serializedLd,
    last_disconnect_error: serializedError,
    last_disconnect_error_message:
      typeof err?.message === "string" ? err.message : null,
    last_disconnect_error_stack:
      typeof err?.stack === "string" ? err.stack : null,
    last_disconnect_error_output: serializedError?.output ?? null,
    last_disconnect_error_output_status_code: statusCode,
    error_is_boom: boomIsBoom(err),
    disconnect_reason_name: resolveDisconnectReasonName(statusCode),
    ws_close_code: readWsCloseCode(sock),
    creds_json_existed_before_close: authSnap.creds_json_existed,
    auth_directory_existed_before_close: authSnap.auth_directory_existed,
    qr_had_been_generated_before_close: Boolean(diagState.qr_generated),
    connection_ever_reached_open: Boolean(diagState.connection_ever_open),
    socket_created_at: diagState.socket_created_at ?? null,
    first_qr_at: diagState.qr_generated_at ?? null,
    connection_close_at: closedAt,
    elapsed_ms_qr_generated_to_close: qrToCloseMs,
    connection_reached_open_at: diagState.connection_reached_open_at ?? null,
  };
}
