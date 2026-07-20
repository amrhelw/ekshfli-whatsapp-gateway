import express from "express";
import pino from "pino";
import { logVoiceTrace } from "./voice-trace.js";
import { getInboundWebhookConfig } from "./inbound.js";
import {
  getLifecycleSnapshot,
  lifecycleAbort,
  lifecycleEnter,
  lifecycleException,
  lifecycleExit,
  recordHttpAuth,
} from "./lifecycle-trace.js";
import {
  disconnectSession,
  getRestoreSummary,
  getSessionDiagnostics,
  getSessionStatus,
  reconnectSession,
  resetSession,
  restoreAllSessions,
  sendMessage,
  startSession,
} from "./session-manager.js";

const app = express();
const logger = pino({ level: process.env.LOG_LEVEL || "info" });
const PORT = Number(process.env.PORT || 3100);
// Trim: Railway/UI env values often include trailing whitespace/newlines → false 403s.
const TOKEN = String(process.env.GATEWAY_TOKEN || "").trim();

app.use(express.json({ limit: "25mb" }));

app.use((req, res, next) => {
  // Runtime audit: /health must stay readable without token so inbound telemetry is probeable.
  if (req.method === "GET" && (req.path === "/health" || req.url?.startsWith("/health"))) {
    return next();
  }

  const t0 = lifecycleEnter("http_auth_middleware", {
    method: req.method,
    path: req.path,
    file: "index.js",
    function: "auth middleware",
  });

  const header = String(req.headers["x-gateway-token"] || "").trim();
  const tokenConfigured = TOKEN.length > 0;
  const headerPresent = header.length > 0;

  if (!tokenConfigured) {
    recordHttpAuth({
      rejected: false,
      path: req.path,
      method: req.method,
      reason: "GATEWAY_TOKEN empty — auth skipped",
      token_configured: false,
      header_present: headerPresent,
    });
    lifecycleExit("http_auth_middleware", t0, { allowed: true, reason: "token_not_configured" });
    return next();
  }

  if (header !== TOKEN) {
    const condition = !headerPresent
      ? "missing x-gateway-token header"
      : `x-gateway-token length ${header.length} !== GATEWAY_TOKEN length ${TOKEN.length} (or value mismatch)`;
    recordHttpAuth({
      rejected: true,
      path: req.path,
      method: req.method,
      condition,
      token_configured: true,
      header_present: headerPresent,
      header_len: header.length,
      token_len: TOKEN.length,
      lengths_equal: header.length === TOKEN.length,
    });
    lifecycleAbort("http_auth_middleware", condition, {
      file: "index.js",
      function: "auth middleware",
      line: 52,
      path: req.path,
      method: req.method,
      http_status: 403,
    });
    lifecycleExit("http_auth_middleware", t0, {
      allowed: false,
      returned: { success: false, message: "Invalid gateway token." },
    });
    return res.status(403).json({ success: false, message: "Invalid gateway token." });
  }

  recordHttpAuth({
    rejected: false,
    path: req.path,
    method: req.method,
    token_configured: true,
    header_present: true,
    header_len: header.length,
    token_len: TOKEN.length,
  });
  lifecycleExit("http_auth_middleware", t0, { allowed: true });
  next();
});

app.get("/health", (_req, res) => {
  const inbound = getInboundWebhookConfig();
  res.json({
    success: true,
    service: "ekshfli-whatsapp-gateway",
    inbound,
    restore: getRestoreSummary(),
    lifecycle: getLifecycleSnapshot(),
  });
});

app.post("/internal/sessions/:clinicId/start", async (req, res) => {
  const clinicId = Number(req.params.clinicId);
  const method = req.body?.method === "pairing" ? "pairing" : "qr";
  const phone = req.body?.phone || null;
  const forceFresh =
    req.body?.force_fresh === true ||
    req.body?.force_fresh === 1 ||
    req.body?.force_fresh === "1" ||
    req.body?.force_fresh === "true";
  const t0 = lifecycleEnter("HTTP_startConnection", {
    clinic_id: clinicId,
    method,
    force_fresh: forceFresh,
    file: "index.js",
    function: "POST /internal/sessions/:clinicId/start",
  });
  try {
    const data = await startSession(
      clinicId,
      method,
      phone,
      false,
      `HTTP:POST /internal/sessions/${clinicId}/start`,
      { force_fresh: forceFresh },
    );
    lifecycleExit("HTTP_startConnection", t0, {
      returned_status: data?.status ?? null,
      returned_qr: Boolean(data?.qr),
      returned_has_jid: Boolean(data?.wa_jid),
    });
    res.json({ success: true, data });
  } catch (err) {
    lifecycleException("HTTP_startConnection", t0, err, {
      clinic_id: clinicId,
      file: "index.js",
    });
    res.status(500).json({ success: false, message: err?.message || "Start failed" });
  }
});


app.get("/internal/sessions/:clinicId/status", (req, res) => {
  const clinicId = Number(req.params.clinicId);
  res.json({ success: true, data: getSessionStatus(clinicId) });
});

app.get("/internal/sessions/:clinicId/diagnostics", (req, res) => {
  const clinicId = Number(req.params.clinicId);
  res.json({ success: true, data: getSessionDiagnostics(clinicId) });
});

app.post("/internal/sessions/:clinicId/reconnect", async (req, res) => {
  const clinicId = Number(req.params.clinicId);
  try {
    const data = await reconnectSession(
      clinicId,
      `HTTP:POST /internal/sessions/${clinicId}/reconnect`,
    );
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err?.message || "Reconnect failed" });
  }
});

app.post("/internal/sessions/:clinicId/disconnect", async (req, res) => {
  const clinicId = Number(req.params.clinicId);
  try {
    const data = await disconnectSession(
      clinicId,
      `HTTP:POST /internal/sessions/${clinicId}/disconnect`,
    );
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err?.message || "Disconnect failed" });
  }
});

app.post("/internal/sessions/:clinicId/reset", async (req, res) => {
  const clinicId = Number(req.params.clinicId);
  try {
    const result = await resetSession(
      clinicId,
      `HTTP:POST /internal/sessions/${clinicId}/reset`,
    );
    res.status(result.success ? 200 : 422).json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err?.message || "Reset failed" });
  }
});

app.post("/internal/messages/send", async (req, res) => {
  const body = req.body || {};
  if ((body.type || "") === "audio") {
    logVoiceTrace(logger, "whatsapp.voice.trace.start", body, {
      stage: "http_receive",
      has_media_url: Boolean(body.media_url),
      has_media_path: Boolean(body.media_path),
      file_size: null,
      ptt: body.ptt ?? null,
    });
  }
  const result = await sendMessage(body);
  res.status(result.success ? 200 : 422).json(result);
});

app.listen(PORT, async () => {
  console.log(`Ekshfli WhatsApp Gateway listening on :${PORT}`);
  const inbound = getInboundWebhookConfig();
  console.log("[INBOUND] Boot webhook config", JSON.stringify(inbound));
  if (!inbound.webhook_url_configured) {
    console.error(
      "[INBOUND] FIRST FAILING LINE: postToLaravel — LARAVEL_WEBHOOK_URL is empty (inbound.js). Laravel will never receive inbound messages.",
    );
  }
  await restoreAllSessions();
});
