import express from "express";
import {
  disconnectSession,
  GATEWAY_BUILD_ID,
  getSessionStatus,
  reconnectSession,
  resetSession,
  restoreAllSessions,
  sendMessage,
  startSession,
} from "./session-manager.js";
import pino from "pino";

const bootLogger = pino({ level: process.env.LOG_LEVEL || "info" });
bootLogger.info(
  {
    build_id: GATEWAY_BUILD_ID,
    auto_restore: process.env.WHATSAPP_AUTO_RESTORE ?? "0",
    sessions_dir: process.env.SESSIONS_DIR || "./sessions",
  },
  "whatsapp.gateway.build",
);

const app = express();
const PORT = Number(process.env.PORT || 3100);
const TOKEN = process.env.GATEWAY_TOKEN || "";

app.use(express.json({ limit: "25mb" }));

app.use((req, res, next) => {
  console.log({
    expected: process.env.GATEWAY_TOKEN,
    received: req.headers["x-gateway-token"],
  });
  if (!TOKEN) {
    return next();
  }
  const header = req.headers["x-gateway-token"];
  if (header !== TOKEN) {
    return res.status(403).json({ success: false, message: "Invalid gateway token." });
  }
  next();
});

app.get("/health", (_req, res) => {
  res.json({
    success: true,
    service: "ekshfli-whatsapp-gateway",
    build_id: GATEWAY_BUILD_ID,
    expected_log_events: [
      "whatsapp.gateway.build",
      "whatsapp.connect.start",
      "whatsapp.qr.generated",
      "whatsapp.qr.delivered",
      "whatsapp.qr.scanned",
      "whatsapp.auth.loaded",
      "whatsapp.auth.saved",
      "whatsapp.session.close",
      "whatsapp.session.restart_required",
      "whatsapp.session.open",
    ],
  });
});

app.post("/internal/sessions/:clinicId/start", async (req, res) => {
  const clinicId = Number(req.params.clinicId);
  const method = req.body?.method === "pairing" ? "pairing" : "qr";
  const phone = req.body?.phone || null;
  try {
    const data = await startSession(clinicId, method, phone);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err?.message || "Start failed" });
  }
});

app.get("/internal/sessions/:clinicId/status", async (req, res) => {
  const clinicId = Number(req.params.clinicId);
  try {
    const data = await getSessionStatus(clinicId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err?.message || "Status failed" });
  }
});

app.post("/internal/sessions/:clinicId/reconnect", async (req, res) => {
  const clinicId = Number(req.params.clinicId);
  try {
    const data = await reconnectSession(clinicId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err?.message || "Reconnect failed" });
  }
});

app.post("/internal/sessions/:clinicId/disconnect", async (req, res) => {
  const clinicId = Number(req.params.clinicId);
  try {
    const data = await disconnectSession(clinicId);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, message: err?.message || "Disconnect failed" });
  }
});

app.post("/internal/sessions/:clinicId/reset", async (req, res) => {
  const clinicId = Number(req.params.clinicId);
  try {
    const result = await resetSession(clinicId);
    res.status(result.success ? 200 : 422).json(result);
  } catch (err) {
    res.status(500).json({ success: false, message: err?.message || "Reset failed" });
  }
});

app.post("/internal/messages/send", async (req, res) => {
  const result = await sendMessage(req.body || {});
  res.status(result.success ? 200 : 422).json(result);
});

app.listen(PORT, async () => {
  console.log(`Ekshfli WhatsApp Gateway listening on :${PORT}`);
  await restoreAllSessions();
});
