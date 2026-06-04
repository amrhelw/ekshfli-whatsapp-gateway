import fs from "fs";
import path from "path";

/** @type {Map<number, Record<string, unknown>>} */
const diagnosticsByClinic = new Map();

function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

export function diagFor(clinicId) {
  let d = diagnosticsByClinic.get(clinicId);
  if (!d) {
    d = {
      clinic_id: clinicId,
      session_id: String(clinicId),
      created_at: iso(),
      last_updated_at: iso(),
      start_called_at: null,
      status_changed_at: iso(),
      qr_generated_at: null,
      qr_delivered_laravel_at: null,
      connection_update_count: 0,
      socket_created: false,
      connection_update_received: false,
      qr_generated: false,
      last_disconnect_reason: null,
      last_disconnect_status_code: null,
      restart_required_detected: false,
      logged_out_detected: false,
      pairing_in_progress: false,
      last_start_error: null,
      last_http_paths: [],
    };
    diagnosticsByClinic.set(clinicId, d);
  }
  return d;
}

export function patchDiag(clinicId, patch) {
  const d = diagFor(clinicId);
  Object.assign(d, patch, { last_updated_at: iso() });
  if (patch.status && patch.status !== d._prev_status) {
    d.status_changed_at = iso();
    d._prev_status = patch.status;
  }
}

export function clearDiagnostics(clinicId) {
  diagnosticsByClinic.delete(clinicId);
}

export function noteDiagPath(clinicId, path, meta = {}) {
  const d = diagFor(clinicId);
  const row = { path, at: iso(), ...meta };
  d.last_http_paths = [row, ...(d.last_http_paths || [])].slice(0, 10);
}

function listAuthFiles(authDir) {
  if (!fs.existsSync(authDir)) return [];
  const out = [];
  const walk = (base) => {
    for (const name of fs.readdirSync(base)) {
      const full = path.join(base, name);
      if (fs.statSync(full).isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(authDir);
  return out;
}

export function buildGatewayDiagnostics(clinicId, entry, statusPayload) {
  const d = diagFor(clinicId);
  const authDir = entry.authDir;
  const authFiles = listAuthFiles(authDir);
  const hasCreds = authFiles.some((f) => f.endsWith("creds.json"));

  return {
    gateway_reachable: true,
    session: {
      current_status: entry.status,
      session_id: String(clinicId),
      has_socket: Boolean(entry.sock),
      has_auth_files: authFiles.length > 0,
      has_creds_json: hasCreds,
      auth_directory: authDir,
      auth_file_count: authFiles.length,
      last_status_change_at: d.status_changed_at,
      last_error: entry.lastError,
    },
    qr: {
      qr_generated: Boolean(d.qr_generated),
      qr_length: statusPayload.qr ? String(statusPayload.qr).length : 0,
      qr_generated_at: d.qr_generated_at,
      qr_in_memory: Boolean(entry.qr),
      qr_memory_length: entry.qr ? String(entry.qr).length : 0,
      qr_delivered_in_status_response: Boolean(statusPayload.qr),
      qr_prefix: statusPayload.qr ? String(statusPayload.qr).slice(0, 28) : null,
    },
    baileys: {
      socket_created: Boolean(d.socket_created),
      connection_update_received: Boolean(d.connection_update_received),
      connection_update_count: d.connection_update_count || 0,
      last_disconnect_reason: d.last_disconnect_reason,
      last_disconnect_status_code: d.last_disconnect_status_code,
      restart_required_detected: Boolean(d.restart_required_detected),
      logged_out_detected: Boolean(d.logged_out_detected),
      pairing_in_progress: entry.status === "connecting" && Boolean(entry.qr),
      start_called_at: d.start_called_at,
      last_start_error: d.last_start_error,
    },
    meta: {
      last_updated_at: d.last_updated_at,
      last_http_paths: d.last_http_paths || [],
    },
  };
}
